/**
 * POS 入庫の受け取りと有効化の @idempotent（docs/IDEMPOTENT_MIGRATION.md 4.4・4.3・6.1 の 5。3 段目）。
 * adminGraphql を偽物にし、Shopify と同じく「同じキーの 2 回目は受け取らずに前の答えを返す」ふりをする。
 * Run: node --test tests/inbound-receive-idempotency.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sr = await import("../extensions/common/shipmentReceive.js");
const { buildActivateKeyForPos } = await import("../extensions/common/activateIdempotency.js");
const { isUuidV5 } = await import("../extensions/common/idempotencyKey.js");

const SHOP = "bbbincbbb.myshopify.com";
const SHIP = "gid://shopify/InventoryShipment/9";
const L1 = "gid://shopify/InventoryShipmentLineItem/1";
const L2 = "gid://shopify/InventoryShipmentLineItem/2";
const FAST = [0, 0, 0];

/** 伝票（Shopify のふり）。lines: id → { quantity, accepted, rejected } */
function fakeShopify({ lines = { [L1]: { quantity: 5, accepted: 0, rejected: 0 } }, reply = () => null } = {}) {
  const remembered = new Map();
  const calls = [];
  async function adminGraphql(query, variables) {
    const callNo = calls.length;
    calls.push({ query, variables, key: variables?.idempotencyKey });
    const r = reply(callNo, variables);
    if (r instanceof Error) throw r;
    const dropAnswer = r === "drop";
    if (r && !dropAnswer) return r;
    if (variables.idempotencyKey && remembered.has(variables.idempotencyKey)) return remembered.get(variables.idempotencyKey);
    for (const li of variables.lineItems) {
      const l = lines[li.shipmentLineItemId];
      if (li.reason === "REJECTED") l.rejected += li.quantity;
      else l.accepted += li.quantity;
    }
    const body = { inventoryShipmentReceive: { inventoryShipment: { id: variables.id, status: "PARTIALLY_RECEIVED" }, userErrors: [] } };
    remembered.set(variables.idempotencyKey, body);
    if (dropAnswer) throw new Error("timeout 20000ms");
    return body;
  }
  const readLines = () => Object.entries(lines).map(([id, l]) => ({ id, quantity: l.quantity, acceptedQuantity: l.accepted, rejectedQuantity: l.rejected }));
  return { adminGraphql, calls, lines, readLines };
}
const userErr = (code, message = code) => ({ inventoryShipmentReceive: { inventoryShipment: null, userErrors: [{ field: null, message, code }] } });
const op = (readLines, kind = sr.INBOUND_RECEIVE_KIND) => sr.buildShipmentReceiveOperation({ kind, shipmentId: SHIP, readLines, shop: SHOP });

