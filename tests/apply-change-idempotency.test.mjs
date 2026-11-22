/**
 * サーバー apply-change の @idempotent（docs/IDEMPOTENT_MIGRATION.md 4.5・6.1 の 3）。
 * admin.graphql を偽物にして、送ったキーを見る。
 * - 応答なし・503 の送り直し → 同じキー
 * - 同じ操作・同じ回の丸ごとの呼び直し → 同じキー。回（ns1・tr1）や操作の ID（failed の作り直し）が違えば違うキー
 * - STALE のあとの書き直し → 違うキー（main.stale1）
 * - 元に戻す書き込み → 前に進む書き込みと違うキー。チャンクごとに違う
 * - IDEMPOTENCY_CONCURRENT_REQUEST → 待って同じキー。待ち切ったら「結果が分からない」
 * - IDEMPOTENCY_KEY_PARAMETER_MISMATCH → application_uncertain（partial_failed）。新しいキーで送らない
 * - 有効化（inventoryActivate）: 通信の失敗の送り直しは同じキー、はっきり断られたら新しいキー、中身の違いは止める
 * Run: node --experimental-strip-types --test tests/apply-change-idempotency.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { setInventoryQuantitiesServer, INVENTORY_SET_QUANTITIES_MUTATION } = await import(
  "../app/utils/inventory-set-quantities-server.ts"
);
const { ensureInventoryActivatedAtLocation, buildActivateIdempotencyKey } = await import(
  "../app/utils/ensure-inventory-activated-server.ts"
);
const { buildIdempotencyKeyServer } = await import("../app/utils/idempotency-key.server.ts");
const { isUuidV5 } = await import("../extensions/common/idempotencyKey.js");

const SHOP = "bbbincbbb.myshopify.com";
const LOC = "gid://shopify/Location/1";
const gid = (n) => `gid://shopify/InventoryItem/${n}`;
const FAST = [0, 0, 0];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const setOk = () => json({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "g" }, userErrors: [] } } });
const setUserError = (code, message = code) =>
  json({
    data: {
      inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: null, message, code }] },
    },
  });

/**
 * Shopify のふり（inventorySetQuantities と読み取り）。
 * setReply(callNo, variables) が応答を返すとその応答（在庫は動かない）。返さなければ書く。
 */
function fakeShopify({ stock = new Map(), setReply = () => null } = {}) {
  const sets = [];
  const admin = {
    async graphql(query, opts) {
      const v = opts?.variables ?? {};
      if (query.includes("inventorySetQuantities")) {
        const callNo = sets.length;
        sets.push({ query, key: v.idempotencyKey, input: v.input });
        const reply = setReply(callNo, v);
        if (reply) return reply;
        const stale = v.input.quantities.some(
          (q) => q.changeFromQuantity != null && (stock.get(q.inventoryItemId) ?? 0) !== q.changeFromQuantity
        );
        if (stale) return setUserError("CHANGE_FROM_QUANTITY_STALE", "The quantity has changed.");
        for (const q of v.input.quantities) stock.set(q.inventoryItemId, q.quantity);
        return setOk();
      }
      if (query.includes("nodes(ids")) {
        return json({
          data: {
            nodes: v.ids.map((id) => ({
              id,
              inventoryLevel: stock.has(id) ? { quantities: [{ name: "available", quantity: stock.get(id) }] } : null,
            })),
          },
        });
      }
      if (query.includes("inventoryLevel(locationId")) {
        if (!stock.has(v.id)) return json({ data: { inventoryItem: { inventoryLevel: null } } });
        return json({
          data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "available", quantity: stock.get(v.id) }] } } },
        });
      }
      throw new Error("unexpected query " + query.slice(0, 60));
    },
  };
  return { admin, sets };
}

const ctx = (round = "main", operationId = "evt_row_1") => ({
  shop: SHOP,
  operationId,
  round,
  concurrentRetryDelaysMs: FAST,
});
const expectedKey = (stage, chunk, round, operationId = "evt_row_1") =>
  buildIdempotencyKeyServer({ shop: SHOP, kind: "apply_change", operationId, stage, chunk, round });

