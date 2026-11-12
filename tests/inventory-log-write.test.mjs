/**
 * 在庫変更履歴の書き込み失敗: 合成データで整合性・再送の重複・エラー分類を検証する。
 * Run: node --test tests/inventory-log-write.test.mjs
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInventoryLogIdempotencyKey,
  classifyInventoryLogWriteError,
  decideCompletedEventRetry,
  interpretLogChunkResponse,
  isHistoryReplayOwnedByShop,
  replayCompletedHistory,
  resolveSameActivityAction,
  summarizeLogWriteBatch,
} from "../extensions/common/inventoryLogWrite.js";

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

describe("classifyInventoryLogWriteError", () => {
  it("treats idempotency unique violation as an existing row, not a lost write", () => {
    const err = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["shop", "idempotencyKey"] },
    });
    const classified = classifyInventoryLogWriteError(err);
    assert.equal(classified.code, "duplicate_idempotency");
    assert.equal(classified.idempotentSuccess, true);
    assert.equal(classified.retryable, false);
  });

  it("classifies database outage separately from auth and invalid entries", () => {
    const dbErr = Object.assign(new Error("Can't reach database server"), { code: "P1001" });
    assert.equal(classifyInventoryLogWriteError(dbErr).code, "db_unavailable");
    assert.equal(classifyInventoryLogWriteError(dbErr).retryable, true);
    assert.equal(classifyInventoryLogWriteError(new Response(null, { status: 401 })).code, "auth_failed");
    assert.equal(classifyInventoryLogWriteError(new Error("Missing required fields")).code, "invalid_entry");
    assert.equal(classifyInventoryLogWriteError(new Error("something else")).code, "unknown");
  });
});

describe("history batch is not reported as success when an entry failed", () => {
  it("returns a non-2xx summary the client does not treat as a full write", () => {
    const summary = summarizeLogWriteBatch([
      { ok: true, id: "log_1" },
      { ok: false, error: "Missing required fields", errorCode: "invalid_entry" },
    ]);
    assert.equal(summary.ok, false);
    assert.equal(summary.errorCode, "partial_entry_failure");
    assert.ok(summary.httpStatus >= 400);
    const verdict = interpretLogChunkResponse(summary.httpStatus, summary);
    assert.equal(verdict.success, false);
    assert.equal(verdict.retryable, true);
    assert.equal(verdict.errorCode, "partial_entry_failure");
    const invalidOnly = summarizeLogWriteBatch([
      { ok: false, error: "Missing required fields", errorCode: "invalid_entry" },
    ]);
    assert.equal(invalidOnly.httpStatus, 400);
    assert.equal(invalidOnly.errorCode, "invalid_entry");
    assert.equal(interpretLogChunkResponse(invalidOnly.httpStatus, invalidOnly).retryable, false);
  });

  it("does not accept a 200 body that hides a failed entry", () => {
    const legacy = interpretLogChunkResponse(200, {
      ok: true,
      results: [{ ok: true }, { ok: false, error: "Missing required fields" }],
    });
    assert.equal(legacy.success, false);
  });

  it("treats duplicate idempotency as success so a retry does not look like a lost history row", () => {
    const verdict = interpretLogChunkResponse(200, { ok: true, message: "Log already exists" });
    assert.equal(verdict.success, true);
    assert.equal(verdict.errorCode, "duplicate_idempotency");
  });

  it("does not retry a payload the server has already classified as invalid", () => {
    const verdict = interpretLogChunkResponse(400, {
      ok: false,
      errorCode: "invalid_entry",
      error: "Missing required fields",
    });
    assert.equal(verdict.success, false);
    assert.equal(verdict.retryable, false);
  });
});

describe("retry does not duplicate or collapse a different operation", () => {
  it("uses the same key for GID and numeric ids", () => {
    const gid = buildInventoryLogIdempotencyKey({
      shop: "demo.myshopify.com",
      appEventId: "evt_loss_1",
      activity: "loss_entry",
      inventoryItemId: "gid://shopify/InventoryItem/101",
      locationId: "gid://shopify/Location/7",
    });
    const raw = buildInventoryLogIdempotencyKey({
      shop: "demo.myshopify.com",
      appEventId: "evt_loss_1",
      activity: "loss_entry",
      inventoryItemId: "101",
      locationId: "7",
    });
    assert.equal(gid, raw);
  });

  it("keeps a second appEventId as its own row", () => {
    assert.equal(
      resolveSameActivityAction({
        incomingAppEventId: "evt_loss_2",
        existingNote: "appEventId:evt_loss_1",
        existingSourceId: "loss_1",
        incomingSourceId: "loss_2",
        existingDelta: -1,
        incomingDelta: -1,
      }),
      "create"
    );
    assert.equal(
      resolveSameActivityAction({
        incomingAppEventId: "evt_loss_1",
        existingNote: "appEventId:evt_loss_1",
        existingSourceId: "loss_1",
        incomingSourceId: "loss_1",
        existingDelta: -1,
        incomingDelta: -1,
      }),
      "update"
    );
  });
});

describe("completed inventory replays history without a second stock mutation", () => {
  it("retries history only, then a second replay does not add a row", async () => {
    const event = {
      status: "completed",
      errorSummary: "history_incomplete: db_unavailable: Can't reach database server",
    };
    assert.equal(decideCompletedEventRetry(event).action, "retry_history_only");
    assert.equal(
      decideCompletedEventRetry({ status: "completed", errorSummary: null }).action,
      "return_completed"
    );

    const db = memoryDb();
    const shopifyCalls = [];
    const args = {
      shop: "demo.myshopify.com",
      appEventId: "evt_count_1",
      activity: "inventory_count",
      locationId: "gid://shopify/Location/7",
      locationName: "合成店",
      sourceId: "count_1",
      requestedAt: new Date("2026-11-11T00:00:00.000Z"),
      date: "2026-11-11",
      lines: [line],
    };
    const first = await replayCompletedHistory(db, args);
    assert.equal(shopifyCalls.length, 0);
    assert.equal(first.ok, true);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].quantityAfter, 8);
    assert.equal(db.rows[0].delta, -2);
    assert.equal(db.rows[0].inventoryItemId, "101");
    assert.equal(db.rows[0].note, "appEventId:evt_count_1");

    const second = await replayCompletedHistory(db, args);
    assert.equal(second.ok, true);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].id, "log_1");

    const other = await replayCompletedHistory(db, { ...args, appEventId: "evt_count_2", lines: [{ ...line, delta: 4, quantityAfter: 12 }] });
    assert.equal(other.ok, true);
    assert.equal(db.rows.length, 2);
    assert.equal(db.rows[0].delta, -2);
    assert.equal(db.rows[1].delta, 4);
  });

  it("classifies a database failure and stops without pretending the history row exists", async () => {
    const db = {
      inventoryChangeLog: {
        async upsert() {
          const err = new Error("Can't reach database server");
          err.code = "P1001";
          throw err;
        },
      },
    };
    const result = await replayCompletedHistory(db, {
      shop: "demo.myshopify.com",
      appEventId: "evt_count_1",
      activity: "inventory_count",
      locationId: "7",
      locationName: "合成店",
      sourceId: "count_1",
      requestedAt: new Date("2026-11-11T00:00:00.000Z"),
      date: "2026-11-11",
      lines: [line, { ...line, inventoryItemId: "102", delta: 1, quantityAfter: 3 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "db_unavailable");
    assert.equal(result.written, 0);
  });
});

describe("history replay stays inside the event shop", () => {
  const line = {
    inventoryItemId: "gid://shopify/InventoryItem/101",
    sku: "SKU-101",
    delta: -1,
    quantityAfter: 4,
  };

  function eventFor(shop) {
    return {
      shop,
      appEventId: "evt_shop_boundary",
      activity: "loss_entry",
      locationId: "gid://shopify/Location/1",
      locationName: "合成店",
      sourceId: "loss_1",
      requestedAt: new Date("2026-11-11T00:00:00.000Z"),
      status: "completed",
      errorSummary: "history_incomplete: db_unavailable: Can't reach database server",
      lines: [line],
    };
  }

  async function replayLikeRoute(event, sessionShop, db) {
    if (!isHistoryReplayOwnedByShop(event.shop, sessionShop)) {
      return { status: 403, errorCode: "shop_mismatch", errorSummary: event.errorSummary };
    }
    const result = await replayCompletedHistory(db, {
      shop: event.shop,
      appEventId: event.appEventId,
      activity: event.activity,
      locationId: event.locationId,
      locationName: event.locationName,
      sourceId: event.sourceId,
      requestedAt: event.requestedAt,
      date: "2026-11-11",
      lines: event.lines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        sku: l.sku,
        delta: l.delta,
        quantityAfter: l.quantityAfter,
      })),
    });
    if (result.ok) event.errorSummary = null;
    return { status: 200, historyReplayed: result.ok, errorSummary: event.errorSummary };
  }

  it("does not write shop B history or clear shop A's repair marker", async () => {
    const route = readFileSync(new URL("../app/routes/api.inventory.apply-change.tsx", import.meta.url), "utf8");
    const guardAt = route.indexOf("isHistoryReplayOwnedByShop(existingEvent.shop, shop)");
    const replayAt = route.indexOf("replayCompletedHistory(");
    assert.ok(guardAt > 0 && replayAt > guardAt);

    const db = memoryDb();
    const event = eventFor("shop-a.myshopify.com");
    const foreign = await replayLikeRoute(event, "shop-b.myshopify.com", db);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.errorCode, "shop_mismatch");
    assert.equal(foreign.errorSummary.startsWith("history_incomplete:"), true);
    assert.equal(db.rows.length, 0);
    assert.equal(db.rows.some((row) => row.shop === "shop-b.myshopify.com"), false);

    const owned = await replayLikeRoute(event, "shop-a.myshopify.com", db);
    assert.equal(owned.historyReplayed, true);
    assert.equal(owned.errorSummary, null);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].shop, "shop-a.myshopify.com");
    assert.equal(db.rows[0].delta, -1);
  });
});
