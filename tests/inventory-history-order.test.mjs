/**
 * 監査 P1-2: inventory_levels/update が逆の順で届いても、在庫履歴の差分を取り違えない。
 * 10 → A(8) → B(7) が B, A の順に届いても A=-2・B=-1 になること。
 *
 * 本番と同じ app/utils/inventory-history-order.ts（findPreviousQuantity / repairSuccessorDelta）を、
 * Prisma の where を最小限まねたメモリの DB で動かす。ルートの .tsx は vite が無いと読めないため、
 * ルートの主な経路（前の数量 → 差分 → 保存 → 後ろの行の補正）を同じ順で呼ぶ。
 * Run: node --experimental-strip-types --test tests/inventory-history-order.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findPreviousQuantity,
  planSuccessorDelta,
  repairSuccessorDelta,
} from "../app/utils/inventory-history-order.ts";

const SHOP = "demo.myshopify.com";
const scope = {
  shop: SHOP,
  inventoryItemIds: ["11", "gid://shopify/InventoryItem/11"],
  locationIds: ["22", "gid://shopify/Location/22"],
};

function matches(row, where) {
  for (const [key, cond] of Object.entries(where)) {
    const v = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(v)) return false;
      if ("lt" in cond && !(new Date(v) < new Date(cond.lt))) return false;
      if ("gt" in cond && !(new Date(v) > new Date(cond.gt))) return false;
      if ("not" in cond && (cond.not === null ? v == null : v === cond.not)) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

function memoryDb(seed = []) {
  const rows = seed.map((r, i) => ({ id: `seed_${i}`, ...r }));
  return {
    rows,
    inventoryChangeLog: {
      async findFirst({ where, orderBy }) {
        const dir = orderBy?.timestamp === "asc" ? 1 : -1;
        const hit = rows
          .filter((r) => matches(r, where))
          .sort((a, b) => dir * (new Date(a.timestamp) - new Date(b.timestamp)));
        return hit[0] ?? null;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("missing row");
        return Object.assign(row, data);
      },
      async create({ data }) {
        if (rows.some((r) => r.shop === data.shop && r.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("dup"), { code: "P2002" });
        }
        const row = { id: `log_${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    },
  };
}

const T0 = "2026-01-04T01:00:00Z";
const TA = "2026-01-04T02:00:00Z";
const TB = "2026-01-04T02:00:10Z";
const baseline = { shop: SHOP, inventoryItemId: "11", locationId: "22", activity: "admin_webhook", timestamp: new Date(T0), delta: null, quantityAfter: 10, idempotencyKey: "base" };

/** ルートの主な経路と同じ順: 前の数量（時刻より前）→ 差分 → 同じキーなら何もしない → 保存 → 後ろの行の補正 */
async function notify(db, { available, updatedAt }) {
  const observedAt = new Date(updatedAt);
  const idempotencyKey = `${SHOP}:11:22:${observedAt.toISOString()}`;
  if (db.rows.some((r) => r.idempotencyKey === idempotencyKey)) return "duplicate";
  const { prevAvailable } = await findPreviousQuantity(db, scope, observedAt);
  const delta = prevAvailable === null ? null : available - prevAvailable;
  if (delta === 0) return "no_change";
  await db.inventoryChangeLog.create({
    data: { shop: SHOP, inventoryItemId: "11", locationId: "22", activity: "admin_webhook", timestamp: observedAt, delta, quantityAfter: available, idempotencyKey },
  });
  await repairSuccessorDelta(db, scope, observedAt, available);
  return "saved";
}

function chronological(db) {
  return [...db.rows]
    .filter((r) => r.idempotencyKey !== "base")
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map((r) => ({ quantity: r.quantityAfter, delta: r.delta }));
}

