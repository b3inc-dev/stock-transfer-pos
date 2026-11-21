/**
 * 監査 P1-1（#55）: すでに完了した操作の送り直しで、店舗のタイムゾーンが読めなくても
 * 「完了済み」として返し、ロス・仕入れの在庫を二度動かさない。
 *
 * 流れ: 確定 → サーバーで在庫が動く → 返事が届かない（通信断）→ POS が同じ appEventId で送り直す
 *      → その時タイムゾーンが読めない → それでも 200 の完了 → 次に押しても同じ ID → 在庫は 1 回だけ。
 *
 * サーバー側の分岐は本番と同じ respondToCompletedEventResend を使う。POS 側も本番の
 * applyInventoryChangeToApi / operationToKeepAfterError / beginConfirmOperation を使う。
 * Run: node --experimental-strip-types --test tests/completed-resend-no-double-apply.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { respondToCompletedEventResend } from "../extensions/common/completedEventResend.js";
import { applyInventoryChangeToApi } from "../extensions/common/applyInventoryChange.js";
import { classifyApplyChangeResponse } from "../extensions/common/applyChangeRecovery.js";
import { beginConfirmOperation, operationToKeepAfterError } from "../extensions/common/confirmOperationRetry.js";
import { buildInventoryLogIdempotencyKey, replayCompletedHistory } from "../extensions/common/inventoryLogWrite.js";
import { planInventoryHistoryDate } from "../extensions/common/shopHistoryDate.js";

const SHOP = "demo.myshopify.com";
const LOCATION = "gid://shopify/Location/7";
const ITEM = "gid://shopify/InventoryItem/101";
/** 日本時間 2026-11-13 00:30（UTC ではまだ 11-12） */
const TOKYO_BOUNDARY = new Date("2026-11-12T15:30:00.000Z");

/**
 * apply-change の冪等の分岐だけを持つ、作り物のサーバー。
 * - 新しい appEventId: 在庫を delta だけ動かし、completed にする（履歴は opts で失敗させられる）
 * - completed の appEventId: 本番と同じ respondToCompletedEventResend（在庫は動かさない）
 */
function fakeServer({ timezoneReads, historyFailsOnFirstApply = false, dropFirstResponse = true }) {
  const inventory = { [ITEM]: 10 };
  const events = [];
  const rows = [];
  const inventoryMoves = [];
  let posts = 0;
  let tzIdx = 0;
  const readTimezone = async () => {
    const r = timezoneReads[Math.min(tzIdx, timezoneReads.length - 1)];
    tzIdx += 1;
    return r;
  };
  const db = {
    inventoryChangeLog: {
      async upsert({ where, create, update }) {
        const { shop, idempotencyKey } = where.shop_idempotencyKey;
        const row = rows.find((r) => r.shop === shop && r.idempotencyKey === idempotencyKey);
        if (row) return Object.assign(row, update);
        const created = { id: `log_${rows.length + 1}`, ...create };
        rows.push(created);
        return created;
      },
      async findUnique({ where }) {
        const { shop, idempotencyKey } = where.shop_idempotencyKey;
        return rows.find((r) => r.shop === shop && r.idempotencyKey === idempotencyKey) ?? null;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        return Object.assign(row, data);
      },
    },
    inventoryChangeEvent: {
      async update({ where, data }) {
        const ev = events.find((e) => e.id === where.id);
        return Object.assign(ev, data);
      },
    },
  };

  async function handle(body) {
    posts += 1;
    if (body.statusOnly) {
      const ev = events.find((e) => e.appEventId === body.appEventId);
      return {
        status: 200,
        body: ev
          ? { ok: true, found: true, appEventId: ev.appEventId, eventId: ev.id, status: ev.status, errorSummary: ev.errorSummary, lineCount: ev.lines.length }
          : { ok: true, found: false, appEventId: body.appEventId },
      };
    }
    const existing = events.find((e) => e.appEventId === body.appEventId);
    if (existing && existing.status === "completed") {
      return respondToCompletedEventResend(db, {
        existingEvent: existing,
        shop: SHOP,
        appEventId: body.appEventId,
        readTimezone,
      });
    }
    // 新しい操作: 在庫を動かす前に日付を決める（#55 と同じ）。ここでは読み取りは成功させる。
    const plan = planInventoryHistoryDate({ phase: "before_inventory", read: { ok: true, timezone: "Asia/Tokyo" }, timestamp: TOKYO_BOUNDARY });
    const lines = body.entries.map((e) => {
      inventory[e.inventoryItemId] += e.delta;
      inventoryMoves.push({ appEventId: body.appEventId, delta: e.delta });
      return { inventoryItemId: e.inventoryItemId, delta: e.delta, quantityAfterActual: inventory[e.inventoryItemId] };
    });
    const ev = {
      id: `ev_${events.length + 1}`,
      appEventId: body.appEventId,
      shop: SHOP,
      status: "completed",
      errorSummary: null,
      activity: body.activity,
      locationId: body.locationId,
      locationName: "合成店",
      sourceId: null,
      requestedAt: TOKYO_BOUNDARY,
      lines,
    };
    events.push(ev);
    if (historyFailsOnFirstApply) {
      ev.errorSummary = "history_incomplete: db_error: connection lost";
    } else {
      await replayCompletedHistory(db, {
        shop: SHOP, appEventId: ev.appEventId, activity: ev.activity, locationId: ev.locationId,
        locationName: ev.locationName, sourceId: null, requestedAt: TOKYO_BOUNDARY, date: plan.date,
        lines: lines.map((l) => ({ inventoryItemId: l.inventoryItemId, delta: l.delta, quantityAfter: l.quantityAfterActual })),
      });
    }
    if (dropFirstResponse && posts === 1) {
      // 在庫は動いたのに、返事が POS に届かない
      throw new TypeError("Failed to fetch");
    }
    return { status: 200, body: { ok: true, eventId: ev.id, appEventId: ev.appEventId, status: "completed", appliedCount: lines.length } };
  }

  return { inventory, events, rows, inventoryMoves, handle, get posts() { return posts; } };
}

