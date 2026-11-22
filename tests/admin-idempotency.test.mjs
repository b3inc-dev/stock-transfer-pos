/**
 * 管理画面の在庫の書き込みの @idempotent（docs/IDEMPOTENT_MIGRATION.md 4.6・6.1 の 6。2 段目）。
 * K 棚卸の確定・取り消し / L 発注から移管 / M 仕入れの確定・取り消し。
 * admin.graphql を偽物にし、Shopify と同じく「同じキーの 2 回目は書かずに前の答えを返す」ふりをする。
 * Run: node --experimental-strip-types --test tests/admin-idempotency.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    throw e;
  }
}
`)
);

const opKeyMod = await import("../app/utils/admin-op-key.ts");
const opKeyServer = await import("../app/utils/admin-op-key.server.ts");
const countSet = await import("../app/utils/admin-inventory-count-set.server.ts");
const purchase = await import("../app/utils/admin-purchase-adjust.server.ts");
const order = await import("../app/utils/admin-order-transfer.server.ts");
const { withGraphQLRetry } = await import("../app/utils/graphql-with-retry.ts");
const { isUuidV5 } = await import("../extensions/common/idempotencyKey.js");

const {
  adminOpKeyStateFor,
  applyAdminOpKeyResult,
  appendAdminOpKey,
  initialAdminOpKeyState,
  isAdminOpKey,
  newAdminOpKey,
  nextAdminOpKeyState,
  readAdminOpKeyResult,
  ADMIN_OP_ROUND_MAX,
} = opKeyMod;
const {
  ADMIN_IDEMPOTENCY_KIND,
  adminIdempotencyKey,
  buildAdminIdempotency,
  buildAdminRound,
  classifyAdminWrite,
  metafieldsSetError,
  readAdminOpKey,
  readRevertRound,
} = opKeyServer;

const SHOP = "bbbincbbb.myshopify.com";
const LOC = "gid://shopify/Location/1";
const FAST = [0, 0, 0];
const OPKEY = "11111111-2222-4333-8444-555555555555";
const OPKEY2 = "66666666-7777-4888-9999-000000000000";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function fd(obj) {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}
const countIdem = (op, parts, revertRound = 0) =>
  buildAdminIdempotency({
    shop: SHOP,
    kind: ADMIN_IDEMPOTENCY_KIND.inventoryCount,
    op,
    parts,
    revertRound,
    concurrentRetryDelaysMs: FAST,
  });

/**
 * Shopify のふり。
 * - 同じキーの 2 回目: 前が成功していれば書かずに前の答えを返す（24 時間の中の動き）
 * - reply(callNo, query, variables) が応答を返せばそれを返す（在庫は動かない・覚えない）
 */
function fakeShopify({ reply = () => null } = {}) {
  const stock = new Map();
  const remembered = new Map();
  const calls = [];
  let transferSeq = 0;
  const admin = {
    async graphql(query, opts) {
      const v = opts?.variables ?? {};
      const callNo = calls.length;
      calls.push({ query, key: v.idempotencyKey, variables: v });
      const r = reply(callNo, query, v);
      if (r instanceof Error) throw r;
      const dropAnswer = r === "drop"; // Shopify では書けたが、答えが届かない
      if (r && !dropAnswer) return r;
      if (v.idempotencyKey && remembered.has(v.idempotencyKey)) return json(remembered.get(v.idempotencyKey));
      let body;
      if (query.includes("inventorySetQuantities(")) {
        for (const q of v.input.quantities) stock.set(q.inventoryItemId, q.quantity);
        body = { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: `g${callNo}` }, userErrors: [] } } };
      } else if (query.includes("inventoryAdjustQuantities(")) {
        for (const c of v.input.changes) stock.set(c.inventoryItemId, (stock.get(c.inventoryItemId) ?? 0) + c.delta);
        body = { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: `g${callNo}` }, userErrors: [] } } };
      } else if (query.includes("inventoryTransferCreateAsReadyToShip(")) {
        transferSeq++;
        body = {
          data: {
            inventoryTransferCreateAsReadyToShip: {
              inventoryTransfer: { id: `gid://shopify/InventoryTransfer/${transferSeq}`, status: "READY_TO_SHIP" },
              userErrors: [],
            },
          },
        };
      } else if (query.includes("inventoryTransferCreate(")) {
        transferSeq++;
        body = {
          data: {
            inventoryTransferCreate: { inventoryTransfer: { id: `gid://shopify/InventoryTransfer/${transferSeq}`, status: "DRAFT" }, userErrors: [] },
          },
        };
      } else if (query.includes("inventoryTransferMarkAsReadyToShip(")) {
        body = { data: { inventoryTransferMarkAsReadyToShip: { inventoryTransfer: { id: v.id, status: "READY_TO_SHIP" }, userErrors: [] } } };
      } else {
        throw new Error("想定していない呼び出し: " + query.slice(0, 80));
      }
      if (v.idempotencyKey) remembered.set(v.idempotencyKey, body);
      if (dropAnswer) throw new Error("timeout（答えが届かなかった）");
      return json(body);
    },
  };
  return { admin, stock, calls, transfers: () => transferSeq };
}
const userError = (field, code, message = code) => json({ data: { [field]: { userErrors: [{ field: null, message, code }] } } });

