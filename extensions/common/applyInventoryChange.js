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

      const msg = data?.error || res.statusText || "Request failed";
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