function installPos(server) {
  globalThis.shopify = { session: { getSessionToken: async () => "tok" } };
  globalThis.fetch = async (_url, init) => {
    const { status, body } = await server.handle(JSON.parse(init.body));
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
  };
}

/** POS の確定ボタン 1 回分。エラーなら画面と同じく operationToKeepAfterError で ID を残すか決める。 */
async function pressConfirm(state, activity, opts = {}) {
  const begun = beginConfirmOperation(state.pending, () => {
    state.minted += 1;
    return { entryId: `op_${state.minted}`, appEventId: `evt_${activity}_${state.minted}` };
  });
  state.sentIds.push(begun.operation.appEventId);
  try {
    await applyInventoryChangeToApi({
      appEventId: begun.operation.appEventId,
      activity,
      locationId: LOCATION,
      entries: [{ inventoryItemId: ITEM, delta: activity === "purchase_entry" ? 3 : -1 }],
      retryDelayMs: 0,
      ...opts,
    });
    state.pending = null;
    return "ok";
  } catch (error) {
    state.pending = operationToKeepAfterError(begun.operation, error, state.pending, [{ inventoryItemId: ITEM }]);
    return error;
  }
}

const TZ_DOWN = { ok: false, reason: "request_failed" };
const TZ_OK = { ok: true, timezone: "Asia/Tokyo" };

