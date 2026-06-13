/**
 * 入出庫の在庫調整を apply-change API 経由で実行（appEventId 冪等性・履歴一元化）
 */
import { applyInventoryChangeToApi } from "./applyInventoryChange.js";

const CHUNK_SIZE = 250;

/**
 * 転送系在庫調整の安定した appEventId（同一操作のリトライで二重加算しない）
 */
export function buildTransferAdjustAppEventId({ operation, transferId, shipmentId, locationId }) {
  const tid = String(transferId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 48);
  const sid = shipmentId
    ? String(shipmentId)
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(-24)
    : "";
  const loc = String(locationId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(-24);
  const op = String(operation || "transfer_adjust").trim();
  return `evt_${op}_${tid}${sid ? `_${sid}` : ""}_${loc}`;
}

function chunkAppEventId(baseId, chunkIndex, totalChunks) {
  if (totalChunks <= 1) return baseId;
  return `${baseId}_c${chunkIndex + 1}of${totalChunks}`;
}

/**
 * @param {Object} opts
 * @param {string} opts.locationId
 * @param {Array<{inventoryItemId: string, delta: number, variantId?: string, sku?: string}>} opts.deltas
 * @param {string|null} [opts.referenceDocumentUri] - Transfer ID（数値または GID 末尾）
 * @param {"inbound_transfer"|"outbound_transfer"} [opts.activity]
 * @param {string|null} [opts.appEventId] - 省略時は operation 等から自動生成
 * @param {string} [opts.operation] - appEventId 自動生成用
 * @param {string} [opts.locationName]
 * @param {string|null} [opts.sourceId]
 * @param {string|null} [opts.shipmentId]
 */
export async function adjustInventoryAtLocationWithFallback({
  locationId,
  deltas,
  referenceDocumentUri = null,
  activity = "outbound_transfer",
  appEventId = null,
  operation = "transfer_adjust",
  locationName = "",
  sourceId = null,
  shipmentId = null,
}) {
  const changes = (deltas ?? [])
    .filter((x) => x?.inventoryItemId && Number(x?.delta || 0) !== 0)
    .map((x) => ({
      inventoryItemId: String(x.inventoryItemId).trim(),
      delta: Number(x.delta),
      variantId: x.variantId ?? undefined,
      sku: x.sku ?? undefined,
    }));

  if (!locationId || changes.length === 0) return { ok: true, appliedCount: 0 };

  const refId = sourceId || referenceDocumentUri;
  const baseEventId =
    appEventId ||
    buildTransferAdjustAppEventId({
      operation,
      transferId: refId,
      shipmentId,
      locationId,
    });

  const chunks = [];
  for (let i = 0; i < changes.length; i += CHUNK_SIZE) {
    chunks.push(changes.slice(i, i + CHUNK_SIZE));
  }

  let lastResult = { ok: true, appliedCount: 0 };
  for (let ci = 0; ci < chunks.length; ci++) {
    lastResult = await applyInventoryChangeToApi({
      appEventId: chunkAppEventId(baseEventId, ci, chunks.length),
      activity,
      locationId,
      locationName,
      sourceId: refId || null,
      referenceDocumentUri: referenceDocumentUri || refId || null,
      entries: chunks[ci],
    });
  }
  return lastResult;
}