describe("setInventoryQuantitiesServer: 送る文とキー", () => {
  it("mutation に @idempotent(key: $idempotencyKey) が付き、キーは材料どおりの UUID v5", async () => {
    assert.match(INVENTORY_SET_QUANTITIES_MUTATION, /inventorySetQuantities\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/);
    assert.match(INVENTORY_SET_QUANTITIES_MUTATION, /\$idempotencyKey: String!/);
    const { admin, sets } = fakeShopify();
    const r = await setInventoryQuantitiesServer(admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null, {
      idempotency: ctx(),
    });
    assert.equal(r.ok, true);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].key, expectedKey("set_fwd", "1/1", "main"));
    assert.ok(isUuidV5(sets[0].key));
  });

  it("1 回目 503 → 2 回目成功: 2 回とも同じキー", async () => {
    const { admin, sets } = fakeShopify({
      setReply: (n) => (n === 0 ? json({ errors: [{ message: "Service Unavailable" }] }, 503) : null),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null, {
      idempotency: ctx(),
    });
    assert.equal(r.ok, true);
    assert.equal(sets.length, 2);
    assert.equal(sets[0].key, sets[1].key);
  });

  it("同じ操作・同じ回で丸ごと呼び直すと同じキー。回（ns1・tr1）・操作の ID が違えば違うキー", async () => {
    const keys = {};
    for (const [label, c] of [
      ["main", ctx("main")],
      ["main-again", ctx("main")],
      ["ns1", ctx("ns1")],
      ["tr1", ctx("tr1")],
      ["recreated-row", ctx("main", "evt_row_2")],
    ]) {
      const { admin, sets } = fakeShopify();
      await setInventoryQuantitiesServer(admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null, { idempotency: c });
      keys[label] = sets[0].key;
    }
    assert.equal(keys.main, keys["main-again"]);
    assert.equal(new Set([keys.main, keys.ns1, keys.tr1, keys["recreated-row"]]).size, 4);
  });

  it("操作の ID を渡さない呼び出しは、呼ぶたびに違うキー（今と同じ動き）", async () => {
    const a = fakeShopify();
    const b = fakeShopify();
    await setInventoryQuantitiesServer(a.admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null);
    await setInventoryQuantitiesServer(b.admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null);
    assert.ok(isUuidV5(a.sets[0].key));
    assert.notEqual(a.sets[0].key, b.sets[0].key);
  });

  it("STALE のあとに読み直して書き直すときは違うキー（main.stale1）", async () => {
    const stock = new Map([[gid(1), 3], [gid(2), 4]]);
    const { admin, sets } = fakeShopify({
      stock,
      // 1 回目の書き込みの直前に店で 1 個売れた（gid 2 だけ動いた）
      setReply: (n) => {
        if (n === 0) {
          stock.set(gid(2), 3);
          return setUserError("CHANGE_FROM_QUANTITY_STALE", "The quantity has changed.");
        }
        return null;
      },
    });
    const r = await setInventoryQuantitiesServer(
      admin,
      LOC,
      [
        { inventoryItemId: gid(1), quantity: 10 },
        { inventoryItemId: gid(2), quantity: 10 },
      ],
      null,
      { compareWithLive: true, idempotency: ctx() }
    );
    assert.equal(sets.length, 2);
    assert.equal(sets[0].key, expectedKey("set_fwd", "1/1", "main"));
    assert.equal(sets[1].key, expectedKey("set_fwd", "1/1", "main.stale1"));
    assert.equal(r.partiallyApplied, true);
    assert.deepEqual(r.concurrentChangedInventoryItemIds, [gid(2)]);
  });

  it("251 件以上: チャンクごとに違うキー。元に戻す書き込みは前に進む書き込みと違うキー", async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ inventoryItemId: gid(i + 1), quantity: 7 }));
    const stock = new Map(items.map((q) => [q.inventoryItemId, 1]));
    const { admin, sets } = fakeShopify({
      stock,
      // 2 チャンク目をはっきり断る → 1 チャンク目を戻す
      setReply: (n) => (n === 1 ? setUserError("INVALID_QUANTITY", "bad") : null),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, { idempotency: ctx() });
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.equal(sets.length, 3);
    assert.equal(sets[0].key, expectedKey("set_fwd", "1/2", "main"));
    assert.equal(sets[1].key, expectedKey("set_fwd", "2/2", "main"));
    assert.equal(sets[2].key, expectedKey("set_rb", "1/2", "main"));
    assert.equal(new Set(sets.map((s) => s.key)).size, 3);
    assert.equal(stock.get(gid(1)), 1, "戻した");
  });

  it("元に戻したあとの丸ごとの呼び直し（tr1）は、1 チャンク目も新しいキーで送る（前の成功の答えだけが返らない）", async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ inventoryItemId: gid(i + 1), quantity: 7 }));
    const first = fakeShopify({
      stock: new Map(items.map((q) => [q.inventoryItemId, 1])),
      setReply: (n) => (n === 1 ? setUserError("INVALID_QUANTITY", "bad") : null),
    });
    await setInventoryQuantitiesServer(first.admin, LOC, items, null, { idempotency: ctx("main") });
    const again = fakeShopify({ stock: new Map(items.map((q) => [q.inventoryItemId, 1])) });
    await setInventoryQuantitiesServer(again.admin, LOC, items, null, { idempotency: ctx("tr1") });
    assert.notEqual(again.sets[0].key, first.sets[0].key);
  });
});

