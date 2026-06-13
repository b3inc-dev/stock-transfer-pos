/**
 * エントリ ID 等から安定した appEventId を生成（リトライ・再確定で二重加算しない）
 */
export function buildStableAppEventId(operation, sourceId, extra = "") {
  const sid = String(sourceId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 48);
  const ext = extra
    ? `_${String(extra)
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(-32)}`
    : "";
  const op = String(operation || "op").trim();
  return `evt_${op}_${sid}${ext}`;
}

/**
 * 入庫受領ログ用：同一受領バッチのリトライで二重記録しない（別バッチは別 ID）
 */
export function buildInboundReceiveLogAppEventId({ transferId, locationId, deltas, finalize = false }) {
  const deltaKey = (deltas ?? [])
    .filter((d) => d?.inventoryItemId && Number(d?.delta || 0) !== 0)
    .map((d) => `${String(d.inventoryItemId).slice(-16)}:${Number(d.delta)}`)
    .sort()
    .join("_")
    .slice(0, 80);
  const loc = String(locationId || "").slice(-16);
  const fin = finalize ? "fin" : "part";
  return buildStableAppEventId("inbound_receive", transferId, `${loc}_${fin}_${deltaKey}`);
}
