/**
 * 在庫変動をアプリの api/log-inventory-change に記録する共通関数
 * 出庫・入庫・ロス・棚卸・仕入の全フローでこの1つを使用し、処理を統一する。
 *
 * 大量件数（例: 200SKU）でも漏れないよう、entries をチャンクに分けて複数リクエストで送信する。
 *
 * @param {Object} opts
 * @param {string} opts.activity - アクティビティ種別（outbound_transfer, inbound_transfer, loss_entry, inventory_count, purchase_entry 等）
 * @param {string} opts.locationId - ロケーション ID（GID）
 * @param {string} [opts.locationName] - ロケーション名（省略時は locationId を使用）
 * @param {Array<{inventoryItemId: string, variantId?: string, sku?: string, delta: number, quantityAfter?: number|null}>} opts.deltas - 変動の配列
 * @param {string|null} [opts.sourceId] - 参照元 ID（Transfer ID、loss_...、count.id 等）。省略時は null で送信
 * @param {Array<{inventoryItemId: string, variantId?: string, sku?: string}>} [opts.lineItems] - 出庫などで variantId/sku を補完するための行リスト（省略可）
 * @param {string|null} [opts.adjustmentGroupId] - ロス用の InventoryAdjustmentGroup ID（省略可）
 */

/** 1リクエストあたりの最大件数。これ以上は複数リクエストに分割し、タイムアウトによる途中切れと「管理」のまま残る漏れを防ぐ。 */
const LOG_INVENTORY_CHANGE_CHUNK_SIZE = 50;

/** チャンク送信失敗時の最大リトライ回数。一時的なネットワーク障害で「管理」のまま残る漏れを防ぐ。 */
const MAX_CHUNK_RETRIES = 2;

/** リトライ間隔（ミリ秒） */
const RETRY_DELAY_MS = 1000;

/**
 * チャンクをAPIに送信し、失敗時はリトライする
 * @returns {Promise<boolean>} 成功したかどうか
 */
async function sendChunkWithRetry(apiUrl, token, body, activity, chunkIndex, totalChunks) {
  for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      if (attempt < MAX_CHUNK_RETRIES) {
        console.warn(
          `[logInventoryChangeToApi] Chunk ${chunkIndex}/${totalChunks} failed (attempt ${attempt}), retrying in ${RETRY_DELAY_MS}ms... status=${res.status}`
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        const text = await res.text().catch(() => "");
        console.error(
          `[logInventoryChangeToApi] Chunk ${chunkIndex}/${totalChunks} failed after ${MAX_CHUNK_RETRIES} attempts: status=${res.status}, activity=${activity}, error=${text.substring(0, 300)}`
        );
      }
    } catch (fetchErr) {
      if (attempt < MAX_CHUNK_RETRIES) {
        console.warn(
          `[logInventoryChangeToApi] Chunk ${chunkIndex}/${totalChunks} exception (attempt ${attempt}), retrying: ${fetchErr?.message}`
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(
          `[logInventoryChangeToApi] Chunk ${chunkIndex}/${totalChunks} exception after ${MAX_CHUNK_RETRIES} attempts: activity=${activity}, error=${fetchErr?.message}`
        );
      }
    }
  }
  return false;
}

export async function logInventoryChangeToApi({
  activity,
  locationId,
  locationName = "",
  deltas,
  sourceId = null,
  lineItems = null,
  adjustmentGroupId = null,
}) {
  const session = globalThis?.shopify?.session;

  console.log(`[logInventoryChangeToApi] Called: activity=${activity}, locationId=${locationId}, deltas.length=${deltas?.length || 0}`);

  if (!session?.getSessionToken) {
    console.warn(`[logInventoryChangeToApi] No session or getSessionToken: session=${!!session}, getSessionToken=${!!session?.getSessionToken}`);
    return;
  }

  if (!deltas?.length) {
    console.warn(`[logInventoryChangeToApi] No deltas: deltas.length=${deltas?.length || 0}`);
    return;
  }

  try {
    const token = await session.getSessionToken();
    if (!token) {
      console.warn(`[logInventoryChangeToApi] Failed to get session token`);
      return;
    }

    const { getAppUrl } = await import("./appUrl.js");
    const appUrl = getAppUrl();
    const apiUrl = `${appUrl}/api/log-inventory-change`;
    const timestamp = new Date().toISOString();
    const locName = locationName || locationId;

    const entries = [];
    for (const d of deltas) {
      if (!d?.inventoryItemId || Number(d?.delta ?? 0) === 0) continue;
      const li = lineItems?.find((l) => String(l?.inventoryItemId || "").trim() === String(d.inventoryItemId).trim());
      const logData = {
        inventoryItemId: d.inventoryItemId,
        variantId: d.variantId ?? li?.variantId ?? null,
        sku: d.sku ?? li?.sku ?? "",
        locationId,
        locationName: locName,
        activity,
        delta: Number(d.delta),
        quantityAfter: d.quantityAfter ?? null,
        sourceId: sourceId || null,
        timestamp,
      };
      if (adjustmentGroupId != null) logData.adjustmentGroupId = adjustmentGroupId;
      entries.push(logData);
    }

    if (entries.length === 0) {
      console.warn(`[logInventoryChangeToApi] No valid entries after filtering`);
      return;
    }

    // 大量件数でタイムアウトによる途中切れを防ぐため、チャンクに分けて送信する
    const chunkSize = LOG_INVENTORY_CHANGE_CHUNK_SIZE;
    const chunks = [];
    for (let i = 0; i < entries.length; i += chunkSize) {
      chunks.push(entries.slice(i, i + chunkSize));
    }
    if (chunks.length > 1) {
      console.log(`[logInventoryChangeToApi] Sending in ${chunks.length} chunks (${chunkSize} entries each) to avoid timeout`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const body = chunk.length === 1 ? chunk[0] : { entries: chunk };
      await sendChunkWithRetry(apiUrl, token, body, activity, i + 1, chunks.length);
    }
  } catch (e) {
    console.error(`[logInventoryChangeToApi] Exception: activity=${activity}, locationId=${locationId}, error=${e?.message || String(e)}`, e);
  }
}