describe("指紋とキー", () => {
  it("読んだときの指紋は順番によらない。Shopify の明細と画面の行の両方を読む", () => {
    const a = sr.buildShipmentReadFingerprint([
      { id: L2, acceptedQuantity: 3, rejectedQuantity: 1 },
      { id: L1, acceptedQuantity: 0, rejectedQuantity: 0 },
    ]);
    const b = sr.buildShipmentReadFingerprint([
      { shipmentLineItemId: L1, alreadyAcceptedQty: 0, alreadyRejectedQty: 0 },
      { shipmentLineItemId: L2, alreadyAcceptedQty: 3, alreadyRejectedQty: 1 },
    ]);
    assert.equal(a, b);
    assert.equal(a, `${L1}:0:0,${L2}:3:1`);
  });
  it("答えが Python の uuid.uuid5 と同じ（材料の並べ方の確かめ）", () => {
    const o = sr.buildShipmentReceiveOperation({
      kind: "inbound_receive",
      shipmentId: SHIP,
      shop: SHOP,
      readLines: [
        { id: L1, acceptedQuantity: 0, rejectedQuantity: 0 },
        { id: L2, acceptedQuantity: 3, rejectedQuantity: 1 },
      ],
    });
    const key = sr.buildShipmentReceiveKey(o, { stage: "receive_v2", items: [{ shipmentLineItemId: L1, quantity: 2, reason: "ACCEPTED" }] });
    assert.equal(key, "e8da3fbb-accf-5737-993a-a961e75fd5f9");
    assert.equal(
      buildActivateKeyForPos({ shop: SHOP, operationId: "op-1", locationId: "gid://shopify/Location/2", inventoryItemId: "gid://shopify/InventoryItem/5", rejections: 1 }),
      "9c9bc716-b2d7-5ad2-a88b-9137c1ad6741"
    );
  });
  it("受け取り済みの数・段・回・送る明細・種類のどれかが違えば違うキー", () => {
    const items = [{ shipmentLineItemId: L1, quantity: 2, reason: "ACCEPTED" }];
    const base = sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }]), { stage: "receive_v2", items });
    assert.ok(isUuidV5(base));
    const others = [
      sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 2 }]), { stage: "receive_v2", items }),
      sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }]), { stage: "receive_v2b", items }),
      sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }]), { stage: "receive_capped", items }),
      sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }]), { stage: "reject", items }),
      sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }]), { stage: "receive_v2", items, round: "ns1" }),
      sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }]), { stage: "receive_v2", items: [{ ...items[0], quantity: 3 }] }),
      sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }], sr.OUTBOUND_REJECT_ALL_KIND), { stage: "receive_v2", items }),
    ];
    for (const k of others) assert.notEqual(k, base);
    assert.equal(new Set(others).size, others.length);
    assert.equal(sr.buildShipmentReceiveKey(op([{ id: L1, acceptedQuantity: 0 }]), { stage: "receive_v2", items }), base);
  });
  it("ID に | があっても止まらない", () => {
    const o = sr.buildShipmentReceiveOperation({ kind: "inbound_receive", shipmentId: "a|b", readLines: [{ id: "x|y" }], shop: SHOP });
    assert.ok(isUuidV5(sr.buildShipmentReceiveKey(o, { stage: "receive_v2", items: [{ shipmentLineItemId: "x|y", quantity: 1 }] })));
  });
});