describe("setInventoryQuantitiesServer: @idempotent の返事", () => {
  it("IDEMPOTENCY_CONCURRENT_REQUEST → 待って同じキーで送り直し、通れば成功", async () => {
    const { admin, sets } = fakeShopify({
      setReply: (n) => (n < 2 ? setUserError("IDEMPOTENCY_CONCURRENT_REQUEST", "This request is currently in progress, please try again.") : null),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null, {
      idempotency: ctx(),
    });
    assert.equal(r.ok, true);
    assert.equal(sets.length, 3);
    assert.equal(new Set(sets.map((s) => s.key)).size, 1);
  });

  it("IDEMPOTENCY_CONCURRENT_REQUEST のまま待ち切った → 結果が分からない（partial・uncertain）。新しいキーで送らない", async () => {
    const { admin, sets } = fakeShopify({
      setReply: () => setUserError("IDEMPOTENCY_CONCURRENT_REQUEST", "This request is currently in progress, please try again."),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null, {
      idempotency: ctx(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, true);
    assert.equal(r.idempotencyIssue, "concurrent");
    assert.equal(sets.length, 1 + FAST.length);
    assert.equal(new Set(sets.map((s) => s.key)).size, 1);
    assert.match(r.error, /IDEMPOTENCY_CONCURRENT_REQUEST/);
  });

  it("IDEMPOTENCY_KEY_PARAMETER_MISMATCH → application_uncertain（partial）。送り直さない", async () => {
    const { admin, sets } = fakeShopify({
      setReply: () =>
        setUserError(
          "IDEMPOTENCY_KEY_PARAMETER_MISMATCH",
          "The same idempotency key cannot be used with different operation parameters."
        ),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, [{ inventoryItemId: gid(1), quantity: 5 }], null, {
      idempotency: ctx(),
    });
    assert.equal(sets.length, 1, "新しいキーでも同じキーでも送り直さない");
    assert.equal(r.ok, false);
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, true);
    assert.equal(r.rolledBack, false);
    assert.equal(r.idempotencyIssue, "mismatch");
    assert.deepEqual(r.appliedInventoryItemIds, []);
    assert.equal(r.failedChunkIndex, 0);
    assert.match(r.error, /IDEMPOTENCY_KEY_PARAMETER_MISMATCH/);
  });

  it("IDEMPOTENCY_KEY_PARAMETER_MISMATCH が 2 チャンク目 → 1 チャンク目を戻さず、入った分だけを入ったと言う", async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ inventoryItemId: gid(i + 1), quantity: 7 }));
    const stock = new Map(items.map((q) => [q.inventoryItemId, 1]));
    const { admin, sets } = fakeShopify({
      stock,
      setReply: (n) => (n === 1 ? setUserError("IDEMPOTENCY_KEY_PARAMETER_MISMATCH", "mismatch") : null),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, { idempotency: ctx() });
    assert.equal(sets.length, 2, "戻す書き込みをしない（2 チャンク目が入ったか分からないため）");
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, true);
    assert.equal(r.appliedInventoryItemIds.length, 250);
    assert.equal(r.failedChunkIndex, 1);
  });

  it("元に戻す書き込みが IDEMPOTENCY_KEY_PARAMETER_MISMATCH → 戻ったか分からない（application_uncertain）", async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ inventoryItemId: gid(i + 1), quantity: 7 }));
    const { admin, sets } = fakeShopify({
      stock: new Map(items.map((q) => [q.inventoryItemId, 1])),
      setReply: (n) =>
        n === 1
          ? setUserError("INVALID_QUANTITY", "bad")
          : n === 2
            ? setUserError("IDEMPOTENCY_KEY_PARAMETER_MISMATCH", "mismatch")
            : null,
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, { idempotency: ctx() });
    assert.equal(sets.length, 3);
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, true, "はっきりした断りとして扱わない");
    assert.equal(r.idempotencyIssue, "mismatch");
    assert.deepEqual(r.appliedInventoryItemIds, [], "戻したかもしれない 1 チャンク目を入ったと言わない");
  });
});

