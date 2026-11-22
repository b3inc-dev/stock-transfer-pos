/**
 * 棚卸の確定で、書く直前の今の数を changeFromQuantity に入れて書く（#19 の引き継ぎ）。
 * - 読んでから書くまでに売れた・入庫した商品は上書きしない（売上を消さない）
 * - 今の数を読めなければ 0 にせず止める
 * - 既定（ほかの activity）はこれまでどおり changeFromQuantity: null
 * Run: node --experimental-strip-types --test tests/stocktake-compare-and-set.test.mjs
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

const { setInventoryQuantitiesServer, planCompareAndSetChunk } = await import(
  "../app/utils/inventory-set-quantities-server.ts"
);

const gid = (n) => `gid://shopify/InventoryItem/${n}`;
const LOC = "gid://shopify/Location/1";
const CAS = { compareWithLive: true };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Shopify のふり。
 * beforeSet(callNo, stock): set を受け取る直前に呼ぶ（ここで「店で売れた」を起こす）。
 * readFail(itemGid): 応答を返すと、その商品の読み取りはその応答になる。
 * setReply(callNo, input): 応答を返すと、その set はその応答になる（在庫は動かない）。
 */
function fakeShopify({ stock, beforeSet = () => {}, readFail = () => null, setReply = () => null }) {
  const calls = { reads: [], batchReads: [], sets: [] };
  const admin = {
    async graphql(query, opts) {
      const v = opts?.variables ?? {};
      if (query.includes("nodes(ids")) {
        // まとめて読む（compareWithLive）。1 件でも readFail があれば、その応答をそのまま返す
        calls.batchReads.push(v.ids);
        for (const id of v.ids) {
          calls.reads.push(id);
          const failed = readFail(id);
          if (failed) return failed;
        }
        return json({
          data: {
            nodes: v.ids.map((id) =>
              !stock.has(id)
                ? { id, inventoryLevel: null }
                : { id, inventoryLevel: { quantities: [{ name: "available", quantity: stock.get(id) }] } }
            ),
          },
        });
      }
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
        calls.sets.push(v.input.quantities.map((q) => [q.inventoryItemId, q.quantity, q.changeFromQuantity]));
        beforeSet(callNo, stock);
        const reply = setReply(callNo, v.input);
        if (reply) return reply;
        const stale = v.input.quantities.some(
          (q) => q.changeFromQuantity != null && (stock.get(q.inventoryItemId) ?? 0) !== q.changeFromQuantity
        );
        if (stale) {
          return json({
            data: {
              inventorySetQuantities: {
                inventoryAdjustmentGroup: null,
                userErrors: [{ field: ["input"], message: "The quantity has changed.", code: "CHANGE_FROM_QUANTITY_STALE" }],
              },
            },
          });
        }
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

/** 1..n の商品を 10 個ずつにして、すべて 5 個にする棚卸 */
function setup(n, opts = {}) {
  const stock = new Map();
  for (let i = 1; i <= n; i++) stock.set(gid(i), 10);
  const items = Array.from({ length: n }, (_, i) => ({ inventoryItemId: String(i + 1), quantity: 5 }));
  return { stock, items, ...fakeShopify({ stock, ...opts }) };
}

describe("planCompareAndSetChunk", () => {
  const chunk = [
    { inventoryItemId: gid(1), quantity: 5 },
    { inventoryItemId: gid(2), quantity: 7 },
    { inventoryItemId: gid(3), quantity: 0 },
  ];
  it("今の数が目標なら書かない・それ以外は今の数を changeFromQuantity に入れる", () => {
    const live = new Map([[gid(1), 10], [gid(2), 7], [gid(3), 2]]);
    const p = planCompareAndSetChunk(chunk, live);
    assert.deepEqual(p.skipped, [gid(2)]);
    assert.deepEqual(p.conflicts, []);
    assert.deepEqual(p.write, [
      { inventoryItemId: gid(1), quantity: 5, changeFromQuantity: 10 },
      { inventoryItemId: gid(3), quantity: 0, changeFromQuantity: 2 },
    ]);
  });
  it("読み直しで数が変わった商品は conflict（上書きしない）", () => {
    const first = new Map([[gid(1), 10], [gid(2), 9], [gid(3), 2]]);
    const second = new Map([[gid(1), 9], [gid(2), 9], [gid(3), 2]]);
    const p = planCompareAndSetChunk(chunk, second, first);
    assert.deepEqual(p.conflicts, [gid(1)]);
    assert.deepEqual(p.write.map((w) => w.inventoryItemId), [gid(2), gid(3)]);
  });
  it("今の数が読めていない商品は書かない", () => {
    const p = planCompareAndSetChunk(chunk, new Map([[gid(1), 10]]));
    assert.deepEqual(p.conflicts, [gid(2), gid(3)]);
    assert.equal(p.write.length, 1);
  });
});

describe("setInventoryQuantitiesServer: 棚卸の確定（compareWithLive）", () => {
  it("書く直前の今の数を changeFromQuantity に入れて書く", async () => {
    const { admin, calls, items, stock } = setup(3);
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.sets[0], [
      [gid(1), 5, 10],
      [gid(2), 5, 10],
      [gid(3), 5, 10],
    ]);
    assert.equal(stock.get(gid(2)), 5);
    assert.deepEqual(r.appliedInventoryItemIds, [gid(1), gid(2), gid(3)]);
  });

  it("その店に在庫の記録が無い商品は 0 として比べる（有効化の直後）", async () => {
    const { admin, calls, items, stock } = setup(2);
    stock.delete(gid(2));
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.sets[0][1], [gid(2), 5, 0]);
  });

  it("もう目標の数になっている商品は書かず、入った扱いにする", async () => {
    const { admin, calls, items, stock } = setup(2);
    stock.set(gid(2), 5);
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.sets[0], [[gid(1), 5, 10]]);
    assert.deepEqual(r.appliedInventoryItemIds.sort(), [gid(1), gid(2)].sort());
  });

  it("全部もう目標なら 1 回も書かない", async () => {
    const { admin, calls, items, stock } = setup(2);
    stock.set(gid(1), 5);
    stock.set(gid(2), 5);
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, true);
    assert.equal(calls.sets.length, 0);
  });

  it("読んでから書くまでに売れた商品は上書きしない（ほかの商品は書く・一部だけ反映）", async () => {
    const { admin, calls, items, stock } = setup(3, {
      // 1 回目の set の直前に、商品 2 が 1 個売れた
      beforeSet: (callNo, s) => {
        if (callNo === 0) s.set(gid(2), 9);
      },
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, false);
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, false, "はっきりしている（成否不明ではない）");
    assert.deepEqual(r.concurrentChangedInventoryItemIds, [gid(2)]);
    assert.deepEqual(r.appliedInventoryItemIds, [gid(1), gid(3)]);
    assert.match(r.error, /CHANGE_FROM_QUANTITY_STALE/);
    assert.equal(stock.get(gid(2)), 9, "売れた分を消さない（5 に上書きしない）");
    assert.equal(stock.get(gid(1)), 5);
    assert.equal(stock.get(gid(3)), 5);
    assert.equal(calls.sets.length, 2);
    assert.deepEqual(calls.sets[1], [
      [gid(1), 5, 10],
      [gid(3), 5, 10],
    ]);
  });

  it("2 回続けて断られたら、そのチャンクは書かずに失敗（1 チャンク目なら在庫は動いていない）", async () => {
    const { admin, calls, items, stock } = setup(1, {
      // 読み直しても同じ数なのに、毎回 STALE で断られる（ほかで動き続けている・戻ってきた）
      setReply: () =>
        json({
          data: {
            inventorySetQuantities: {
              inventoryAdjustmentGroup: null,
              userErrors: [{ field: ["input"], message: "stale", code: "CHANGE_FROM_QUANTITY_STALE" }],
            },
          },
        }),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, false);
    assert.notEqual(r.partiallyApplied, true);
    assert.deepEqual(r.appliedInventoryItemIds, []);
    assert.equal(calls.sets.length, 2, "読み直して 1 回だけ書き直す");
    assert.equal(stock.get(gid(1)), 10);
  });

  it("今の数を読めなければ、0 にせず 1 件も書かずに止める（送り直してよい）", async () => {
    const { admin, calls, items, stock } = setup(3, {
      readFail: (id) => (id === gid(2) ? throttled() : null),
    });
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, false);
    assert.equal(r.liveUnreadable, true);
    assert.equal(r.retryable, true);
    assert.equal(calls.sets.length, 0);
    assert.equal(stock.get(gid(2)), 10);
  });

  it("251 件以上: 2 チャンク目で読めなければ、1 チャンク目で書いた分だけを戻す（書かなかった商品は戻さない）", async () => {
    let readsOf251 = 0;
    const { admin, calls, items, stock } = setup(251, {
      readFail: (id) => {
        if (id !== gid(251)) return null;
        readsOf251 += 1;
        return throttled();
      },
    });
    stock.set(gid(1), 5); // もう目標（書かない）
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.ok(readsOf251 >= 1);
    // 前に進む書き込み 1 回 + 戻す書き込み 1 回
    assert.equal(calls.sets.length, 2);
    const rollback = calls.sets[1];
    assert.equal(rollback.length, 249, "書いた 249 件だけを戻す");
    assert.ok(!rollback.some(([id]) => id === gid(1)), "書かなかった商品は戻さない");
    assert.equal(stock.get(gid(2)), 10);
    assert.equal(stock.get(gid(1)), 5);
  });

  it("251 件以上で 2 チャンク目がはっきり断られて戻すのに失敗したら、入ったままの分だけ「入った」と言う", async () => {
    const { admin, items, stock } = setup(251, {
      setReply: (callNo) => {
        if (callNo === 1) return userErrors("Quantity is invalid");
        if (callNo === 2) return userErrors("refused");
        return null;
      },
    });
    stock.set(gid(1), 5);
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.partiallyApplied, true);
    assert.equal(r.applicationUncertain, false);
    assert.equal(r.appliedInventoryItemIds.length, 250);
  });

  it("今の数は 50 件ずつまとめて読む（1 件ずつ読まない）", async () => {
    const { admin, calls, items } = setup(120);
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.batchReads.map((b) => b.length), [50, 50, 20]);
  });

  it("まとめて読んだ応答で商品が見つからない（null）ときは、送り直しても同じなので retryable ではない", async () => {
    const { admin, calls, items } = setup(2);
    admin.graphql = (orig => async (q, o) => {
      if (q.includes("nodes(ids")) return json({ data: { nodes: [null, null] } });
      return orig(q, o);
    })(admin.graphql.bind(admin));
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.liveUnreadable, true);
    assert.equal(r.retryable, false);
    assert.equal(calls.sets.length, 0);
  });

  it("まとめて読んだ応答の数が足りないときは読めなかった扱い（0 にしない）", async () => {
    const { admin, calls, items } = setup(2);
    admin.graphql = (orig => async (q, o) => {
      if (q.includes("nodes(ids")) return json({ data: { nodes: [] } });
      return orig(q, o);
    })(admin.graphql.bind(admin));
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null, CAS);
    assert.equal(r.liveUnreadable, true);
    assert.equal(r.retryable, true);
    assert.equal(calls.sets.length, 0);
  });

  it("既定（compareWithLive なし）はこれまでどおり changeFromQuantity: null で、今の数を読まない", async () => {
    const { admin, calls, items } = setup(3);
    const r = await setInventoryQuantitiesServer(admin, LOC, items, null);
    assert.equal(r.ok, true);
    assert.equal(calls.reads.length, 0);
    assert.ok(calls.sets[0].every(([, , cf]) => cf === null));
  });
});

describe("apply-change: 棚卸だけ compareWithLive", () => {
  const src = readFileSync(new URL("../app/routes/api.inventory.apply-change.tsx", import.meta.url), "utf8");
  it("inventory_count のときだけ compareWithLive を渡す", () => {
    assert.match(src, /compareWithLive:\s*activity === "inventory_count"/);
  });
  it("setInventoryQuantitiesServer の 3 か所（最初・not stocked の再試行・一時エラーの再試行）すべてに渡す", () => {
    // 3 か所は @idempotent の回（main・ns1・tr1）が違う（tests/apply-change-idempotency.test.mjs）
    const calls =
      src.match(/setInventoryQuantitiesServer\(\s*admin,\s*locationId,\s*shopifyItems,\s*refUri(,\s*setOptions\("[a-z0-9]+"\))?\s*\)/g) ?? [];
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.includes("setOptions(")));
  });
  it("書く直前に読めなかったときは current_quantity_unreadable（503・在庫は動いていない）", () => {
    assert.match(src, /liveUnreadable\s*\n?\s*\? "current_quantity_unreadable"/);
  });
});
