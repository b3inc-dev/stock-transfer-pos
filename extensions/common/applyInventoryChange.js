import {
  isUncertainFetchError,
  classifyApplyChangeResponse,
  decideFromEventStatus,
  APPLY_PENDING_MESSAGE,
  APPLY_UNCERTAIN_MESSAGE,
  APPLY_PARTIAL_MESSAGE,
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

function isRetryableStatus(status) {
  return status === 429 || status === 503 || (status >= 500 && status < 600);
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
        if (last === "completed") return { decision: last, data };
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
      if ((kind === "auth" || kind === "retryable") && attempt < MAX_REQUEST_RETRIES) {
        await delay(RETRY_DELAY_MS * Math.min(attempt, 2));
        continue;
      }
      if (kind === "partial_failed") {
        throw errorWithCode(`${buildApiErrorMessage(res, data)}（${APPLY_PARTIAL_MESSAGE}）`, "APPLY_PARTIAL", { partiallyApplied: true });
      }
      if (kind !== "pending") {
        const msg = buildApiErrorMessage(res, data);
        throw new Error(data?.ok === false ? msg : `applyInventoryChangeToApi: ${msg}`);
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
    throw errorWithCode(`${APPLY_UNCERTAIN_MESSAGE}${detail}`, "APPLY_UNCERTAIN");
  }
}

/**
 * @param {Object} opts
 * @param {boolean} [opts.recoverUncertain] - true のとき通信断/タイムアウト/202 を同一 appEventId の状態照会で解決する（棚卸のみ使用）
 * @param {number} [opts.requestTimeoutMs] - recoverUncertain 時の 1 リクエスト上限
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
  for (let attempt = 1; attempt <= MAX_REQUEST_RETRIES; attempt++) {
    const token = await session.getSessionToken();
    if (!token) {
      throw new Error("applyInventoryChangeToApi: Failed to get session token");
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data?.ok !== false) {
        return data;
      }

      // 空 error / Unknown 固定を避け、HTTP 状況と errorCode を POS toast に載せる
      const rawErr = typeof data?.error === "string" ? data.error.trim() : "";
      const code = typeof data?.errorCode === "string" && data.errorCode.trim() ? data.errorCode.trim() : "";
      let msg = rawErr;
      if (!msg || /^unknown(\s+error)?$/i.test(msg)) {
        msg =
          res.statusText?.trim() ||
          `在庫APIリクエストに失敗しました（HTTP ${res.status}${code ? ` / ${code}` : ""}）`;
      } else if (code && !msg.includes(code)) {
        msg = `${msg} [${code}]`;
      }
      lastError = new Error(data?.ok === false ? msg : `applyInventoryChangeToApi: ${msg}`);

      if (res.status === 401 && attempt < MAX_REQUEST_RETRIES) {
        await delay(attempt === 1 ? 500 : RETRY_DELAY_MS * Math.min(attempt - 1, 2));
        continue;
      }
      if (isRetryableStatus(res.status) && attempt < MAX_REQUEST_RETRIES) {
        const waitMs = RETRY_DELAY_MS * Math.min(attempt, 2);
        if (attempt > 1) {
          console.warn(`[applyInventoryChangeToApi] attempt ${attempt}/${MAX_REQUEST_RETRIES}, retrying in ${waitMs}ms (status=${res.status})`);
        }
        await delay(waitMs);
        continue;
      }

      throw lastError;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isNetworkOrServer = lastError.message.includes("fetch") || lastError.message.includes("Network");
      if (isNetworkOrServer && attempt < MAX_REQUEST_RETRIES) {
        const waitMs = RETRY_DELAY_MS * Math.min(attempt, 2);
        console.warn(`[applyInventoryChangeToApi] attempt ${attempt}/${MAX_REQUEST_RETRIES}, retrying in ${waitMs}ms: ${lastError.message}`);
        await delay(waitMs);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error("applyInventoryChangeToApi: Request failed");
}
