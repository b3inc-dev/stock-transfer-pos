/**
 * 250 件を超える在庫の補正（inventorySetQuantities をチャンクに分けて送る）の「元に戻す用の控え」。
 * - 控えの数を読めないと、補正を始めない（在庫を 1 件も動かさない・送り直してよい失敗）
 * - 251 件以上で、あとのチャンクがはっきり断られても、先のチャンクの商品が 0 に書き換わらない
 * - 戻す処理そのものが失敗したら「一部だけ反映」にし、戻せた分を「入った」と言わない
 * Run: node --experimental-strip-types --test tests/inventory-set-quantities-rollback.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

// app/utils の .ts は拡張子なしで import し合う。テストのときだけ .ts を補う。
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

const { setInventoryQuantitiesServer, fetchCurrentQuantityServer } = await import(
  "../app/utils/inventory-set-quantities-server.ts"
);

const gid = (n) => `gid://shopify/InventoryItem/${n}`;
const LOC = "gid://shopify/Location/1";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Shopify のふり。stock: 商品 GID → 今の数（無い商品は「その店に在庫の記録が無い」）。
 * readFail(itemGid) が応答を返すと、その商品の読み取りはその応答になる。
 * setReply(callNo, input) が応答を返すと、その set はその応答になる（在庫は動かない）。
 */
function fakeShopify({ stock, readFail = () => null, setReply = () => null }) {
  const calls = { reads: [], sets: [] };
  const admin = {
    async graphql(query, opts) {
      const v = opts?.variables ?? {};
      if (query.includes("inventoryLevel(locationId")) {
        calls.reads.push(v.id);
        const failed = readFail(v.id);
        if (failed) return failed;
        if (!stock.has(v.id)) return json({ data: { inventoryItem: { inventoryLevel: null } } });
        return json({
          data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "available", quantity: stock.get(v.id) }] } } },
        });
      }
      if (query.includes("inventorySetQuantities")) {
        const callNo = calls.sets.length;
        calls.sets.push(v.input.quantities.map((q) => [q.inventoryItemId, q.quantity]));
        const reply = setReply(callNo, v.input);
        if (reply) return reply;
        for (const q of v.input.quantities) stock.set(q.inventoryItemId, q.quantity);
        return json({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "g" }, userErrors: [] } } });
      }
      throw new Error("unexpected query");
    },
  };
  return { admin, calls };
}

const userErrors = (message) =>
  json({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ["input"], message }] } } });
const throttled = () => json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });

/** 1..n の商品を、それぞれ 10 個ある状態にして、すべて 5 個にする補正 */
function setup(n, opts = {}) {
  const stock = new Map();
  for (let i = 1; i <= n; i++) stock.set(gid(i), 10);
  const items = Array.from({ length: n }, (_, i) => ({ inventoryItemId: String(i + 1), quantity: 5 }));
  const fake = fakeShopify({ stock, ...opts });
  return { stock, items, ...fake };
}