/** 有効化の偽物。replies: 有効化の呼び出しごとの応答（関数）。無ければ成功 */
function fakeActivate(replies = []) {
  const activations = [];
  const admin = {
    async graphql(query, opts) {
      const v = opts?.variables ?? {};
      if (query.includes("CheckInventoryItems")) {
        return json({ data: { nodes: v.ids.map((id) => ({ id, tracked: true, inventoryLevel: null })) } });
      }
      if (query.includes("inventoryActivate")) {
        activations.push({ query, vars: v });
        const r = replies[activations.length - 1];
        if (r) return r();
        return json({ data: { inventoryActivate: { inventoryLevel: { id: "lvl" }, userErrors: [] } } });
      }
      if (query.includes("VerifyInventoryLevels")) {
        return json({ data: { nodes: v.ids.map((id) => ({ id, inventoryLevel: { id: "lvl" } })) } });
      }
      throw new Error("unexpected " + query.slice(0, 60));
    },
  };
  return { admin, activations };
}
const actUserError = (message) =>
  json({ data: { inventoryActivate: { inventoryLevel: null, userErrors: [{ field: null, message }] } } });

describe("ensureInventoryActivatedAtLocation: @idempotent", () => {
  it("mutation に @idempotent が付き、1 回目のキーは初めの数を含む材料どおり", async () => {
    const { admin, activations } = fakeActivate();
    const r = await ensureInventoryActivatedAtLocation(admin, LOC, [{ inventoryItemId: gid(42), quantity: 5 }], ctx());
    assert.equal(r.ok, true);
    assert.equal(activations.length, 1);
    assert.match(activations[0].query, /\) @idempotent\(key: \$idempotencyKey\) \{/);
    assert.equal(activations[0].vars.available, 5);
    assert.equal(
      activations[0].vars.idempotencyKey,
      buildActivateIdempotencyKey({
        shop: SHOP,
        operationId: "evt_row_1",
        round: "main",
        locationGid: LOC,
        inventoryItemGid: gid(42),
        initialQuantity: 5,
        rejections: 0,
      })
    );
    assert.equal(activations[0].vars.idempotencyKey, expectedKey("activate:1:42:5:5", "1/1", "main"));
  });

  it("はっきり断られるたびに新しいキー。トップの errors（混雑など）のあとは同じキー", async () => {
    const { admin, activations } = fakeActivate([
      () => actUserError("Something went wrong"), // 1 回目（初めの数あり）
      () => json({ errors: [{ message: "Throttled" }] }), // 2 回目（初めの数なし）
      () => actUserError("Something went wrong"), // 3 回目（2 回目と同じキー）
    ]);
    const r = await ensureInventoryActivatedAtLocation(admin, LOC, [{ inventoryItemId: gid(42), quantity: 5 }], ctx());
    assert.equal(r.ok, true);
    const keys = activations.map((a) => a.vars.idempotencyKey);
    assert.equal(keys.length, 4);
    assert.equal(keys[0], expectedKey("activate:1:42:5:5", "1/1", "main"));
    assert.equal(keys[1], expectedKey("activate:1:42:-:-", "1/1", "main.rej1"));
    assert.equal(keys[2], keys[1], "トップの errors のあとは同じキー");
    assert.equal(keys[3], expectedKey("activate:1:42:-:-", "1/1", "main.rej2"));
  });

  it("IDEMPOTENCY_KEY_PARAMETER_MISMATCH（code の無い UserError の文）→ 送り直さずに失敗を返す", async () => {
    const { admin, activations } = fakeActivate([
      () => actUserError("The same idempotency key cannot be used with different operation parameters."),
    ]);
    const r = await ensureInventoryActivatedAtLocation(admin, LOC, [{ inventoryItemId: gid(42), quantity: 5 }], ctx());
    assert.equal(r.ok, false);
    assert.equal(activations.length, 1);
    assert.match(r.errors[0].message, /IDEMPOTENCY_KEY_PARAMETER_MISMATCH/);
  });

  it("IDEMPOTENCY_CONCURRENT_REQUEST → 断りの回数を増やさず送り直す", async () => {
    const { admin, activations } = fakeActivate([
      () => actUserError("This request is currently in progress, please try again."),
    ]);
    const r = await ensureInventoryActivatedAtLocation(admin, LOC, [{ inventoryItemId: gid(42), quantity: 5 }], ctx());
    assert.equal(r.ok, true);
    assert.equal(activations.length, 2);
    // 2 回目は初めの数を渡さない（今の動き）ので段は違うが、回は main のまま
    assert.equal(activations[1].vars.idempotencyKey, expectedKey("activate:1:42:-:-", "1/1", "main"));
  });

  it("呼ぶ場所（round）が違えば違うキー", async () => {
    const a = fakeActivate();
    const b = fakeActivate();
    await ensureInventoryActivatedAtLocation(a.admin, LOC, [{ inventoryItemId: gid(42), quantity: 5 }], ctx("main"));
    await ensureInventoryActivatedAtLocation(b.admin, LOC, [{ inventoryItemId: gid(42), quantity: 5 }], ctx("ns1"));
    assert.notEqual(a.activations[0].vars.idempotencyKey, b.activations[0].vars.idempotencyKey);
  });
});

