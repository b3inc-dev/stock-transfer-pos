/**
 * 在庫更新で店舗タイムゾーンの読み取りだけが失敗したとき、
 * UTC 日付へ落とさず、回復後の再処理で在庫・履歴を二重に動かさない。
 * Run: node --experimental-strip-types --test tests/shop-history-date.test.mjs
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDateInShopTimezone, readShopTimezone } from "../app/utils/timezone.ts";
import { planInventoryHistoryDate, shopCalendarDate, utcFallbackShiftsShopDate } from "../extensions/common/shopHistoryDate.js";
import { replayCompletedHistory } from "../extensions/common/inventoryLogWrite.js";

/** 日本時間 2026-11-13 00:30。UTC ではまだ 2026-11-12。 */
const TOKYO_BOUNDARY = new Date("2026-11-12T15:30:00.000Z");
/** 太平洋時間 2026-11-12 23:30（PST）。UTC ではすでに 2026-11-13。 */
const PACIFIC_BOUNDARY = new Date("2026-11-13T07:30:00.000Z");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function memoryDb() {
  const rows = [];
  return {
    rows,
    inventoryChangeLog: {
      async upsert({ where, create, update }) {
        const { shop, idempotencyKey } = where.shop_idempotencyKey;
        const idx = rows.findIndex((r) => r.shop === shop && r.idempotencyKey === idempotencyKey);
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...update };
          return rows[idx];
        }
        const row = { id: `log_${rows.length + 1}`, ...create };
        rows.push(row);
        return row;
      },
    },
  };
}

const line = {
  inventoryItemId: "gid://shopify/InventoryItem/101",
  variantId: "gid://shopify/ProductVariant/9",
  sku: "SKU-101",
  delta: -2,
  quantityAfter: 8,
};

describe("UTC fallback shifts the shop calendar date at the boundary", () => {
  it("attributes Asia/Tokyo midnight to the previous UTC date", () => {
    assert.equal(shopCalendarDate(TOKYO_BOUNDARY, "Asia/Tokyo"), getDateInShopTimezone(TOKYO_BOUNDARY, "Asia/Tokyo"));
    assert.equal(getDateInShopTimezone(TOKYO_BOUNDARY, "Asia/Tokyo"), "2026-11-13");
    assert.equal(getDateInShopTimezone(TOKYO_BOUNDARY, "UTC"), "2026-11-12");
    assert.equal(utcFallbackShiftsShopDate(TOKYO_BOUNDARY, "Asia/Tokyo"), true);
  });

  it("attributes a US Pacific late evening to the next UTC date", () => {
    assert.equal(getDateInShopTimezone(PACIFIC_BOUNDARY, "America/Los_Angeles"), "2026-11-12");
    assert.equal(getDateInShopTimezone(PACIFIC_BOUNDARY, "UTC"), "2026-11-13");
    assert.equal(utcFallbackShiftsShopDate(PACIFIC_BOUNDARY, "America/Los_Angeles"), true);
  });

  it("does not shift when the shop calendar date matches UTC", () => {
    const midday = new Date("2026-11-13T03:00:00.000Z");
    assert.equal(getDateInShopTimezone(midday, "Asia/Tokyo"), "2026-11-13");
    assert.equal(utcFallbackShiftsShopDate(midday, "Asia/Tokyo"), false);
    assert.equal(utcFallbackShiftsShopDate(TOKYO_BOUNDARY, "UTC"), false);
  });
});

describe("a failed timezone read is not a UTC shop", () => {
  it("classifies timeout, GraphQL errors, and an empty zone separately from UTC", async () => {
    const timeout = await readShopTimezone({
      graphql: async () => {
        throw new Error("The operation was aborted due to timeout");
      },
    });
    assert.deepEqual(timeout, { ok: false, reason: "request_failed" });

    const graphqlError = await readShopTimezone({
      graphql: async () => jsonResponse(200, { errors: [{ message: "Throttled" }] }),
    });
    assert.equal(graphqlError.ok, false);

    const httpError = await readShopTimezone({
      graphql: async () => jsonResponse(503, { errors: [{ message: "unavailable" }] }),
    });
    assert.deepEqual(httpError, { ok: false, reason: "request_failed" });

    const realUtc = await readShopTimezone({
      graphql: async () => jsonResponse(200, { data: { shop: { ianaTimezone: "UTC" } } }),
    });
    assert.deepEqual(realUtc, { ok: true, timezone: "UTC" });
  });

  it("does not invent a UTC history date when only the timezone read fails", () => {
    const failed = planInventoryHistoryDate({
      phase: "before_inventory",
      read: { ok: false, reason: "request_failed" },
      timestamp: TOKYO_BOUNDARY,
    });
    assert.equal(failed.action, "abort_before_write");
    assert.equal(failed.errorCode, "timezone_unavailable");
    assert.equal("date" in failed, false);

    const after = planInventoryHistoryDate({
      phase: "after_inventory",
      read: { ok: false, reason: "request_failed" },
      timestamp: TOKYO_BOUNDARY,
    });
    assert.equal(after.action, "defer_history");
    assert.equal("date" in after, false);

    const shop = planInventoryHistoryDate({
      phase: "before_inventory",
      read: { ok: true, timezone: "Asia/Tokyo" },
      timestamp: TOKYO_BOUNDARY,
    });
    assert.equal(shop.action, "proceed");
    assert.equal(shop.date, "2026-11-13");
    assert.notEqual(shop.date, getDateInShopTimezone(TOKYO_BOUNDARY, "UTC"));
  });
});

