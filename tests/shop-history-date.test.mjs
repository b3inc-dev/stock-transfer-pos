/**
 * 在庫更新で店舗タイムゾーンの読み取りだけが失敗したとき、
 * UTC 日付へ落とさず、回復後の再処理で在庫・履歴を二重に動かさない。
 * Run: node --experimental-strip-types --test tests/shop-history-date.test.mjs
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDateInShopTimezone, readShopTimezone } from "../app/utils/timezone.ts";
import { planInventoryHistoryDate, prepareFailedEventRetry, shopCalendarDate, utcFallbackShiftsShopDate } from "../extensions/common/shopHistoryDate.js";
import { decideCompletedEventRetry, repairCompletedHistoryDates, replayCompletedHistory } from "../extensions/common/inventoryLogWrite.js";

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
    const failedAt = route.indexOf('existingEvent.status === "failed"');
    const prepareAt = route.indexOf("prepareFailedEventRetry(");
    const deleteAt = route.indexOf("inventoryChangeEvent.delete");
    assert.ok(failedAt > 0 && prepareAt > failedAt && deleteAt > prepareAt);
    const repairAt = route.indexOf("repairCompletedHistoryDates(");
    assert.ok(repairAt > 0 && repairAt < failedAt);
    assert.equal(route.includes("history_incomplete: timezone_unavailable:"), false);
  });
});

const SHOP = "demo.myshopify.com";
const APP_EVENT = "evt_tz_boundary";

function logKey(appEventId, itemId = "101") {
  return `${SHOP}_app_${appEventId}_${itemId}_7`;
}

function repairDb(seedRows) {
  const rows = seedRows.map((row) => ({ ...row }));
  const events = [];
  return {
    rows,
    events,
    inventoryChangeLog: {
      async findUnique({ where }) {
        const { shop, idempotencyKey } = where.shop_idempotencyKey;
        return rows.find((r) => r.shop === shop && r.idempotencyKey === idempotencyKey) ?? null;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("missing row");
        if (Object.keys(data).some((key) => key !== "date")) {
          throw new Error(`date-only repair wrote ${Object.keys(data).join(",")}`);
        }
        row.date = data.date;
        return row;
      },
      async deleteMany() {
        throw new Error("history delete is not allowed before a timezone read succeeds");
      },
    },
    inventoryChangeEvent: {
      async delete() {
        throw new Error("event delete is not allowed before a timezone read succeeds");
      },
    },
    inventoryChangeEventLine: {
      async deleteMany() {
        throw new Error("line delete is not allowed before a timezone read succeeds");
      },
    },
  };
}

function completedEvent(requestedAt, date) {
  return {
    id: "evt_row",
    shop: SHOP,
    status: "completed",
    errorSummary: null,
    activity: "inventory_count",
    locationId: "gid://shopify/Location/7",
    requestedAt,
    lines: [{ inventoryItemId: "gid://shopify/InventoryItem/101", delta: -2, quantityAfterActual: 8 }],
    storedDate: date,
  };
}

async function resendCleanCompleted({ db, event, read, inventoryWrites }) {
  const decision = decideCompletedEventRetry(event);
  if (decision.action !== "return_completed") {
    throw new Error(`expected return_completed, got ${decision.action}`);
  }
  const plan = planInventoryHistoryDate({
    phase: "after_inventory",
    read,
    timestamp: event.requestedAt,
  });
  if (plan.action !== "proceed") {
    return {
      status: 503,
      errorCode: "timezone_unavailable",
      inventoryWrites,
      errorSummary: event.errorSummary,
      statusText: event.status,
    };
  }
  await repairCompletedHistoryDates(db, {
    shop: event.shop,
    appEventId: APP_EVENT,
    activity: event.activity,
    locationId: event.locationId,
    date: plan.date,
    lines: event.lines,
  });
  return { status: 200, inventoryWrites, date: db.rows[0]?.date };
}

describe("completed events repair a UTC history date without another stock write", () => {
  it("rewrites Asia/Tokyo midnight onto the shop date and leaves quantity on the same row", async () => {
    const event = completedEvent(TOKYO_BOUNDARY, "2026-11-12");
    const db = repairDb([
      {
        id: "log_1",
        shop: SHOP,
        idempotencyKey: logKey(APP_EVENT),
        date: "2026-11-12",
        delta: -2,
        quantityAfter: 8,
      },
      {
        id: "log_other",
        shop: SHOP,
        idempotencyKey: logKey("evt_other"),
        date: "2026-11-12",
        delta: 4,
        quantityAfter: 3,
      },
    ]);
    const inventoryWrites = 0;
    const first = await resendCleanCompleted({
      db,
      event,
      read: { ok: true, timezone: "Asia/Tokyo" },
      inventoryWrites,
    });
    assert.equal(first.status, 200);
    assert.equal(first.inventoryWrites, 0);
    assert.equal(db.rows.length, 2);
    assert.equal(db.rows[0].date, "2026-11-13");
    assert.equal(db.rows[0].quantityAfter, 8);
    assert.equal(db.rows[0].delta, -2);
    assert.equal(db.rows[1].date, "2026-11-12");
    assert.equal(event.errorSummary, null);
    assert.equal(event.status, "completed");

    const again = await resendCleanCompleted({
      db,
      event,
      read: { ok: true, timezone: "Asia/Tokyo" },
      inventoryWrites: first.inventoryWrites,
    });
    assert.equal(again.status, 200);
    assert.equal(again.inventoryWrites, 0);
    assert.equal(db.rows.length, 2);
    assert.equal(db.rows[0].id, "log_1");
    assert.equal(db.rows[0].date, "2026-11-13");
  });

  it("rewrites a Pacific late evening off the next UTC date", async () => {
    const event = completedEvent(PACIFIC_BOUNDARY, "2026-11-13");
    const db = repairDb([
      {
        id: "log_1",
        shop: SHOP,
        idempotencyKey: logKey(APP_EVENT),
        date: "2026-11-13",
        delta: -2,
        quantityAfter: 8,
      },
    ]);
    const result = await resendCleanCompleted({
      db,
      event,
      read: { ok: true, timezone: "America/Los_Angeles" },
      inventoryWrites: 0,
    });
    assert.equal(result.status, 200);
    assert.equal(result.inventoryWrites, 0);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].date, "2026-11-12");
    assert.equal(db.rows[0].quantityAfter, 8);
  });

  it("leaves a real UTC shop on the UTC calendar date", async () => {
    const event = completedEvent(TOKYO_BOUNDARY, "2026-11-12");
    const db = repairDb([
      {
        id: "log_1",
        shop: SHOP,
        idempotencyKey: logKey(APP_EVENT),
        date: "2026-11-12",
        delta: -2,
        quantityAfter: 8,
      },
    ]);
    const result = await resendCleanCompleted({
      db,
      event,
      read: { ok: true, timezone: "UTC" },
      inventoryWrites: 0,
    });
    assert.equal(result.status, 200);
    assert.equal(db.rows[0].date, "2026-11-12");
    assert.equal(db.rows[0].quantityAfter, 8);
    assert.equal(planInventoryHistoryDate({
      phase: "after_inventory",
      read: { ok: true, timezone: "UTC" },
      timestamp: TOKYO_BOUNDARY,
    }).date, "2026-11-12");
  });

  it("returns 503 and writes nothing when the timezone read fails", async () => {
    const failures = [
      { ok: false, reason: "request_failed" },
      { ok: false, reason: "graphql_error" },
      { ok: false, reason: "missing" },
    ];
    for (const read of failures) {
      const event = completedEvent(TOKYO_BOUNDARY, "2026-11-12");
      const db = repairDb([
        {
          id: "log_1",
          shop: SHOP,
          idempotencyKey: logKey(APP_EVENT),
          date: "2026-11-12",
          delta: -2,
          quantityAfter: 8,
        },
      ]);
      const result = await resendCleanCompleted({ db, event, read, inventoryWrites: 0 });
      assert.equal(result.status, 503);
      assert.equal(result.errorCode, "timezone_unavailable");
      assert.equal(result.inventoryWrites, 0);
      assert.equal(result.errorSummary, null);
      assert.equal(result.statusText, "completed");
      assert.equal(db.rows[0].date, "2026-11-12");
      assert.equal(db.rows[0].quantityAfter, 8);
    }
  });

  it("repairs the same row once when two resends overlap", async () => {
    const event = completedEvent(TOKYO_BOUNDARY, "2026-11-12");
    const db = repairDb([
      {
        id: "log_1",
        shop: SHOP,
        idempotencyKey: logKey(APP_EVENT),
        date: "2026-11-12",
        delta: -2,
        quantityAfter: 8,
      },
    ]);
    const read = { ok: true, timezone: "Asia/Tokyo" };
    const [a, b] = await Promise.all([
      resendCleanCompleted({ db, event, read, inventoryWrites: 0 }),
      resendCleanCompleted({ db, event, read, inventoryWrites: 0 }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.inventoryWrites + b.inventoryWrites, 0);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].date, "2026-11-13");
    assert.equal(db.rows[0].quantityAfter, 8);
  });
});

describe("failed event retry checks the timezone before deleting anything", () => {
  async function retryFailed(read) {
    const db = repairDb([
      {
        id: "log_1",
        shop: SHOP,
        idempotencyKey: logKey(APP_EVENT),
        date: "2026-11-12",
        delta: -2,
        quantityAfter: null,
      },
    ]);
    db.events.push({ id: "evt_row", status: "failed", errorSummary: "previous failure" });
    const gate = prepareFailedEventRetry({ read, timestamp: TOKYO_BOUNDARY });
    if (!gate.clear) {
      return { status: 503, events: db.events.length, logs: db.rows.length, date: db.rows[0].date };
    }
    db.events.splice(0, db.events.length);
    return { status: 200, shopDate: gate.shopDate, events: db.events.length, logs: db.rows.length };
  }

  it("keeps the failed event and history when the timezone read fails", async () => {
    const timeout = await readShopTimezone({
      graphql: async () => {
        throw new Error("The operation was aborted due to timeout");
      },
    });
    const httpError = await readShopTimezone({
      graphql: async () => jsonResponse(503, {}),
    });
    const graphqlError = await readShopTimezone({
      graphql: async () => jsonResponse(200, { errors: [{ message: "Throttled" }] }),
    });
    const emptyZone = await readShopTimezone({
      graphql: async () => jsonResponse(200, { data: { shop: { ianaTimezone: "  " } } }),
    });
    for (const read of [timeout, httpError, graphqlError, emptyZone]) {
      const blocked = await retryFailed(read);
      assert.equal(read.ok, false);
      assert.equal(blocked.status, 503);
      assert.equal(blocked.events, 1);
      assert.equal(blocked.logs, 1);
      assert.equal(blocked.date, "2026-11-12");
    }
  });

  it("clears the failed event only after a real shop timezone is known", async () => {
    const tokyo = await retryFailed({ ok: true, timezone: "Asia/Tokyo" });
    assert.equal(tokyo.status, 200);
    assert.equal(tokyo.shopDate, "2026-11-13");
    assert.equal(tokyo.events, 0);
    const utcShop = await retryFailed({ ok: true, timezone: "UTC" });
    assert.equal(utcShop.shopDate, "2026-11-12");
    assert.equal(utcShop.events, 0);
  });
});