const items = (n, qty = 5) =>
  Array.from({ length: n }, (_, i) => ({ inventoryItemId: `gid://shopify/InventoryItem/${i + 1}`, quantity: qty }));

// ---------------------------------------------------------------------------

describe("画面の opKey・opRound（admin-op-key.ts）", () => {
  it("新しい opKey は UUID・毎回違う", () => {
    const a = newAdminOpKey();
    const b = newAdminOpKey();
    assert.ok(isAdminOpKey(a) && isAdminOpKey(b));
    assert.notEqual(a, b);
  });
  it("成功（done）で opKey を作り直して回を 0 に。断られた（rejected）で回だけ +1。分からない（uncertain）・答えなしは変えない", () => {
    const s0 = { opKey: OPKEY, opRound: 0 };
    const rej = nextAdminOpKeyState(s0, "rejected");
    assert.deepEqual(rej, { opKey: OPKEY, opRound: 1 });
    assert.deepEqual(nextAdminOpKeyState(rej, "uncertain"), rej);
    assert.deepEqual(nextAdminOpKeyState(rej, null), rej);
    const done = nextAdminOpKeyState(rej, "done");
    assert.notEqual(done.opKey, OPKEY);
    assert.equal(done.opRound, 0);
    assert.equal(nextAdminOpKeyState({ opKey: OPKEY, opRound: ADMIN_OP_ROUND_MAX }, "rejected").opRound, ADMIN_OP_ROUND_MAX);
  });
  it("FormData に入れて、サーバーで読める", () => {
    const f = appendAdminOpKey(new FormData(), { opKey: OPKEY, opRound: 2 });
    assert.deepEqual(readAdminOpKey(f), { opKey: OPKEY, opRound: 2 });
  });
  it("答えの opKeyResult を読む（無い・おかしい値は null）", () => {
    assert.equal(readAdminOpKeyResult({ ok: true, opKeyResult: "done" }), "done");
    assert.equal(readAdminOpKeyResult({ error: "x", opKeyResult: "rejected" }), "rejected");
    assert.equal(readAdminOpKeyResult({ ok: true }), null);
    assert.equal(readAdminOpKeyResult({ opKeyResult: "other" }), null);
    assert.equal(readAdminOpKeyResult(null), null);
  });
  it("初めの状態は回 0", () => {
    assert.equal(initialAdminOpKeyState().opRound, 0);
  });
  it("opKey は対象ごと: 仕入れ X が分からないまま Y が成功しても、X の opKey は変わらない（X の押し直しは同じキー）", () => {
    const states = new Map();
    const x = adminOpKeyStateFor(states, "purchase_X");
    const y = adminOpKeyStateFor(states, "purchase_Y");
    assert.notEqual(x.opKey, y.opKey);
    assert.equal(applyAdminOpKeyResult(states, { error: "x", opKeyResult: "uncertain", opKey: x.opKey }), "purchase_X");
    assert.equal(applyAdminOpKeyResult(states, { ok: true, opKeyResult: "done", opKey: y.opKey }), "purchase_Y");
    assert.deepEqual(states.get("purchase_X"), x);
    assert.notEqual(states.get("purchase_Y").opKey, y.opKey);
    // X がはっきり断られたら X の回だけ +1
    applyAdminOpKeyResult(states, { error: "x", opKeyResult: "rejected", opKey: x.opKey });
    assert.deepEqual(states.get("purchase_X"), { opKey: x.opKey, opRound: 1 });
  });
  it("opKey の無い答え・どの対象のものでもない答えは何も変えない", () => {
    const states = new Map();
    const x = adminOpKeyStateFor(states, "X");
    assert.equal(applyAdminOpKeyResult(states, { ok: true, opKeyResult: "done" }), null);
    assert.equal(applyAdminOpKeyResult(states, { ok: true, opKeyResult: "done", opKey: OPKEY2 }), null);
    assert.equal(applyAdminOpKeyResult(states, { ok: true, opKey: x.opKey }), null);
    assert.deepEqual(states.get("X"), x);
  });
});