describe("recovery reprocess does not double-apply inventory or history", () => {
  const shop = "demo.myshopify.com";
  const appEventId = "evt_tz_boundary";

  function historyArgs(date) {
    return {
      shop,
      appEventId,
      activity: "inventory_count",
      locationId: "gid://shopify/Location/7",
      locationName: "合成店",
      sourceId: "count_1",
      requestedAt: TOKYO_BOUNDARY,
      date,
      lines: [line],
    };
  }

  /**
   * apply-change と同じ分岐。
   * 在庫未適用で日付が取れなければ Shopify も履歴も書かない。
   * 在庫適用済みなら履歴だけ同じ key で upsert し、在庫は動かさない。
   */
  async function runInventoryUpdate({ db, inventoryWrites, read, alreadyApplied }) {
    const plan = planInventoryHistoryDate({
      phase: alreadyApplied ? "after_inventory" : "before_inventory",
      read,
      timestamp: TOKYO_BOUNDARY,
    });
    if (plan.action !== "proceed") {
      return { inventoryWrites, historyRows: db.rows.length, deferred: plan.action === "defer_history" };
    }
    if (!alreadyApplied) inventoryWrites += 1;
    await replayCompletedHistory(db, historyArgs(plan.date));
    return { inventoryWrites, historyRows: db.rows.length, date: db.rows[0]?.date, deferred: false };
  }

  it("writes the shop date once after the timezone read recovers", async () => {
    const db = memoryDb();
    let inventoryWrites = 0;

    const blocked = await runInventoryUpdate({
      db,
      inventoryWrites,
      read: { ok: false, reason: "request_failed" },
      alreadyApplied: false,
    });
    inventoryWrites = blocked.inventoryWrites;
    assert.equal(blocked.inventoryWrites, 0);
    assert.equal(blocked.historyRows, 0);

    const recovered = await runInventoryUpdate({
      db,
      inventoryWrites,
      read: { ok: true, timezone: "Asia/Tokyo" },
      alreadyApplied: false,
    });
    inventoryWrites = recovered.inventoryWrites;
    assert.equal(recovered.inventoryWrites, 1);
    assert.equal(recovered.historyRows, 1);
    assert.equal(recovered.date, "2026-11-13");
    assert.equal(db.rows[0].delta, -2);
    assert.equal(db.rows[0].quantityAfter, 8);

    const again = await runInventoryUpdate({
      db,
      inventoryWrites,
      read: { ok: true, timezone: "Asia/Tokyo" },
      alreadyApplied: true,
    });
    assert.equal(again.inventoryWrites, 1);
    assert.equal(again.historyRows, 1);
    assert.equal(db.rows[0].id, "log_1");
    assert.equal(db.rows[0].date, "2026-11-13");
    assert.equal(db.rows[0].quantityAfter, 8);
    assert.equal(db.rows[0].delta, -2);
  });

  it("corrects a UTC history date on the same row without a second stock mutation", async () => {
    const db = memoryDb();
    await replayCompletedHistory(db, historyArgs("2026-11-12"));
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].date, "2026-11-12");

    const deferred = planInventoryHistoryDate({
      phase: "after_inventory",
      read: { ok: false, reason: "request_failed" },
      timestamp: TOKYO_BOUNDARY,
    });
    assert.equal(deferred.action, "defer_history");
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].date, "2026-11-12");
    assert.equal(db.rows[0].quantityAfter, 8);

    const plan = planInventoryHistoryDate({
      phase: "after_inventory",
      read: { ok: true, timezone: "Asia/Tokyo" },
      timestamp: TOKYO_BOUNDARY,
    });
    assert.equal(plan.date, "2026-11-13");
    const shopifyCalls = [];
    const corrected = await replayCompletedHistory(db, historyArgs(plan.date));
    assert.equal(shopifyCalls.length, 0);
    assert.equal(corrected.ok, true);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].id, "log_1");
    assert.equal(db.rows[0].date, "2026-11-13");
    assert.equal(db.rows[0].quantityAfter, 8);
    assert.equal(db.rows[0].delta, -2);
  });

  it("apply-change resolves the shop date before creating an event or setting quantities", () => {
    const route = readFileSync(new URL("../app/routes/api.inventory.apply-change.tsx", import.meta.url), "utf8");
    assert.equal(route.includes("getShopTimezone"), false);
    assert.equal(route.includes('.catch(() => "UTC")'), false);
    const guardAt = route.indexOf('errorCode: "timezone_unavailable"');
    const createAt = route.indexOf("inventoryChangeEvent.create");
    const setAt = route.indexOf("await setInventoryQuantitiesServer(");
    assert.ok(guardAt > 0 && createAt > guardAt && setAt > createAt);
    const replayAt = route.indexOf('phase: "after_inventory"');
    assert.ok(replayAt > 0 && replayAt < createAt);
    assert.ok(route.includes("history_incomplete: timezone_unavailable:"));
  });
});
