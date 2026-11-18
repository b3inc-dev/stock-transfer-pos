import {
  isUncertainFetchError,
  classifyApplyChangeResponse,
  decideFromEventStatus,
  APPLY_PENDING_MESSAGE,
  APPLY_UNCERTAIN_MESSAGE,
  APPLY_PARTIAL_MESSAGE,
  APPLY_HISTORY_INCOMPLETE_MESSAGE,
} from "./applyChangeRecovery.js";

/**
 * Phase1: 在庫変更＋履歴を1本化した API を呼ぶ共通関数
 * イベントを先にサーバで確定→Shopify 実行→履歴記録までサーバ側で完結する。
 * 失敗しないための追求: 429/5xx/ネットワークエラーでリトライ、401 時はトークン再取得して再試行。
 *
 * @param {Object} opts
 * @param {string} opts.appEventId - 1回の操作単位の一意ID（必須）
 * @param {string} opts.activity - アクティビティ種別（inventory_count, loss_entry, adjustment, inbound_transfer, outbound_transfer, purchase_entry 等）
 * @param {string} opts.locationId - ロケーション ID（GID）
 * @param {string} [opts.locationName] - ロケーション名
 * @param {string|null} [opts.sourceId] - 参照元 ID（count.id, loss_xxx, Transfer ID 等）
 * @param {string|null} [opts.referenceDocumentUri] - 棚卸用の referenceDocumentUri（count.id を渡すと Shopify に紐付く）
 * @param {Array<{inventoryItemId: string, variantId?: string, sku?: string, quantityAfter?: number, quantityBefore?: number, delta?: number}>} opts.entries - 明細（quantityAfter または delta のいずれか必須。ロス・仕入は delta のみで可）
 * @returns {Promise<{ok: boolean, eventId?: string, appEventId?: string, status?: string, appliedCount?: number, invalidCount?: number, error?: string}>}
 */

/** リクエスト全体の最大リトライ回数（一時的なネット・サーバ障害対策） */
const MAX_REQUEST_RETRIES = 3;
/** リトライ間隔（ミリ秒）。2回目以降は指数バックオフ（1s → 2s） */
const RETRY_DELAY_MS = 1000;

/** 一度でも在庫適用済みと分かった失敗は、後続の 503 や通信エラーにもその印を残す。 */
export function carryInventoryApplied(error, seen) {
  const err = error instanceof Error ? error : new Error(String(error || "applyInventoryChangeToApi: Request failed"));
  if (!seen && err.inventoryApplied !== true && err.code !== "history_incomplete") return err;
  err.inventoryApplied = true;
  err.historyIncomplete = true;
  if (!err.code) err.code = "history_incomplete";
  return err;
}

/**
 * サーバーがはっきり断った失敗（入力の誤り・別ショップのイベント・一部だけ反映済みなど）。
 * 同じ appEventId で送り直しても答えは変わらないので、画面はこの ID を残さなくてよい。
 * 応答なし・時間切れ・401・408・409・429・5xx・処理中は「結果が分からない」なので、ここに入れない。
 */