describe("サーバーのキーの材料（admin-op-key.server.ts）", () => {
  it("opKey が無い・形が違うときは null（古い画面）。回は 0 以上の整数だけ", () => {
    assert.deepEqual(readAdminOpKey(fd({})), { opKey: null, opRound: 0 });
    assert.deepEqual(readAdminOpKey(fd({ opKey: "abc", opRound: "-3" })), { opKey: null, opRound: 0 });
    assert.deepEqual(readAdminOpKey(fd({ opKey: OPKEY.toUpperCase(), opRound: "1.5" })), { opKey: OPKEY, opRound: 0 });
    assert.equal(readAdminOpKey(fd({ opKey: OPKEY, opRound: "100000" })).opRound, ADMIN_OP_ROUND_MAX);
  });
  it("回の書き方: main・rv1・main.rej1・rv2.rej3", () => {
    assert.equal(buildAdminRound(0, 0), "main");
    assert.equal(buildAdminRound(1, 0), "rv1");
    assert.equal(buildAdminRound(0, 1), "main.rej1");
    assert.equal(buildAdminRound(2, 3), "rv2.rej3");
    assert.equal(readRevertRound(undefined), 0);
    assert.equal(readRevertRound("x"), 0);
    assert.equal(readRevertRound(4), 4);
  });
  it("同じ opKey・同じ対象・同じ回 → 同じキー。どれかが違えば違うキー", () => {
    const op = { opKey: OPKEY, opRound: 0 };
    const k = (o, parts, rv = 0, stage = "set", chunk = "1/1") => adminIdempotencyKey(countIdem(o, parts, rv), stage, chunk);
    const base = k(op, ["c1", "confirm", "g1"]);
    assert.ok(isUuidV5(base));
    assert.equal(k(op, ["c1", "confirm", "g1"]), base);
    const others = [
      k({ opKey: OPKEY2, opRound: 0 }, ["c1", "confirm", "g1"]),
      k({ opKey: OPKEY, opRound: 1 }, ["c1", "confirm", "g1"]),
      k(op, ["c1", "confirm", "g1"], 1),
      k(op, ["c1", "revert", "g1"]),
      k(op, ["c1", "confirm", "g2"]),
      k(op, ["c2", "confirm", "g1"]),
      k(op, ["c1", "confirm", "g1"], 0, "set", "1/2"),
    ];
    for (const o of others) assert.notEqual(o, base);
    assert.equal(new Set(others).size, others.length);
  });
  it("opKey が無い（古い画面）→ 呼ぶたびに違うキー（今までと同じ動き）", () => {
    const a = countIdem({ opKey: null, opRound: 0 }, ["c1", "confirm", "g1"]);
    const b = countIdem({ opKey: null, opRound: 0 }, ["c1", "confirm", "g1"]);
    assert.ok(a.adhoc && b.adhoc);
    assert.notEqual(adminIdempotencyKey(a, "set"), adminIdempotencyKey(b, "set"));
  });
  it("対象の ID に区切りの文字（| や :）があっても止まらず、混ざらない", () => {
    const op = { opKey: OPKEY, opRound: 0 };
    const a = adminIdempotencyKey(countIdem(op, ["a|b", "confirm", "c"]), "set");
    const b = adminIdempotencyKey(countIdem(op, ["a", "b|confirm", "c"]), "set");
    const c = adminIdempotencyKey(countIdem(op, ["a:b", "confirm", "c"]), "set");
    const d = adminIdempotencyKey(countIdem(op, ["a", "b:confirm", "c"]), "set");
    assert.equal(new Set([a, b, c, d]).size, 4);
  });
  it("記録の保存（metafieldsSet）: userErrors・トップの errors・例外・答えなしは失敗の文、成功は null", async () => {
    assert.equal(await metafieldsSetError(async () => json({ data: { metafieldsSet: { metafields: [], userErrors: [] } } })), null);
    assert.match(await metafieldsSetError(async () => json({ data: { metafieldsSet: { userErrors: [{ message: "too big" }] } } })), /too big/);
    assert.match(await metafieldsSetError(async () => json({ errors: [{ message: "Throttled" }] })), /Throttled/);
    assert.match(await metafieldsSetError(async () => { throw new Error("socket"); }), /socket/);
    assert.ok(await metafieldsSetError(async () => json({ data: {} })));
  });
  it("答えの分け方: 処理中・中身の違い・トップの errors は uncertain、ほかの userErrors は rejected", () => {
    assert.deepEqual(classifyAdminWrite([], []), { outcome: "ok" });
    assert.equal(classifyAdminWrite([{ message: "bad", code: "INVALID" }], []).outcome, "rejected");
    const mm = classifyAdminWrite([{ message: "x", code: "IDEMPOTENCY_KEY_PARAMETER_MISMATCH" }], []);
    assert.equal(mm.outcome, "uncertain");
    assert.equal(mm.idempotencyIssue, "mismatch");
    assert.equal(classifyAdminWrite([{ message: "x", code: "IDEMPOTENCY_CONCURRENT_REQUEST" }], []).idempotencyIssue, "concurrent");
    assert.equal(classifyAdminWrite([], [], true).idempotencyIssue, "concurrent");
    const top = classifyAdminWrite(null, [{ message: "Internal error" }]);
    assert.equal(top.outcome, "uncertain");
    assert.equal(top.idempotencyIssue, null);
  });
});