describe("inventory history deltas follow the notification time, not the arrival order", () => {
  it("in order: 10 → A(8) → B(7) gives A=-2, B=-1 (unchanged behaviour)", async () => {
    const db = memoryDb([baseline]);
    await notify(db, { available: 8, updatedAt: TA });
    await notify(db, { available: 7, updatedAt: TB });
    assert.deepEqual(chronological(db), [{ quantity: 8, delta: -2 }, { quantity: 7, delta: -1 }]);
  });

  it("reversed: B arrives before A → still A=-2, B=-1", async () => {
    const db = memoryDb([baseline]);
    await notify(db, { available: 7, updatedAt: TB });
    assert.deepEqual(chronological(db), [{ quantity: 7, delta: -3 }], "A を知らない間は 10→7");
    await notify(db, { available: 8, updatedAt: TA });
    assert.deepEqual(chronological(db), [{ quantity: 8, delta: -2 }, { quantity: 7, delta: -1 }]);
  });

  it("#64 scenario: A fails (503, not saved), B saved, A resent twice → A=-2, B=-1, one row each", async () => {
    const db = memoryDb([baseline]);
    // A は読み取り失敗で保存されない（#64 の 503）。B が先に保存される。
    await notify(db, { available: 7, updatedAt: TB });
    assert.equal(await notify(db, { available: 8, updatedAt: TA }), "saved");
    assert.equal(await notify(db, { available: 8, updatedAt: TA }), "duplicate");
    assert.deepEqual(chronological(db), [{ quantity: 8, delta: -2 }, { quantity: 7, delta: -1 }]);
  });

  it("three notifications in any arrival order give the same deltas", async () => {
    const events = [
      { available: 8, updatedAt: "2026-01-04T02:00:00Z" },
      { available: 7, updatedAt: "2026-01-04T02:00:10Z" },
      { available: 12, updatedAt: "2026-01-04T02:00:20Z" },
    ];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1], [1, 2, 0], [0, 2, 1]];
    for (const order of orders) {
      const db = memoryDb([baseline]);
      for (const i of order) await notify(db, events[i]);
      assert.deepEqual(
        chronological(db),
        [{ quantity: 8, delta: -2 }, { quantity: 7, delta: -1 }, { quantity: 12, delta: 5 }],
        `order ${order.join(",")}`
      );
    }
  });

  it("a late notification does not rewrite a business row's delta (sales / loss keep their own quantity)", async () => {
    const db = memoryDb([
      baseline,
      { shop: SHOP, inventoryItemId: "gid://shopify/InventoryItem/11", locationId: "gid://shopify/Location/22", activity: "order_sales", timestamp: new Date(TB), delta: -1, quantityAfter: 7, idempotencyKey: "sale" },
    ]);
    await notify(db, { available: 8, updatedAt: TA });
    const sale = db.rows.find((r) => r.idempotencyKey === "sale");
    assert.equal(sale.delta, -1, "売上の行は注文数のまま");
    const a = db.rows.find((r) => r.quantityAfter === 8);
    assert.equal(a.delta, -2);
  });

  it("does not touch a successor whose quantity is not decided yet (null)", async () => {
    const db = memoryDb([
      baseline,
      { shop: SHOP, inventoryItemId: "11", locationId: "22", activity: "admin_webhook", timestamp: new Date(TB), delta: null, quantityAfter: null, idempotencyKey: "pending" },
    ]);
    await notify(db, { available: 8, updatedAt: TA });
    assert.equal(db.rows.find((r) => r.idempotencyKey === "pending").delta, null);
  });

  it("only the immediate successor is recomputed; rows further back stay as they are", async () => {
    const db = memoryDb([baseline]);
    await notify(db, { available: 7, updatedAt: TB });
    await notify(db, { available: 12, updatedAt: "2026-01-04T02:00:20Z" });
    const before12 = db.rows.find((r) => r.quantityAfter === 12).delta;
    await notify(db, { available: 8, updatedAt: TA });
    assert.equal(db.rows.find((r) => r.quantityAfter === 12).delta, before12);
    assert.equal(before12, 5);
  });

  it("planSuccessorDelta: rewrites only admin_webhook rows with a known quantity and a different delta", () => {
    assert.equal(planSuccessorDelta({ id: "x", timestamp: TB, activity: "admin_webhook", delta: -3, quantityAfter: 7 }, 8), -1);
    assert.equal(planSuccessorDelta({ id: "x", timestamp: TB, activity: "admin_webhook", delta: -1, quantityAfter: 7 }, 8), null);
    assert.equal(planSuccessorDelta({ id: "x", timestamp: TB, activity: "loss_entry", delta: -3, quantityAfter: 7 }, 8), null);
    assert.equal(planSuccessorDelta({ id: "x", timestamp: TB, activity: "admin_webhook", delta: -3, quantityAfter: null }, 8), null);
    assert.equal(planSuccessorDelta(null, 8), null);
    assert.equal(planSuccessorDelta({ id: "x", timestamp: TB, activity: "admin_webhook", delta: -3, quantityAfter: 7 }, null), null);
  });

  it("the webhook route looks up the previous row only before the notification time and repairs after saving", () => {
    const route = readFileSync(new URL("../app/routes/webhooks.inventory_levels.update.tsx", import.meta.url), "utf8");
    assert.ok(route.includes("findPreviousQuantity("));
    // 時刻の条件の無い「いちばん新しい行」の検索が残っていないこと
    assert.equal(route.includes("const prevLog = await db.inventoryChangeLog.findFirst"), false);
    assert.equal(route.includes("const prevLogWithQty = await db.inventoryChangeLog.findFirst"), false);
    const createAt = route.indexOf("await db.inventoryChangeLog.create(");
    const repairAt = route.indexOf("await repairSuccessorAfter(updatedAt)");
    assert.ok(createAt > 0 && repairAt > createAt);
  });
});