describe("受け取り（receiveShipmentIdempotent）", () => {
  it("送る文に @idempotent と $idempotencyKey。inventoryShipmentReceiveItems は試さない（1 回だけ送る）", async () => {
    const s = fakeShopify();
    await sr.receiveShipmentIdempotent({
      adminGraphql: s.adminGraphql,
      shipmentId: SHIP,
      items: [{ shipmentLineItemId: L1, quantity: 2 }],
      op: op(s.readLines()),
    });
    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0].query, /inventoryShipmentReceive\(id: \$id, lineItems: \$lineItems\) @idempotent\(key: \$idempotencyKey\)/);
    assert.match(s.calls[0].query, /\$idempotencyKey: String!/);
    assert.doesNotMatch(s.calls[0].query, /inventoryShipmentReceiveItems/);
    assert.equal(s.calls[0].variables.lineItems[0].reason, "ACCEPTED");
  });

  it("応答なし（時間切れ）のあと、読み直さずに同じ中身で押し直す → 同じキー → 二重に受け取らない", async () => {
    const s = fakeShopify({ reply: (n) => (n === 0 ? "drop" : null) });
    const o = op(s.readLines());
    const items = [{ shipmentLineItemId: L1, quantity: 2 }];
    await assert.rejects(sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: o }), /timeout/);
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: o });
    assert.equal(s.calls[0].key, s.calls[1].key);
    assert.equal(s.lines[L1].accepted, 2);
  });

  it("読み直したあとは受け取り済みが変わるので、同じ数を受け取るのは新しいキー（2 回目の一部入庫がちゃんと入る）", async () => {
    const s = fakeShopify();
    const items = [{ shipmentLineItemId: L1, quantity: 2 }];
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: op(s.readLines()) });
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: op(s.readLines()) });
    assert.notEqual(s.calls[0].key, s.calls[1].key);
    assert.equal(s.lines[L1].accepted, 4);
  });

  it("250 件を超えると 250 件ずつ・チャンクごとに違うキー", async () => {
    const lines = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`L${i}`, { quantity: 1, accepted: 0, rejected: 0 }]));
    const s = fakeShopify({ lines });
    const items = Object.keys(lines).map((id) => ({ shipmentLineItemId: id, quantity: 1 }));
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: op(s.readLines()) });
    assert.deepEqual(s.calls.map((c) => c.variables.lineItems.length), [250, 50]);
    assert.notEqual(s.calls[0].key, s.calls[1].key);
  });

  it("reason が使えない版のエラー → reason なしで送り直す（段 receive_v2b・違うキー）", async () => {
    const s = fakeShopify({ reply: (n) => (n === 0 ? new Error('[{"message":"Field \'reason\' is not defined by type InventoryShipmentReceiveItemInput"}]') : null) });
    const o = op(s.readLines());
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items: [{ shipmentLineItemId: L1, quantity: 1 }], op: o });
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1].variables.lineItems[0].reason, undefined);
    assert.equal(s.calls[1].key, sr.buildShipmentReceiveKey(o, { stage: "receive_v2b", items: [{ shipmentLineItemId: L1, quantity: 1 }] }));
    // 予定を超えた分を外す道（receive_capped）・拒否（reject）の reason なしは <段>_b
    const s2 = fakeShopify({ reply: (n) => (n === 0 ? new Error("Field 'reason' is not defined by type X") : null) });
    const items = [{ shipmentLineItemId: L1, quantity: 1, reason: "REJECTED" }];
    await sr.receiveShipmentIdempotent({ adminGraphql: s2.adminGraphql, shipmentId: SHIP, items, op: o, stage: "reject" });
    assert.equal(s2.calls[1].key, sr.buildShipmentReceiveKey(o, { stage: "reject_b", items: [{ shipmentLineItemId: L1, quantity: 1 }] }));
  });

  it("IDEMPOTENCY_CONCURRENT_REQUEST → 待って同じキーで送り直して成功。待ち切ったら concurrent のエラー", async () => {
    const s = fakeShopify({ reply: (n) => (n === 0 ? userErr("IDEMPOTENCY_CONCURRENT_REQUEST") : null) });
    const items = [{ shipmentLineItemId: L1, quantity: 1 }];
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: op(s.readLines()), concurrentDelaysMs: FAST });
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].key, s.calls[1].key);
    const s2 = fakeShopify({ reply: () => userErr("IDEMPOTENCY_CONCURRENT_REQUEST") });
    await assert.rejects(
      sr.receiveShipmentIdempotent({ adminGraphql: s2.adminGraphql, shipmentId: SHIP, items, op: op(s2.readLines()), concurrentDelaysMs: FAST }),
      (e) => e instanceof sr.ShipmentReceiveIdempotencyError && e.idempotencyIssue === "concurrent"
    );
    assert.equal(s2.calls.length, 4);
    assert.equal(new Set(s2.calls.map((c) => c.key)).size, 1);
  });

  it("IDEMPOTENCY_KEY_PARAMETER_MISMATCH → 送り直さず mismatch のエラー。文は呼び出し側の「在庫が無い」「数が多すぎる」に当たらない", async () => {
    const s = fakeShopify({ reply: () => userErr("IDEMPOTENCY_KEY_PARAMETER_MISMATCH") });
    let err;
    try {
      await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items: [{ shipmentLineItemId: L1, quantity: 1 }], op: op(s.readLines()) });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof sr.ShipmentReceiveIdempotencyError);
    assert.equal(err.idempotencyIssue, "mismatch");
    assert.equal(s.calls.length, 1);
    // InboundListScreen.jsx の見分けの文（在庫が無い → 有効化して送り直す・数 → 予定を超えた分を外す）に当たらない
    assert.doesNotMatch(err.message, /配送先|not stocked|inventory.*location|アイテムの在庫がありません|no inventory at/i);
    assert.doesNotMatch(err.message, /quantity|unreceived|exceed|max|greater|less/i);
    assert.doesNotMatch(err.message, /reason/i);
    const c = new sr.ShipmentReceiveIdempotencyError("concurrent");
    assert.doesNotMatch(c.message, /配送先|not stocked|inventory.*location|quantity|unreceived|exceed|max|greater|less|reason/i);
  });

  it("トップの errors に中身の違いの code が入って投げられたときも mismatch", async () => {
    const s = fakeShopify({ reply: () => new Error('[{"message":"x","extensions":{"code":"IDEMPOTENCY_KEY_PARAMETER_MISMATCH"}}]') });
    await assert.rejects(
      sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items: [{ shipmentLineItemId: L1, quantity: 1 }], op: op(s.readLines()) }),
      (e) => e.idempotencyIssue === "mismatch"
    );
  });

  it("はっきりした断り（userErrors）は今までと同じ形のエラー（inventoryShipmentReceive failed: …）", async () => {
    const s = fakeShopify({ reply: () => userErr("INVALID_QUANTITY", "Quantity exceeds unreceived quantity") });
    await assert.rejects(
      sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items: [{ shipmentLineItemId: L1, quantity: 9 }], op: op(s.readLines()) }),
      /inventoryShipmentReceive failed: Quantity exceeds/
    );
  });

  it("在庫が無いと断られて有効化したあとの送り直し（回 ns1）は新しいキー → 前の断りが返らずに受け取れる", async () => {
    let stocked = false;
    const s = fakeShopify({ reply: (n) => (!stocked ? userErr("ITEM_NOT_STOCKED_AT_LOCATION", "The item is not stocked at the location") : null) });
    const o = op(s.readLines());
    const items = [{ shipmentLineItemId: L1, quantity: 2 }];
    await assert.rejects(sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: o, stage: "receive_v2" }), /not stocked/);
    stocked = true; // 有効化した
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: o, stage: "receive_v2", round: "ns1" });
    assert.notEqual(s.calls[0].key, s.calls[1].key);
    assert.equal(s.lines[L1].accepted, 2);
  });

  it("op を渡さない呼び出し → 呼ぶたびに違うキー（今と同じ動き）", async () => {
    const s = fakeShopify();
    const items = [{ shipmentLineItemId: L1, quantity: 1 }];
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items });
    await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items });
    assert.notEqual(s.calls[0].key, s.calls[1].key);
  });

  it("数が 0・ID が無い明細だけなら送らない", async () => {
    const s = fakeShopify();
    const r = await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items: [{ shipmentLineItemId: L1, quantity: 0 }, { quantity: 3 }] });
    assert.equal(r, null);
    assert.equal(s.calls.length, 0);
  });
});