describe("K 棚卸の確定・取り消し（admin-inventory-count-set.server.ts）", () => {
  const op = { opKey: OPKEY, opRound: 0 };

  it("送る文に @idempotent と $idempotencyKey、changeFromQuantity は null", async () => {
    const s = fakeShopify();
    const r = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(2), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    assert.equal(r.ok, true);
    assert.equal(r.opKeyResult, "done");
    assert.match(s.calls[0].query, /inventorySetQuantities\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/);
    assert.match(s.calls[0].query, /\$idempotencyKey: String!/);
    assert.ok(s.calls[0].variables.input.quantities.every((q) => q.changeFromQuantity === null));
    assert.equal(s.calls[0].key, adminIdempotencyKey(countIdem(op, ["c1", "confirm", "g1"]), "set", "1/1"));
  });

  it("300 件 → 2 チャンクで違うキー。同じ操作の押し直しは同じ 2 つのキー（Shopify は 2 回目を書かない）", async () => {
    const s = fakeShopify();
    const idem = countIdem(op, ["c1", "confirm", "g1"]);
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(300), "c1", idem);
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(300), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    const keys = s.calls.map((c) => c.key);
    assert.equal(keys.length, 4);
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual(keys.slice(2), keys.slice(0, 2));
    assert.equal(keys[1], adminIdempotencyKey(idem, "set", "2/2"));
  });

  it("503 の送り直し（withGraphQLRetry）は同じキー", async () => {
    const s = fakeShopify({ reply: (n) => (n === 0 ? json({ errors: [{ message: "busy" }] }, 503) : null) });
    const admin = withGraphQLRetry(s.admin, { initialDelayMs: 0 });
    const r = await countSet.adjustInventoryQuantitiesServer(admin, LOC, items(1), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    assert.equal(r.ok, true);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].key, s.calls[1].key);
  });

  it("IDEMPOTENCY_CONCURRENT_REQUEST → 待って同じキーで送り直して成功", async () => {
    const s = fakeShopify({
      reply: (n) => (n === 0 ? userError("inventorySetQuantities", "IDEMPOTENCY_CONCURRENT_REQUEST") : null),
    });
    const r = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(1), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    assert.equal(r.ok, true);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].key, s.calls[1].key);
  });

  it("処理中のまま待ち切った → uncertain（opKey も回も変えない）", async () => {
    const s = fakeShopify({ reply: () => userError("inventorySetQuantities", "IDEMPOTENCY_CONCURRENT_REQUEST") });
    const r = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(1), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    assert.equal(r.ok, false);
    assert.equal(r.opKeyResult, "uncertain");
    assert.equal(r.idempotencyIssue, "concurrent");
    assert.equal(s.calls.length, 4);
    assert.equal(new Set(s.calls.map((c) => c.key)).size, 1);
  });

  it("IDEMPOTENCY_KEY_PARAMETER_MISMATCH → 送り直さず uncertain。2 チャンク目なら先の 250 件は入ったと言う", async () => {
    const s = fakeShopify({
      reply: (n) => (n === 1 ? userError("inventorySetQuantities", "IDEMPOTENCY_KEY_PARAMETER_MISMATCH") : null),
    });
    const r = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(300), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    assert.equal(r.ok, false);
    assert.equal(r.opKeyResult, "uncertain");
    assert.equal(r.idempotencyIssue, "mismatch");
    assert.equal(r.appliedCount, 250);
    assert.equal(s.calls.length, 2);
  });

  it("はっきり断られた（userErrors）→ rejected。画面が回を増やすと次は新しいキー", async () => {
    const s = fakeShopify({
      reply: (n) => (n === 0 ? userError("inventorySetQuantities", "INVALID_INVENTORY_ITEM", "bad item") : null),
    });
    const r1 = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(1), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    assert.equal(r1.opKeyResult, "rejected");
    const next = nextAdminOpKeyState(op, r1.opKeyResult);
    const r2 = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(1), "c1", countIdem(next, ["c1", "confirm", "g1"]));
    assert.equal(r2.ok, true);
    assert.notEqual(s.calls[0].key, s.calls[1].key);
  });

  it("通信の失敗（例外）→ uncertain。同じ opKey の押し直しは同じキー → 1 回だけ書かれる", async () => {
    let wrote = 0;
    const s = fakeShopify({
      reply: (n) => {
        if (n === 0) {
          wrote++;
          return new Error("socket hang up");
        }
        return null;
      },
    });
    const r1 = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(1), "c1", countIdem(op, ["c1", "confirm", "g1"]));
    assert.equal(r1.opKeyResult, "uncertain");
    const next = nextAdminOpKeyState(op, r1.opKeyResult);
    assert.deepEqual(next, op);
    const r2 = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, items(1), "c1", countIdem(next, ["c1", "confirm", "g1"]));
    assert.equal(r2.ok, true);
    assert.equal(s.calls[0].key, s.calls[1].key);
    assert.equal(wrote, 1);
  });

  it("確定 → 取り消し → 確定（同じ opKey のまま）: 戻した回数で新しいキーになり、3 回目もちゃんと書く", async () => {
    const s = fakeShopify();
    const item = [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 10 }];
    const back = [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 3 }];
    let rv = 0;
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, item, "c1", countIdem(op, ["c1", "confirm", "g1"], rv));
    assert.equal(s.stock.get("gid://shopify/InventoryItem/1"), 10);
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, back, null, countIdem(op, ["c1", "revert", "g1"], rv));
    rv += 1; // reset_stocktake_group が idempotencyRevertRound を 1 つ増やす
    assert.equal(s.stock.get("gid://shopify/InventoryItem/1"), 3);
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, item, "c1", countIdem(op, ["c1", "confirm", "g1"], rv));
    assert.equal(s.stock.get("gid://shopify/InventoryItem/1"), 10, "3 回目の確定が書かれていない");
    assert.equal(new Set(s.calls.map((c) => c.key)).size, 3);
    // もう一度取り消すときも、前の取り消しと違うキー
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, back, null, countIdem(op, ["c1", "revert", "g1"], rv));
    assert.equal(s.stock.get("gid://shopify/InventoryItem/1"), 3);
  });

  it("（確かめ）戻した回数を増やさないと、3 回目の確定は前の答えだけ返って書かれない", async () => {
    const s = fakeShopify();
    const item = [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 10 }];
    const back = [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 3 }];
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, item, "c1", countIdem(op, ["c1", "confirm", "g1"], 0));
    await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, back, null, countIdem(op, ["c1", "revert", "g1"], 0));
    const r = await countSet.adjustInventoryQuantitiesServer(s.admin, LOC, item, "c1", countIdem(op, ["c1", "confirm", "g1"], 0));
    assert.equal(r.ok, true);
    assert.equal(s.stock.get("gid://shopify/InventoryItem/1"), 3);
  });

  it("有効な商品が無い → Shopify に送らず rejected", async () => {
    const s = fakeShopify();
    const r = await countSet.adjustInventoryQuantitiesServer(
      s.admin,
      LOC,
      [{ inventoryItemId: "abc", quantity: 1 }],
      "c1",
      countIdem(op, ["c1", "confirm", "g1"])
    );
    assert.equal(r.ok, false);
    assert.equal(r.opKeyResult, "rejected");
    assert.equal(s.calls.length, 0);
  });
});