describe("completed resend with an unreadable timezone does not move stock twice", () => {
  beforeEach(() => {
    delete globalThis.shopify;
  });

  for (const activity of ["loss_entry", "purchase_entry"]) {
    it(`${activity}: response lost, resend while timezone is down → 200 completed, stock moved once`, async () => {
      const server = fakeServer({ timezoneReads: [TZ_DOWN] });
      installPos(server);
      const state = { pending: null, minted: 0, sentIds: [] };

      const first = await pressConfirm(state, activity);
      assert.equal(first, "ok", "同じ ID の送り直しが完了として受け取られる");
      assert.equal(server.inventoryMoves.length, 1);
      assert.equal(server.inventory[ITEM], activity === "purchase_entry" ? 13 : 9);

      // スタッフが念のためもう一度押しても、新しい操作になるだけで前の操作は二重にならない
      assert.equal(state.pending, null);
      assert.deepEqual(new Set(server.inventoryMoves.map((m) => m.appEventId)).size, 1);
    });
  }

  it("history was incomplete: resends answer history_incomplete (200), the id is kept, the next press only writes history", async () => {
    const server = fakeServer({ timezoneReads: [TZ_DOWN, TZ_DOWN, TZ_OK], historyFailsOnFirstApply: true });
    installPos(server);
    const state = { pending: null, minted: 0, sentIds: [] };

    const first = await pressConfirm(state, "loss_entry");
    assert.ok(first instanceof Error);
    assert.equal(first.inventoryApplied, true, "在庫は反映済みと POS に伝わる");
    assert.equal(state.pending?.appEventId, "evt_loss_entry_1", "ID を捨てない");
    assert.equal(server.inventoryMoves.length, 1);
    assert.equal(server.rows.length, 0, "日付が決まらないので UTC の日付で履歴を書かない");
    assert.match(server.events[0].errorSummary, /^history_incomplete:/, "次の送り直しで書くための印が残る");

    // タイムゾーンが戻ったあと、同じ ID で押し直す → 履歴だけ書く
    const second = await pressConfirm(state, "loss_entry");
    assert.equal(second, "ok");
    assert.deepEqual(state.sentIds, ["evt_loss_entry_1", "evt_loss_entry_1"]);
    assert.equal(server.inventoryMoves.length, 1, "在庫は 1 回だけ");
    assert.equal(server.inventory[ITEM], 9);
    assert.equal(server.rows.length, 1);
    assert.equal(server.rows[0].date, "2026-11-13", "店舗の日付で書く");
    assert.equal(server.rows[0].delta, -1);
    assert.equal(server.events[0].errorSummary, null);
  });

  it("stocktake path (recoverUncertain) also keeps the id and does not re-apply", async () => {
    const server = fakeServer({ timezoneReads: [TZ_DOWN], historyFailsOnFirstApply: true });
    installPos(server);
    const state = { pending: null, minted: 0, sentIds: [] };
    const result = await pressConfirm(state, "inventory_count", { recoverUncertain: true, recoveryDelaysMs: [0] });
    assert.ok(result instanceof Error);
    assert.equal(result.inventoryApplied, true);
    assert.equal(state.pending?.appEventId, "evt_inventory_count_1");
    assert.equal(server.inventoryMoves.length, 1);
  });

  it("every completed-resend branch answers 2xx with status completed, whatever the timezone does", async () => {
    const cases = [
      { errorSummary: null, read: TZ_DOWN },
      { errorSummary: null, read: TZ_OK },
      { errorSummary: "history_incomplete: db_error: x", read: TZ_DOWN },
      { errorSummary: "history_incomplete: db_error: x", read: TZ_OK },
      { errorSummary: null, read: "throws" },
    ];
    for (const c of cases) {
      const ev = {
        id: "ev_1", appEventId: "evt_1", shop: SHOP, status: "completed", errorSummary: c.errorSummary,
        activity: "loss_entry", locationId: LOCATION, requestedAt: TOKYO_BOUNDARY,
        lines: [{ inventoryItemId: ITEM, delta: -1, quantityAfterActual: 9 }],
      };
      const rows = [];
      const db = {
        inventoryChangeLog: {
          async upsert({ create }) { rows.push(create); return create; },
          async findUnique() { throw new Error("db down"); },
          async update() { throw new Error("db down"); },
        },
        inventoryChangeEvent: { async update({ data }) { Object.assign(ev, data); return ev; } },
      };
      const resp = await respondToCompletedEventResend(db, {
        existingEvent: ev, shop: SHOP, appEventId: "evt_1",
        readTimezone: async () => { if (c.read === "throws") throw new Error("boom"); return c.read; },
      });
      assert.equal(resp.status, 200, JSON.stringify(c));
      assert.equal(resp.body.status, "completed");
      const kind = classifyApplyChangeResponse(resp.status, resp.body);
      assert.ok(kind === "success" || kind === "history_incomplete", `${kind} ${JSON.stringify(c)}`);
    }
  });

  it("why: the old 503 + status completed answer made POS drop the id (regression guard)", () => {
    const old = { ok: false, errorCode: "timezone_unavailable", status: "completed" };
    assert.equal(classifyApplyChangeResponse(503, old), "retryable");
    // main の 4a5eaa4（返事が来るまで同じ ID で送り直す）以降、POS は 5xx のあとも ID を残す。
    // サーバー側の「completed の送り直しは必ず 200」と合わせて、二重に在庫が動かないことを守る。
    const kept = operationToKeepAfterError({ entryId: "op_1", appEventId: "evt_1" }, new Error("店舗タイムゾーンを読み取れなかった"), null);
    assert.equal(kept?.appEventId, "evt_1");
    assert.equal(
      buildInventoryLogIdempotencyKey({ shop: SHOP, appEventId: "evt_1", activity: "loss_entry", inventoryItemId: ITEM, locationId: LOCATION }).includes("evt_1"),
      true
    );
  });
});