export function isFinalApplyRejection(httpStatus, kind, sawApplied) {
  if (sawApplied) return false;
  if (kind !== "fatal" && kind !== "partial_failed") return false;
  const status = Number(httpStatus);
  if (!(status >= 400 && status < 500)) return false;
  return status !== 401 && status !== 408 && status !== 409 && status !== 429;
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** recoverUncertain 時の 1 リクエスト上限（エッジ切断 ~100s より短く） */
const RECOVER_REQUEST_TIMEOUT_MS = 90000;
/** recoverUncertain 時、応答不明/202 後に appEventId 状態を照会する間隔 */
const RECOVER_STATUS_DELAYS_MS = [2000, 4000, 8000, 12000, 16000];
/** イベント無し/failed と確認できた場合だけ、同じ appEventId で本リクエストを再送する回数 */
const RECOVER_MAX_RESENDS = 1;

function buildApiErrorMessage(res, data) {
  const rawErr = typeof data?.error === "string" ? data.error.trim() : "";
  const code = typeof data?.errorCode === "string" && data.errorCode.trim() ? data.errorCode.trim() : "";
  let msg = rawErr;
  if (!msg || /^unknown(\s+error)?$/i.test(msg)) {
    msg =
      res?.statusText?.trim() ||
      `在庫APIリクエストに失敗しました（HTTP ${res?.status}${code ? ` / ${code}` : ""}）`;
  } else if (code && !msg.includes(code)) {
    msg = `${msg} [${code}]`;
  }
  return msg;
}

function errorWithCode(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 応答不明（通信断・タイムアウト）や 202（処理中）を、同じ appEventId の状態照会で解決する経路。
 * 在庫の再適用はサーバの冪等判定（completed は 200、failed のみ再実行）に委ね、partial_failed / applying では再送しない。
 */
async function applyWithUncertainRecovery({ session, url, body, appEventId, requestTimeoutMs, recoveryDelaysMs }) {
  const timeoutMs = Number.isFinite(Number(requestTimeoutMs)) ? Number(requestTimeoutMs) : RECOVER_REQUEST_TIMEOUT_MS;
  const delays = Array.isArray(recoveryDelaysMs) ? recoveryDelaysMs : RECOVER_STATUS_DELAYS_MS;

  const post = async (payload, ms) => {
    const token = await session.getSessionToken();
    if (!token) throw new Error("applyInventoryChangeToApi: Failed to get session token");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } finally {
      clearTimeout(timer);
    }
  };

  const pollStatus = async () => {
    let last = "unknown";
    for (const waitMs of delays) {
      await delay(waitMs);
      try {
        const { res, data } = await post({ statusOnly: true, appEventId }, 20000);
        last = res.ok ? decideFromEventStatus(data) : "unknown";
        if (last === "completed" || last === "history_incomplete") return { decision: last, data };
        if (last === "resend" || last === "manual") return { decision: last, data };
      } catch (e) {
        console.warn("[applyInventoryChangeToApi] status poll failed:", e?.message ?? e);
        last = "unknown";
      }
    }
    return { decision: last, data: null };
  };

  let resends = 0;
  let attempt = 0;
  let sawApplied = false;
  for (;;) {
    attempt++;
    let res = null;
    let data = null;
    let fetchErr = null;
    try {
      ({ res, data } = await post(body, timeoutMs));
    } catch (e) {
      fetchErr = e instanceof Error ? e : new Error(String(e));
      if (!isUncertainFetchError(fetchErr)) throw fetchErr;
    }

    let pendingStatus = null;
    if (res) {
      const kind = classifyApplyChangeResponse(res.status, data);
      if (kind === "success") return data;
      if (kind === "history_incomplete") {
        sawApplied = true;
        if (attempt < MAX_REQUEST_RETRIES) {
          await delay(RETRY_DELAY_MS * Math.min(attempt, 2));
          continue;
        }
        throw carryInventoryApplied(
          errorWithCode(APPLY_HISTORY_INCOMPLETE_MESSAGE, "history_incomplete", {
            historyIncomplete: true,
            inventoryApplied: true,
          }),
          true
        );
      }
      if ((kind === "auth" || kind === "retryable") && attempt < MAX_REQUEST_RETRIES) {
        await delay(RETRY_DELAY_MS * Math.min(attempt, 2));
        continue;
      }
      if (kind === "partial_failed") {
        throw carryInventoryApplied(
          errorWithCode(`${buildApiErrorMessage(res, data)}（${APPLY_PARTIAL_MESSAGE}）`, "APPLY_PARTIAL", { partiallyApplied: true }),
          sawApplied
        );
      }
      if (kind !== "pending") {
        const msg = buildApiErrorMessage(res, data);
        throw carryInventoryApplied(new Error(data?.ok === false ? msg : `applyInventoryChangeToApi: ${msg}`), sawApplied);
      }
      pendingStatus = data?.status || "applying";
    } else {
      console.warn("[applyInventoryChangeToApi] uncertain fetch error, checking event status:", fetchErr?.message);
    }

    const { decision, data: statusData } = await pollStatus();
    if (decision === "completed") {
      return {
        ok: true,
        eventId: statusData?.eventId,
        appEventId,
        status: "completed",
        appliedCount: statusData?.lineCount,
        recoveredViaStatus: true,
      };
    }
    if (decision === "history_incomplete") {
      sawApplied = true;
      if (resends < RECOVER_MAX_RESENDS) {
        resends++;
        continue;
      }
      throw carryInventoryApplied(
        errorWithCode(APPLY_HISTORY_INCOMPLETE_MESSAGE, "history_incomplete", {
          historyIncomplete: true,
          inventoryApplied: true,
        }),
        true
      );
    }
    if (decision === "resend" && resends < RECOVER_MAX_RESENDS) {
      resends++;
      continue;
    }
    if (decision === "manual") {
      throw errorWithCode(APPLY_PARTIAL_MESSAGE, "APPLY_PARTIAL", { partiallyApplied: true });
    }
    if (decision === "wait" || pendingStatus) {
      throw errorWithCode(APPLY_PENDING_MESSAGE, "APPLY_PENDING");
    }
    const detail = fetchErr?.message ? `（${fetchErr.message}）` : "";
    throw carryInventoryApplied(errorWithCode(`${APPLY_UNCERTAIN_MESSAGE}${detail}`, "APPLY_UNCERTAIN"), sawApplied);
  }
}

/**
 * @param {Object} opts
 * @param {boolean} [opts.recoverUncertain] - true のとき通信断/タイムアウト/202 を同一 appEventId の状態照会で解決する（棚卸のみ使用）
 * @param {number} [opts.requestTimeoutMs] - 1 リクエストの時間の上限（既定 90 秒。超えたら応答なしとして同じ appEventId で送り直す）
 * @param {number[]} [opts.recoveryDelaysMs] - recoverUncertain 時の状態照会間隔（テスト用）
 */
export async function applyInventoryChangeToApi({
  appEventId,
  activity,
  locationId,
  locationName = "",
  sourceId = null,
  referenceDocumentUri = null,
  entries,
  recoverUncertain = false,
  requestTimeoutMs,
  recoveryDelaysMs,
  retryDelayMs,
}) {
  const session = globalThis?.shopify?.session;
  if (!session?.getSessionToken) {
    throw new Error("applyInventoryChangeToApi: No session or getSessionToken");
  }
  if (!entries?.length) {
    throw new Error("applyInventoryChangeToApi: No entries");
  }
  const hasValidEntry = entries.some(
    (e) => e && (Number.isFinite(Number(e?.quantityAfter)) || Number.isFinite(Number(e?.delta)))
  );
  if (!hasValidEntry) {
    throw new Error("applyInventoryChangeToApi: Each entry must have quantityAfter or delta");
  }
  if (!appEventId || !activity || !locationId) {
    throw new Error("applyInventoryChangeToApi: Missing appEventId, activity, or locationId");
  }

  const { getAppUrl } = await import("./appUrl.js");
  const appUrl = getAppUrl();
  const url = `${appUrl}/api/inventory/apply-change`;
  const body = {
    appEventId,
    activity,
    locationId,
    locationName: locationName || undefined,
    sourceId: sourceId || undefined,
    referenceDocumentUri: referenceDocumentUri || undefined,
    entries: entries.map((e) => ({
      inventoryItemId: e.inventoryItemId,
      variantId: e.variantId ?? undefined,
      sku: e.sku ?? undefined,
      quantityAfter: e.quantityAfter != null ? Number(e.quantityAfter) : undefined,
      quantityBefore: e.quantityBefore != null ? Number(e.quantityBefore) : undefined,
      delta: e.delta != null ? Number(e.delta) : undefined,
    })),
  };

  if (recoverUncertain) {
    return applyWithUncertainRecovery({ session, url, body, appEventId, requestTimeoutMs, recoveryDelaysMs });
  }

  let lastError = null;
  let sawApplied = false;
  const waitMsUnit = Number.isFinite(Number(retryDelayMs)) ? Number(retryDelayMs) : RETRY_DELAY_MS;
  const timeoutMs = Number.isFinite(Number(requestTimeoutMs)) ? Number(requestTimeoutMs) : RECOVER_REQUEST_TIMEOUT_MS;
  for (let attempt = 1; attempt <= MAX_REQUEST_RETRIES; attempt++) {
    const token = await session.getSessionToken();
    if (!token) {
      throw new Error("applyInventoryChangeToApi: Failed to get session token");
    }
    const retryWaitMs = waitMsUnit * Math.min(attempt, 2);

    let res = null;
    let data = null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      // fetch が投げるのは HTTP の応答を受け取れなかったときだけ（TypeError の通信失敗・AbortError・時間切れ）。
      // エラーの文（"Load failed" / "Failed to fetch" など）は端末ごとに違うので見ない。
      // サーバーで在庫が動いたかは分からないので、同じ appEventId のまま送り直す。
      const fetchErr = err instanceof Error ? err : new Error(String(err));
      const detail = fetchErr.message ? `（${fetchErr.message}）` : "";
      lastError = carryInventoryApplied(
        errorWithCode(`${APPLY_UNCERTAIN_MESSAGE}${detail}`, "APPLY_UNCERTAIN", { cause: fetchErr }),
        sawApplied
      );
      if (attempt < MAX_REQUEST_RETRIES) {
        console.warn(`[applyInventoryChangeToApi] attempt ${attempt}/${MAX_REQUEST_RETRIES}, no response, retrying in ${retryWaitMs}ms: ${fetchErr.message}`);
        await delay(retryWaitMs);
        continue;
      }
      throw lastError;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const kind = classifyApplyChangeResponse(res.status, data);
    if (kind === "success") {
      return data;
    }
    if (kind === "history_incomplete") {
      sawApplied = true;
      if (attempt < MAX_REQUEST_RETRIES) {
        await delay(retryWaitMs);
        continue;
      }
      throw carryInventoryApplied(
        errorWithCode(APPLY_HISTORY_INCOMPLETE_MESSAGE, "history_incomplete", {
          historyIncomplete: true,
          inventoryApplied: true,
        }),
        true
      );
    }
    if (kind === "pending") {
      // 同じ appEventId をサーバーがまだ処理中（前の送信が届いていた）。少し待って同じ ID で聞き直す。
      lastError = carryInventoryApplied(errorWithCode(APPLY_PENDING_MESSAGE, "APPLY_PENDING"), sawApplied);
      if (attempt < MAX_REQUEST_RETRIES) {
        await delay(retryWaitMs);
        continue;
      }
      throw lastError;
    }

    // 空 error / Unknown 固定を避け、HTTP 状況と errorCode を POS toast に載せる
    const msg = buildApiErrorMessage(res, data);
    lastError = carryInventoryApplied(
      new Error(data?.ok === false ? msg : `applyInventoryChangeToApi: ${msg}`),
      sawApplied
    );

    if (kind === "auth" && attempt < MAX_REQUEST_RETRIES) {
      await delay(attempt === 1 ? 500 : waitMsUnit * Math.min(attempt - 1, 2));
      continue;
    }
    if (kind === "retryable" && attempt < MAX_REQUEST_RETRIES) {
      if (attempt > 1) {
        console.warn(`[applyInventoryChangeToApi] attempt ${attempt}/${MAX_REQUEST_RETRIES}, retrying in ${retryWaitMs}ms (status=${res.status})`);
      }
      await delay(retryWaitMs);
      continue;
    }
    if (isFinalApplyRejection(res.status, kind, sawApplied)) {
      lastError.finalRejection = true;
    }
    throw lastError;
  }
  throw carryInventoryApplied(lastError || new Error("applyInventoryChangeToApi: Request failed"), sawApplied);
}