describe("M 仕入れの確定・取り消し（admin-purchase-adjust.server.ts）", () => {
  const op = { opKey: OPKEY, opRound: 0 };
  const idem = (parts, o = op) =>
    buildAdminIdempotency({ shop: SHOP, kind: ADMIN_IDEMPOTENCY_KIND.purchase, op: o, parts, concurrentRetryDelaysMs: FAST });
  const norm = (id) => (/^\d+$/.test(id) ? `gid://shopify/InventoryItem/${id}` : id);
  const purchaseItems = [
    { inventoryItemId: "1", quantity: 2 },
    { inventoryItemId: "2", quantity: 0 },
    { inventoryItemId: "", quantity: 4 },
  ];

  it("changes に changeFromQuantity: null をはっきり書く。数が 0・ID が無い行は送らない", () => {
    assert.deepEqual(purchase.buildPurchaseAdjustChanges(purchaseItems, LOC, norm, 1), [
      { inventoryItemId: "gid://shopify/InventoryItem/1", locationId: LOC, delta: 2, changeFromQuantity: null },
    ]);
    assert.equal(purchase.buildPurchaseAdjustChanges(purchaseItems, LOC, norm, -1)[0].delta, -2);
  });

  it("送る文に @idempotent。応答なしのあとの押し直し（同じ opKey）は同じキー → 二重に足さない", async () => {
    const s = fakeShopify({ reply: (n) => (n === 0 ? "drop" : null) });
    const changes = purchase.buildPurchaseAdjustChanges(purchaseItems, LOC, norm, 1);
    const r1 = await purchase.sendPurchaseAdjustQuantities(s.admin, changes, idem(["p1", "receive"]), "t");
    assert.equal(r1.opKeyResult, "uncertain");
    assert.match(s.calls[0].query, /inventoryAdjustQuantities\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/);
    assert.ok(s.calls[0].variables.input.changes.every((c) => c.changeFromQuantity === null));
    assert.equal(s.stock.get("gid://shopify/InventoryItem/1"), 2);
    const next = nextAdminOpKeyState(op, r1.opKeyResult);
    const r2 = await purchase.sendPurchaseAdjustQuantities(s.admin, changes, idem(["p1", "receive"], next), "t");
    assert.equal(r2.ok, true);
    assert.equal(s.calls[1].key, s.calls[0].key, "押し直しのキーが 1 回目と同じでない");
    assert.equal(s.stock.get("gid://shopify/InventoryItem/1"), 2, "二重に足された");
  });

  it("確定と取り消しは違うキー。仕入れが違えば違うキー", () => {
    const a = adminIdempotencyKey(idem(["p1", "receive"]), "adjust");
    const b = adminIdempotencyKey(idem(["p1", "cancel"]), "adjust");
    const c = adminIdempotencyKey(idem(["p2", "receive"]), "adjust");
    assert.equal(new Set([a, b, c]).size, 3);
  });

  it("成功 → done（adjustmentGroupId を返す）。userErrors → rejected。中身の違い → uncertain", async () => {
    const changes = purchase.buildPurchaseAdjustChanges(purchaseItems, LOC, norm, 1);
    const ok = await purchase.sendPurchaseAdjustQuantities(fakeShopify().admin, changes, idem(["p1", "receive"]), "t");
    assert.equal(ok.ok, true);
    assert.equal(ok.opKeyResult, "done");
    assert.ok(ok.adjustmentGroupId);
    const rej = await purchase.sendPurchaseAdjustQuantities(
      fakeShopify({ reply: () => userError("inventoryAdjustQuantities", "INVALID_LOCATION", "bad") }).admin,
      changes,
      idem(["p1", "receive"]),
      "t"
    );
    assert.equal(rej.opKeyResult, "rejected");
    const mm = fakeShopify({ reply: () => userError("inventoryAdjustQuantities", "IDEMPOTENCY_KEY_PARAMETER_MISMATCH") });
    const unc = await purchase.sendPurchaseAdjustQuantities(mm.admin, changes, idem(["p1", "receive"]), "t");
    assert.equal(unc.opKeyResult, "uncertain");
    assert.equal(unc.idempotencyIssue, "mismatch");
    assert.equal(mm.calls.length, 1);
  });
});

