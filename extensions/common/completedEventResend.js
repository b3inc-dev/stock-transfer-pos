/**
 * 同じ appEventId で、すでに completed のイベントが送り直されたときの応答を決める（サーバー用）。
 *
 * 決まり（docs/STATE_MACHINE.md §6「同一 appEventId が completed → 即 OK 返却（冪等）」）:
 * - 在庫はもう動いている。ここでは在庫 API を呼ばない。
 * - 店舗のタイムゾーンが読めない・日付の修復が失敗した、という「履歴の日付」だけの問題で
 *   失敗（5xx / ok:false）を返さない。
 *   POS は 5xx を「在庫は動いていない」と受け取り、操作 ID を捨てる。そのあと押し直すと
 *   新しい ID になり、差分（delta）で送るロス・仕入れの在庫がもう一度動く。
 * - 履歴が書きかけ（history_incomplete）のときは、UTC の日付では書かず、
 *   history_incomplete のまま 200 で返す。POS は「在庫は反映済み」として同じ ID を残す。
 * - 履歴は書けていて日付の修復だけのときは、修復をあとに回して 200 の完了を返す。
 */
import { planInventoryHistoryDate } from "./shopHistoryDate.js";
import {
  decideCompletedEventRetry,
  repairCompletedHistoryDates,
  replayCompletedHistory,
} from "./inventoryLogWrite.js";

const HISTORY_INCOMPLETE_PREFIX = "history_incomplete:";

function describeError(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "unknown error");
}

/**
 * @param {object} db Prisma 相当（inventoryChangeLog / inventoryChangeEvent）
 * @param {object} args
 * @param {object} args.existingEvent status が completed の InventoryChangeEvent（lines 付き）
 * @param {string} args.shop
 * @param {string} args.appEventId
 * @param {() => Promise<{ok: boolean, timezone?: string}>} args.readTimezone 店舗タイムゾーンの読み取り
 * @param {Date} [args.now] requestedAt が無いときの時刻
 * @param {(msg: string, detail?: unknown) => void} [args.warn]
 * @returns {Promise<{ status: 200, body: object }>} どの分岐でも 200（在庫は適用済み）
 */
export async function respondToCompletedEventResend(db, args) {
  const ev = args.existingEvent;
  const warn = typeof args.warn === "function" ? args.warn : () => {};
  const lines = Array.isArray(ev?.lines) ? ev.lines : [];
  const base = {
    eventId: ev.id,
    appEventId: args.appEventId,
    status: "completed",
    appliedCount: lines.length,
  };
  const timestamp = ev.requestedAt ?? args.now ?? new Date();

  let read;
  try {
    read = await args.readTimezone();
  } catch {
    read = { ok: false, reason: "request_failed" };
  }
  const historyDate = planInventoryHistoryDate({ phase: "after_inventory", read, timestamp });

  if (decideCompletedEventRetry(ev).action === "retry_history_only") {
    if (historyDate.action !== "proceed") {
      // 日付が決まらないので履歴は書かない。印（history_incomplete:）は残し、次の送り直しで書く。
      const historyError = "店舗タイムゾーンを読み取れなかったため、履歴の記録をあとに回しました（在庫は反映済み）";
      await db.inventoryChangeEvent
        .update({
          where: { id: ev.id },
          data: { errorSummary: `${HISTORY_INCOMPLETE_PREFIX} timezone_unavailable: ${historyError}`.slice(0, 500) },
        })
        .catch(() => null);
      return {
        status: 200,
        body: {
          ok: true,
          ...base,
          historyIncomplete: true,
          errorCode: "history_incomplete",
          historyErrorCode: "timezone_unavailable",
          historyError,
        },
      };
    }
    const replay = await replayCompletedHistory(db, {
      shop: args.shop,
      appEventId: args.appEventId,
      activity: ev.activity,
      locationId: ev.locationId,
      locationName: ev.locationName || "",
      sourceId: ev.sourceId,
      requestedAt: timestamp,
      date: historyDate.date,
      lines: lines.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        variantId: l.variantId,
        sku: l.sku,
        delta: l.delta,
        quantityAfter: l.quantityAfterActual ?? l.quantityAfterExpected,
      })),
    });
    if (replay.ok) {
      await db.inventoryChangeEvent
        .update({ where: { id: ev.id }, data: { errorSummary: null } })
        .catch(() => null);
      return { status: 200, body: { ok: true, ...base, historyReplayed: true } };
    }
    const historyError = replay.error || "history finalize failed";
    await db.inventoryChangeEvent
      .update({
        where: { id: ev.id },
        data: { errorSummary: `${HISTORY_INCOMPLETE_PREFIX} ${replay.errorCode}: ${historyError}`.slice(0, 500) },
      })
      .catch(() => null);
    return {
      status: 200,
      body: { ok: true, ...base, historyIncomplete: true, errorCode: "history_incomplete", historyError },
    };
  }

  // 履歴は書けている。旧実装が UTC 日付で書いた行の date だけを直す（行は増やさない）。
  if (historyDate.action !== "proceed") {
    warn("[apply-change] completed resend: timezone unavailable, date repair deferred", args.appEventId);
    return { status: 200, body: { ok: true, ...base, historyDateRepairDeferred: true } };
  }
  try {
    await repairCompletedHistoryDates(db, {
      shop: args.shop,
      appEventId: args.appEventId,
      activity: ev.activity,
      locationId: ev.locationId,
      date: historyDate.date,
      lines: lines.map((l) => ({ inventoryItemId: l.inventoryItemId })),
    });
  } catch (err) {
    warn("[apply-change] completed resend: history date repair failed (deferred)", describeError(err));
    return { status: 200, body: { ok: true, ...base, historyDateRepairDeferred: true } };
  }
  return { status: 200, body: { ok: true, ...base } };
}
