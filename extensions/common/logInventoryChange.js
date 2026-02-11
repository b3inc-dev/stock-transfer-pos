/**
 * 在庫変動をアプリの api/log-inventory-change に記録する共通関数
 * 出庫・入庫・ロス・棚卸・仕入の全フローでこの1つを使用し、処理を統一する。
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
  
  // デバッグログ: 関数が呼ばれたことを記録
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

    console.log(`[logInventoryChangeToApi] Preparing request: apiUrl=${apiUrl}, activity=${activity}, locationId=${locationId}`);

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

    const body = entries.length === 1 ? entries[0] : { entries };
    console.log(`[logInventoryChangeToApi] Sending request: entries.length=${entries.length}, activity=${activity}`);
    
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[logInventoryChangeToApi] API call failed: status=${res.status}, activity=${activity}, locationId=${locationId}, error=${text}`);
    } else {
      const responseData = await res.json().catch(() => null);
      console.log(`[logInventoryChangeToApi] API call succeeded: activity=${activity}, locationId=${locationId}, response=${JSON.stringify(responseData)}`);
    }
  } catch (e) {
    console.error(`[logInventoryChangeToApi] Exception: activity=${activity}, locationId=${locationId}, error=${e?.message || String(e)}`, e);
  }
}