describe("L 発注から移管（admin-order-transfer.server.ts）", () => {
  const op = { opKey: OPKEY, opRound: 0 };
  const idem = (rv = 0, o = op) =>
    buildAdminIdempotency({
      shop: SHOP,
      kind: ADMIN_IDEMPOTENCY_KIND.orderTransfer,
      op: o,
      parts: ["o1", "approve"],
      revertRound: rv,
      concurrentRetryDelaysMs: FAST,
    });
  const input = { destinationLocationId: LOC, lineItems: [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 1 }] };

  it("READY の mutation に @idempotent。同じ opKey の押し直しは同じ Transfer（二重に作らない）", async () => {
    const s = fakeShopify();
    const r1 = await order.createOrderTransferIdempotent(s.admin, input, idem());
    const r2 = await order.createOrderTransferIdempotent(s.admin, input, idem());
    assert.equal(r1.transferId, r2.transferId);
    assert.equal(s.transfers(), 1);
    assert.match(s.calls[0].query, /inventoryTransferCreateAsReadyToShip\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/);
    assert.equal(s.calls[0].key, adminIdempotencyKey(idem(), "transfer_ready"));
  });

  it("承認の取り消しのあとの承認（同じ opKey でも）は新しいキー → 新しい Transfer", async () => {
    const s = fakeShopify();
    const r1 = await order.createOrderTransferIdempotent(s.admin, input, idem(0));
    const r2 = await order.createOrderTransferIdempotent(s.admin, input, idem(1));
    assert.notEqual(r1.transferId, r2.transferId);
    assert.equal(s.transfers(), 2);
  });

  it("READY がこの版に無い（そのエラーのときだけ）→ 下書きの mutation（段 transfer_draft）で違うキー。どちらにも @idempotent", async () => {
    const s = fakeShopify({ reply: (n) => (n === 0 ? new Error("Field 'inventoryTransferCreateAsReadyToShip' doesn't exist") : null) });
    const r = await order.createOrderTransferIdempotent(s.admin, input, idem());
    assert.ok(r.transferId);
    assert.equal(s.calls.length, 3); // ready（失敗）・draft・mark
    assert.match(s.calls[1].query, /inventoryTransferCreate\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/);
    assert.equal(s.calls[1].key, adminIdempotencyKey(idem(), "transfer_draft"));
    assert.notEqual(s.calls[0].key, s.calls[1].key);
    assert.equal(s.calls[2].key, undefined); // MarkAsReadyToShip は 17 の一覧に無い
  });

  it("READY が通信の失敗などの例外 → 下書きの道へ進まず uncertain: true（Transfer を 2 つ作らない）", async () => {
    const s = fakeShopify({ reply: (n) => (n === 0 ? new Error("socket hang up") : null) });
    const r = await order.createOrderTransferIdempotent(s.admin, input, idem());
    assert.equal(r.uncertain, true);
    assert.equal(s.calls.length, 1);
    // 同じ opKey の押し直しは同じキー
    await order.createOrderTransferIdempotent(s.admin, input, idem());
    assert.equal(s.calls[0].key, s.calls[1].key);
    assert.equal(s.transfers(), 1);
  });

  it("トップの errors・下書きの道の例外も uncertain", async () => {
    const top = await order.createOrderTransferIdempotent(fakeShopify({ reply: () => json({ errors: [{ message: "Internal error" }] }) }).admin, input, idem());
    assert.equal(top.uncertain, true);
    const s = fakeShopify({
      reply: (n) => (n === 0 ? new Error("Field 'inventoryTransferCreateAsReadyToShip' doesn't exist on type 'Mutation'") : n === 1 ? new Error("timeout") : null),
    });
    const r = await order.createOrderTransferIdempotent(s.admin, input, idem());
    assert.equal(r.uncertain, true);
  });

  it("「この版に無い」の見分け: Shopify の文は当たり、通信の失敗・ほかの文は当たらない", () => {
    const n = "inventoryTransferCreateAsReadyToShip";
    assert.ok(order.isMutationMissingError(new Error(`Field '${n}' doesn't exist on type 'Mutation'`), n));
    assert.ok(order.isMutationMissingError(new Error(`[{"message":"Field '${n}' doesn't exist on type 'Mutation'"}]`), n));
    assert.ok(!order.isMutationMissingError(new Error("socket hang up"), n));
    assert.ok(!order.isMutationMissingError(new Error("Field 'foo' doesn't exist"), n));
  });

  it("処理中のまま・中身の違い → uncertain: true（承認を止める）。はっきりした断り → uncertain なし", async () => {
    const cc = await order.createOrderTransferIdempotent(
      fakeShopify({ reply: () => userError("inventoryTransferCreateAsReadyToShip", "IDEMPOTENCY_CONCURRENT_REQUEST") }).admin,
      input,
      idem()
    );
    assert.equal(cc.uncertain, true);
    assert.equal(cc.transferId, null);
    const mm = await order.createOrderTransferIdempotent(
      fakeShopify({ reply: () => userError("inventoryTransferCreateAsReadyToShip", "IDEMPOTENCY_KEY_PARAMETER_MISMATCH") }).admin,
      input,
      idem()
    );
    assert.equal(mm.uncertain, true);
    const rej = await order.createOrderTransferIdempotent(
      fakeShopify({ reply: () => userError("inventoryTransferCreateAsReadyToShip", "INVALID_ITEM", "bad") }).admin,
      input,
      idem()
    );
    assert.equal(rej.uncertain, undefined);
    assert.match(rej.error, /Transfer作成エラー/);
  });
});