describe("apply-change: 呼ぶ場所ごとの回と操作の ID", () => {
  const src = readFileSync(new URL("../app/routes/api.inventory.apply-change.tsx", import.meta.url), "utf8");
  it("操作の ID は行の id（event.id）。appEventId ではない", () => {
    assert.match(src, /const idem = \(round: string\) => \(\{ shop, operationId: event\.id, round \}\)/);
  });
  it("有効化は main・act_retry・verify1・ns1、書き込みは main・ns1・tr1", () => {
    assert.match(src, /ensureInventoryActivatedAtLocation\(admin, locationId, shopifyItems, idem\("main"\)\)/);
    assert.match(src, /idem\(`act_retry\$\{r \+ 1\}`\)/);
    assert.match(src, /ensureInventoryActivatedAtLocation\(admin, locationId, missingItems, idem\("verify1"\)\)/);
    assert.match(src, /ensureInventoryActivatedAtLocation\(admin, locationId, shopifyItems, idem\("ns1"\)\)/);
    for (const round of ["main", "ns1", "tr1"]) assert.ok(src.includes(`setOptions("${round}")`), round);
  });
  it("版は 2026-01 のまま", () => {
    assert.match(src, /const API_VERSION = "2026-01";/);
  });
  it("@idempotent の返事で止めたときは POS に idempotencyIssue を返す（errorCode は partial_failed のまま）", () => {
    assert.match(src, /idempotencyIssue: result\.idempotencyIssue/);
  });
});