describe("250 件を超える受け取りの途中失敗（ShipmentReceivePartialError）", () => {
  const many = (n, prefix = "gid://shopify/InventoryShipmentLineItem/") =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(4, "0")}`, { quantity: 5, accepted: 0, rejected: 0 }]));
  const itemsOf = (lines, q = 1) => Object.keys(lines).map((id) => ({ shipmentLineItemId: id, quantity: q }));
  // 入庫の画面（InboundListScreen.jsx）が代わりの道へ進むかを決める文
  const NOT_STOCKED = /配送先|not stocked|inventory.*location|アイテムの在庫がありません|no inventory at/i;
  const TOO_MANY = /quantity|unreceived|exceed|max|greater|less/i;

  for (const [label, reply] of [
    ["在庫が無い", userErr("INVALID", "Item is not stocked at the destination location")],
    ["数が多すぎる", userErr("INVALID", "quantity exceeds the unreceived quantity")],
  ]) {
    it(`1 つ目が通り 2 つ目が「${label}」で断られる → 別のエラー・1 つ目は二度と送らない・入った分を持つ`, async () => {
      const lines = many(300);
      const s = fakeShopify({ lines, reply: (n) => (n === 1 ? reply : null) });
      const o = op(s.readLines());
      const err = await sr
        .receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items: itemsOf(lines), op: o })
        .then(() => null, (e) => e);
      assert.ok(sr.isShipmentReceivePartialError(err), String(err));
      assert.ok(err instanceof sr.ShipmentReceivePartialError);
      assert.equal(err.completedChunks, 1);
      assert.equal(err.totalChunks, 2);
      assert.equal(err.receivedItems.length, 250);
      assert.deepEqual(err.receivedItems.map((x) => x.shipmentLineItemId), s.calls[0].variables.lineItems.map((x) => x.shipmentLineItemId));
      assert.match(err.causeMessage, label === "在庫が無い" ? /not stocked/ : /exceeds/);
      // 画面の見分けの文に当たらない（代わりの道へ進まない）
      assert.doesNotMatch(err.message, NOT_STOCKED);
      assert.doesNotMatch(err.message, TOO_MANY);
      // 送ったのは 1 つ目のチャンク 1 回と、断られた 2 つ目の 1 回だけ
      assert.equal(s.calls.length, 2);
      const sentTwice = Object.values(lines).filter((l) => l.accepted > 1);
      assert.equal(sentTwice.length, 0);
      assert.equal(Object.values(lines).filter((l) => l.accepted === 1).length, 250);
    });
  }

  it("2 つ目が例外（応答なし）でも別のエラー。@idempotent の返事は idempotencyIssue に残る", async () => {
    const lines = many(260);
    const s1 = fakeShopify({ lines, reply: (n) => (n === 1 ? new Error("timeout 20000ms") : null) });
    const e1 = await sr.receiveShipmentIdempotent({ adminGraphql: s1.adminGraphql, shipmentId: SHIP, items: itemsOf(lines), op: op(s1.readLines()) }).then(() => null, (e) => e);
    assert.ok(sr.isShipmentReceivePartialError(e1));
    assert.match(e1.causeMessage, /timeout/);

    const lines2 = many(260);
    const s2 = fakeShopify({ lines: lines2, reply: (n) => (n === 1 ? userErr("IDEMPOTENCY_KEY_PARAMETER_MISMATCH") : null) });
    const e2 = await sr.receiveShipmentIdempotent({ adminGraphql: s2.adminGraphql, shipmentId: SHIP, items: itemsOf(lines2), op: op(s2.readLines()) }).then(() => null, (e) => e);
    assert.ok(sr.isShipmentReceivePartialError(e2));
    assert.equal(e2.idempotencyIssue, "mismatch");
  });

  it("1 つ目のチャンクの失敗は今までどおりそのまま投げる（まだ何も入っていない）", async () => {
    const lines = many(300);
    const s = fakeShopify({ lines, reply: (n) => (n === 0 ? userErr("INVALID", "Item is not stocked at the destination location") : null) });
    const err = await sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items: itemsOf(lines), op: op(s.readLines()) }).then(() => null, (e) => e);
    assert.ok(err && !sr.isShipmentReceivePartialError(err));
    assert.match(err.message, NOT_STOCKED);
    assert.equal(s.calls.length, 1);
  });

  it("読み直して押し直すと、残りの分だけが新しいキーで入る（1 つ目は二重にならない）", async () => {
    const lines = many(300);
    let failSecond = true;
    const s = fakeShopify({ lines, reply: (n) => (failSecond && n === 1 ? userErr("INVALID", "Item is not stocked at the destination location") : null) });
    const want = 1;
    const run = () => {
      const read = s.readLines();
      const items = read.map((l) => ({ shipmentLineItemId: l.id, quantity: Math.max(0, want - l.acceptedQuantity) }));
      return sr.receiveShipmentIdempotent({ adminGraphql: s.adminGraphql, shipmentId: SHIP, items, op: op(read) });
    };
    await assert.rejects(run(), (e) => sr.isShipmentReceivePartialError(e));
    failSecond = false;
    await run();
    assert.ok(Object.values(lines).every((l) => l.accepted === 1));
  });

  it("分ける前に明細を並べる: 読んだ順が違っても、チャンクの中身とキーが同じ", async () => {
    const lines = many(300);
    const items = itemsOf(lines);
    const shuffled = [...items].reverse();
    const a = fakeShopify({ lines: many(300) });
    const b = fakeShopify({ lines: many(300) });
    const o = op(a.readLines());
    await sr.receiveShipmentIdempotent({ adminGraphql: a.adminGraphql, shipmentId: SHIP, items, op: o });
    await sr.receiveShipmentIdempotent({ adminGraphql: b.adminGraphql, shipmentId: SHIP, items: shuffled, op: o });
    assert.deepEqual(a.calls.map((c) => c.key), b.calls.map((c) => c.key));
    assert.deepEqual(a.calls.map((c) => c.variables.lineItems), b.calls.map((c) => c.variables.lineItems));
    const ids = a.calls.flatMap((c) => c.variables.lineItems.map((x) => x.shipmentLineItemId));
    assert.deepEqual(ids, [...ids].sort());
  });
});

describe("有効化のキー（buildActivateKeyForPos）", () => {
  it("同じ呼び出し・同じ商品・同じ回 → 同じキー。断られた回・置き場所・商品・呼び出しが違えば違うキー", () => {
    const base = { shop: SHOP, operationId: "op-1", locationId: "gid://shopify/Location/2", inventoryItemId: "gid://shopify/InventoryItem/5" };
    const k = buildActivateKeyForPos(base);
    assert.equal(buildActivateKeyForPos(base), k);
    const others = [
      buildActivateKeyForPos({ ...base, rejections: 1 }),
      buildActivateKeyForPos({ ...base, rejections: 2 }),
      buildActivateKeyForPos({ ...base, operationId: "op-2" }),
      buildActivateKeyForPos({ ...base, locationId: "gid://shopify/Location/3" }),
      buildActivateKeyForPos({ ...base, inventoryItemId: "gid://shopify/InventoryItem/6" }),
    ];
    for (const o of others) assert.notEqual(o, k);
    assert.equal(new Set(others).size, others.length);
  });
});

describe("画面の配線（文の照らし合わせ）", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  it("入庫: 8 か所の受け取りすべてで op と段を渡す。有効化のあとは ns1・予定超えは receive_capped・不足は reject", () => {
    const src = read("extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx");
    const calls = src.match(/receiveShipmentWithFallbackV2\(\{[^}]*\}\)/g) ?? [];
    assert.equal(calls.length, 8);
    assert.ok(calls.every((c) => /op: /.test(c) && /stage: "/.test(c)), calls.join("\n"));
    assert.equal(calls.filter((c) => /round: "ns1"/.test(c)).length, 2);
    assert.equal(calls.filter((c) => /stage: "receive_capped"/.test(c)).length, 2);
    assert.equal(calls.filter((c) => /stage: "reject"/.test(c)).length, 2);
    assert.equal((src.match(/buildShipmentReceiveOperation\(\{ kind: INBOUND_RECEIVE_KIND/g) ?? []).length, 2);
  });
  it("入庫: 一部だけ入ったエラー（ShipmentReceivePartialError）は代わりの道より先に見て、入った分を履歴に残してから投げ直す（1 店・多配送）", () => {
    const src = read("extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx");
    // 代わりの道の見分け（在庫が無い）より前に、一部だけのエラーを投げ直す
    const guards = [...src.matchAll(/if \(isShipmentReceivePartialError\(e\)\) throw e;\s*const msg = String\(e\?\.message \|\| e \|\| ""\);\s*const isNotStockedAtDest/g)];
    assert.equal(guards.length, 2, "1 店・多配送の 2 か所");
    assert.match(src, /partialReceiveError = e;\s*receivedItemsForLog = e\.receivedItems \|\| \[\];/);
    assert.match(src, /if \(partialReceiveError\) throw partialReceiveError;\s*\n\s*if \(finalize && rejectedItems\.length > 0\)/);
    assert.match(src, /partialReceiveErrorMulti = e;/);
    assert.match(src, /if \(partialReceiveErrorMulti\) throw partialReceiveErrorMulti;\s*for \(const \[sid, rejItems\] of rejectedByShip\)/);
    // 投げたものは runReceiveWithReload が「読み直しが要る失敗」として伝票を読み直す
    const gate = read("extensions/stock-transfer-inbound/src/receiveReloadGate.js");
    assert.match(gate, /catch \(error\) \{\s*opts\.onSubmitError\?\.\(error\);\s*result = \{ ok: false, reload: true \};/);
    const doc = read("docs/STATE_MACHINE.md");
    assert.match(doc, /入庫の受け取りの 250 分割の途中失敗/);
  });
  it("出庫の全部拒否は outbound_reject_all・段 reject。入庫と出庫で受け取りの部品は 1 つ（重ねて書かない）", () => {
    const tile = read("extensions/stock-transfer-tile/src/ModalOutbound.jsx");
    assert.match(tile, /kind: OUTBOUND_REJECT_ALL_KIND/);
    assert.match(tile, /stage: "reject",/);
    assert.doesNotMatch(tile, /inventoryShipmentReceive(Items)?\(id:/);
    const inbound = read("extensions/stock-transfer-inbound/src/inboundApi.js");
    assert.doesNotMatch(inbound, /inventoryShipmentReceive(Items)?\(id:/);
  });
  it("有効化（入庫）は @idempotent 付き・はっきり断られたら回を増やす・中身の違いは送り直さない", () => {
    const inbound = read("extensions/stock-transfer-inbound/src/inboundApi.js");
    assert.match(inbound, /inventoryActivate\(inventoryItemId: \$inventoryItemId, locationId: \$locationId\) @idempotent\(key: \$idempotencyKey\)/);
    assert.match(inbound, /if \(!concurrent\) rejections\+\+;/);
    assert.match(inbound, /IDEMPOTENCY_KEY_PARAMETER_MISMATCH/);
  });
  it("拡張の版は 2026-01 のまま", () => {
    for (const ext of ["stock-transfer-inbound", "stock-transfer-tile"]) {
      assert.match(read(`extensions/${ext}/shopify.extension.toml`), /api_version = "2026-01"/);
    }
  });
});
