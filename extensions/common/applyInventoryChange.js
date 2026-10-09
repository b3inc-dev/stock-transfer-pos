/**
 * Phase1: 在庫変更＋履歴を1本化した API を呼ぶ共通関数
 * イベントを先にサーバで確定→Shopify 実行→履歴記録までサーバ側で完結する。
 * 失敗しないための追求: 429/5xx/ネットワーク/Abort で同一 appEventId を再送、
 * サーバ in-flight (202 pending/applying) はポーリング再送で sticky エラーを避ける。
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

/** 1 回の fetch の Abort 期限（サーバ側 GraphQL リトライより短くしない） */
const PER_FETCH_TIMEOUT_MS = 90000;
/** 全体の上限（in-flight ポーリング含む）。超過時は「処理中の可能性」を明示して throw */
const OVERALL_BUDGET_MS = 150000;
/** in-flight / 一時障害後の待機 */
const RETRY_DELAY_MS = 1000;
const IN_FLIGHT_WAIT_MS = 2500;
/** 永続 4xx（partial_failed 等）以外の一時障害の最大再送回数（予算内） */
const MAX_TRANSIENT_RETRIES = 8;

function isRetryableStatus(status) {
  return status === 429 || status === 503 || (status >= 500 && status < 600);
}

function isInFlightResponse(res, data) {
  if (res?.status === 202) return true;
  const status = data?.status;
  return status === "pending" || status === "applying";
}

function isAbortError(err) {
  if (!err) return false;
  const name = err.name ?? "";
  const msg = String(err.message ?? err);
  return name === "AbortError" || /abort|timeout/i.test(msg);
}

function isNetworkError(err) {
  const msg = String(err?.message ?? err ?? "");
  return /fetch|network|load failed|failed to fetch|connection refused|net::/i.test(msg);
}

function formatApplyErrorMessage(res, data) {
  // 空 error / Unknown 固定を避け、HTTP 状況と errorCode を POS toast に載せる（#23）
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
  return msg;
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function applyInventoryChangeToApi({
  appEventId,
  activity,
  locationId,
  locationName = "",
  sourceId = null,
  referenceDocumentUri = null,
  entries,
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

  const startedAt = Date.now();
  let lastError = null;
  let transientAttempts = 0;

  while (Date.now() - startedAt < OVERALL_BUDGET_MS) {
    const token = await session.getSessionToken();
    if (!token) {
      throw new Error("applyInventoryChangeToApi: Failed to get session token");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PER_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json().catch(() => ({}));

      if (res.ok && data?.ok !== false) {
        return data;
      }

      // サーバ処理中: 同一 appEventId を再送して完了を待つ（sticky 202 を避ける）。再 set はサーバ冪等。
      if (isInFlightResponse(res, data)) {
        transientAttempts += 1;
        const waitMs = IN_FLIGHT_WAIT_MS;
        console.warn(
          `[applyInventoryChangeToApi] in-flight status=${data?.status ?? res.status}, wait ${waitMs}ms then re-POST (attempt=${transientAttempts})`
        );
        await delay(waitMs);
        continue;
      }

      const msg = formatApplyErrorMessage(res, data);
      lastError = new Error(data?.ok === false ? msg : `applyInventoryChangeToApi: ${msg}`);

      if (res.status === 401 && transientAttempts < MAX_TRANSIENT_RETRIES) {
        transientAttempts += 1;
        await delay(transientAttempts === 1 ? 500 : RETRY_DELAY_MS * Math.min(transientAttempts, 2));
        continue;
      }
      if (isRetryableStatus(res.status) && transientAttempts < MAX_TRANSIENT_RETRIES) {
        transientAttempts += 1;
        const waitMs = RETRY_DELAY_MS * Math.min(transientAttempts, 4);
        console.warn(
          `[applyInventoryChangeToApi] retryable HTTP ${res.status}, wait ${waitMs}ms (attempt=${transientAttempts})`
        );
        await delay(waitMs);
        continue;
      }

      throw lastError;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err : new Error(String(err));

      // Abort / ネットワーク: サーバ側は継続している可能性がある → 同一 appEventId で再送（二重 set にならない）
      if (
        (isAbortError(lastError) || isNetworkError(lastError)) &&
        transientAttempts < MAX_TRANSIENT_RETRIES &&
        Date.now() - startedAt + IN_FLIGHT_WAIT_MS < OVERALL_BUDGET_MS
      ) {
        transientAttempts += 1;
        const waitMs = IN_FLIGHT_WAIT_MS;
        console.warn(
          `[applyInventoryChangeToApi] ${isAbortError(lastError) ? "timeout/abort" : "network"} — re-POST same appEventId after ${waitMs}ms (attempt=${transientAttempts}): ${lastError.message}`
        );
        await delay(waitMs);
        continue;
      }

      if (isAbortError(lastError)) {
        throw new Error(
          "在庫調整の応答がタイムアウトしました。処理中の可能性があります。しばらくしてから再度確定してください（同一操作は同じ ID で再確認します）。"
        );
      }
      throw lastError;
    }
  }

  throw (
    lastError ||
    new Error(
      "在庫調整が完了確認できませんでした。処理中の可能性があります。しばらくしてから再度確定してください。"
    )
  );
}