describe("画面の配線（文の照らし合わせ）", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("棚卸: 確定・取り消しの 6 か所で opKey を入れて送る。取り消しで戻した回数を増やす", () => {
    const src = read("app/routes/app.inventory-count.tsx");
    assert.equal((src.match(/historyOpKey\.append\(fd, `\$\{modalCount\.id\}:(confirm|revert|confirm_all|revert_all)[^`]*`\);\n\s*historyActionFetcher\.submit/g) ?? []).length, 6);
    assert.equal((src.match(/idempotencyRevertRound: nextRevertRound/g) ?? []).length, 2);
    assert.equal((src.match(/adjustInventoryQuantitiesServer\(/g) ?? []).length, 4);
    assert.equal((src.match(/buildAdminIdempotency\(\{/g) ?? []).length, 4);
    assert.doesNotMatch(src, /inventorySetQuantities\(/);
  });
  it("発注: 承認で opKey を入れて送る。承認の取り消しで戻した回数を増やす", () => {
    const src = read("app/routes/app.order.tsx");
    assert.match(src, /orderOpKey\.append\(formData, modalEntry\.id\);\n\s*fetcher\.submit/);
    // Transfer を作ったあとの記録の保存の失敗は uncertain
    assert.match(src, /metafieldsSetError\(/);
    assert.equal((src.match(/idempotencyRevertRound: readRevertRound\(e\.idempotencyRevertRound\) \+ 1/g) ?? []).length, 2);
    assert.doesNotMatch(src, /inventoryTransferCreate(AsReadyToShip)?\(input/);
  });
  it("仕入れ: 確定・取り消しで opKey を入れて送る", () => {
    const src = read("app/routes/app.purchase.tsx");
    assert.equal((src.match(/purchaseOpKey\.append\((fd, modalEntry\.id|formData, entryId)\);/g) ?? []).length, 2);
    // 在庫を書いたあとの記録の保存の失敗は uncertain（確定・取り消しの 2 か所）
    assert.equal((src.match(/const mfError = await metafieldsSetError\(/g) ?? []).length, 2);
    assert.doesNotMatch(src, /inventoryAdjustQuantities\(input/);
  });
  it("版は 2026-01 のまま", () => {
    assert.match(read("app/shopify.server.ts"), /apiVersion: ApiVersion\.January26/);
    assert.doesNotMatch(read("app/shopify.server.ts"), /April26/);
  });
});