describe("setInventoryQuantitiesServer: 元に戻す用の控え", () => {
  it("250 件以下は戻すことが無いので、控えを読まずに 1 回で入れる", async () => {
    const { admin, calls, items, stock } = setup(250);
    const r = await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(r.ok, true);
    assert.equal(calls.reads.length, 0);
    assert.equal(calls.sets.length, 1);
    assert.equal(stock.get(gid(1)), 5);
  });

  it("251 件以上は、1 件も動かす前に、最後より前のチャンクの数を控える", async () => {
    const { admin, calls, items } = setup(251);
    const r = await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(r.ok, true);
    assert.equal(calls.reads.length, 250);
    assert.equal(calls.sets.length, 2);
  });

  it("控えの数を読めない（HTTP 200 の GraphQL errors）と、補正を始めない（送り直してよい失敗）", async () => {
    const { admin, calls, items, stock } = setup(251, {
      readFail: (id) => (id === gid(7) ? throttled() : null),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(r.ok, false);
    assert.equal(r.snapshotUnreadable, true);
    assert.equal(r.retryable, true);
    assert.equal(r.partiallyApplied, undefined);
    assert.deepEqual(r.appliedInventoryItemIds, []);
    assert.equal(calls.sets.length, 0, "在庫を 1 件も動かさない");
    assert.equal(stock.get(gid(7)), 10);
    assert.equal(stock.get(gid(251)), 10);
  });

  it("控えの数を読めない（HTTP 失敗・available 無し・例外）でも補正を始めない", async () => {
    for (const fail of [
      () => json({}, 400),
      () => json({ data: { inventoryItem: { inventoryLevel: { quantities: [] } } } }),
      () => {
        throw new Error("network down");
      },
    ]) {
      const { admin, calls, items } = setup(251, { readFail: (id) => (id === gid(3) ? fail() : null) });
      const r = await setInventoryQuantitiesServer(admin, LOC, items);
      assert.equal(r.ok, false);
      assert.equal(r.snapshotUnreadable, true);
      assert.equal(r.retryable, true);
      assert.equal(calls.sets.length, 0);
    }
  });

  it("商品が見つからない（inventoryItem が null）ときは送り直しても同じなので retryable ではない", async () => {
    const { admin, calls, items } = setup(251, {
      readFail: (id) => (id === gid(3) ? json({ data: { inventoryItem: null } }) : null),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(r.snapshotUnreadable, true);
    assert.equal(r.retryable, false);
    assert.equal(calls.sets.length, 0);
  });

  it("251 件以上で控えが読めなくても、あとのチャンクが断られて商品が 0 に書き換わることはない", async () => {
    const { admin, items, stock } = setup(251, {
      readFail: (id) => (id === gid(7) ? throttled() : null),
      setReply: (callNo) => (callNo === 1 ? userErrors("Quantity is invalid") : null),
    });
    await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(stock.get(gid(7)), 10, "0 にならない");
    for (let i = 1; i <= 251; i++) assert.notEqual(stock.get(gid(i)), 0);
  });

  it("251 件以上で、あとのチャンクがはっきり断られたら、先のチャンクを控えた数へ戻す", async () => {
    const { admin, items, stock } = setup(251, {
      setReply: (callNo) => (callNo === 1 ? userErrors("Quantity is invalid") : null),
    });
    stock.set(gid(7), 42);
    stock.delete(gid(8)); // その店に在庫の記録が無い商品（控えは 0 でよい）
    const r = await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.deepEqual(r.appliedInventoryItemIds, []);
    assert.equal(stock.get(gid(1)), 10);
    assert.equal(stock.get(gid(7)), 42);
    assert.equal(stock.get(gid(8)), 0);
  });

  it("戻す処理が応答不明で失敗したら、一部だけ反映（不明）にし、戻せた分を「入った」と言わない", async () => {
    // 3 チャンク: 0・1 は入る → 2 が断られる → 1 は戻せる → 0 を戻すときに混雑（HTTP 200 の errors）
    const { admin, items, stock } = setup(501, {
      setReply: (callNo) => {
        if (callNo === 2) return userErrors("Quantity is invalid");
        if (callNo === 4) return throttled();
        return null;
      },
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, false);
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, true);
    assert.deepEqual(r.appliedInventoryItemIds, [], "チャンク 0 は戻ったか分からない・チャンク 1 は戻せた");
    assert.equal(stock.get(gid(251)), 10, "チャンク 1 は戻っている");
    assert.equal(stock.get(gid(1)), 5, "チャンク 0 は入ったまま（ふりの Shopify では動かない）");
  });

  it("戻す処理がはっきり断られたら、そのチャンクは入ったままとして返す（不明ではない）", async () => {
    const { admin, items } = setup(501, {
      setReply: (callNo) => {
        if (callNo === 2) return userErrors("Quantity is invalid");
        if (callNo === 4) return userErrors("Rollback refused");
        return null;
      },
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items);
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, false);
    assert.equal(r.appliedInventoryItemIds.length, 250);
    assert.equal(r.appliedInventoryItemIds[0], gid(1));
    assert.ok(!r.appliedInventoryItemIds.includes(gid(251)), "戻せたチャンク 1 は入れない");
  });
});

describe("fetchCurrentQuantityServer（同じ読み方）", () => {
  it("記録が無いときだけ 0、読めないときは 0 にしない", async () => {
    const { admin } = fakeShopify({
      stock: new Map([[gid(1), 3]]),
      readFail: (id) => (id === gid(2) ? throttled() : null),
    });
    assert.deepEqual(await fetchCurrentQuantityServer(admin, LOC, "1"), { ok: true, quantity: 3 });
    assert.equal((await fetchCurrentQuantityServer(admin, LOC, "2")).ok, false);
    assert.deepEqual(await fetchCurrentQuantityServer(admin, LOC, "9"), { ok: true, quantity: 0 });
  });
});

describe("apply-change route", () => {
  const route = readFileSync(new URL("../app/routes/api.inventory.apply-change.tsx", import.meta.url), "utf8");

  it("控えを読めなかったときは 503（送り直してよい）で返し、イベントは failed（次の送信で最初から処理）", () => {
    assert.match(route, /rollback_snapshot_unreadable/);
    assert.match(route, /status: snapshotRetryable \? 503 : 400/);
    const start = route.indexOf("const snapshotUnreadable = result.snapshotUnreadable === true;");
    const failedUpdate = route.indexOf('data: { status: "failed", errorSummary }', start);
    assert.ok(start > 0 && failedUpdate > start);
  });
});
