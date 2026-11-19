// 再送で取得できた表示用項目だけを、現在も欠けている場合に補う。
export async function repairInventoryLogMetadata(log, existingLog, shop, { locationIdRaw, locationName, variantId, sku }) {
  const row = { id: existingLog.id, shop };
  if (locationName !== locationIdRaw && existingLog.locationName === locationIdRaw) {
    await log.updateMany({
      where: { ...row, locationName: locationIdRaw },
      data: { locationName },
    });
  }
  if (variantId && existingLog.variantId === null) {
    await log.updateMany({
      where: { ...row, variantId: null },
      data: { variantId },
    });
  }
  if (sku && variantId && existingLog.sku === "") {
    await log.updateMany({
      where: { ...row, sku: "", variantId },
      data: { sku },
    });
  }
}

// 売上・返品が通知を最初に記帳した場合、注文IDを含む別形式のキーになる。
export async function findOrderLinkedReplay(log, { shop, inventoryItemId, locationId, quantityAfter, timestamp }) {
  const suffix = "_" + timestamp.toISOString();
  const prefix = (activity) => `${shop}_${activity}_${inventoryItemId}_${locationId}_`;
  const rows = await log.findMany({
    where: {
      shop, inventoryItemId, locationId, quantityAfter, timestamp,
      OR: ["order_sales", "refund"].map(activity => ({
        activity, idempotencyKey: { startsWith: prefix(activity), endsWith: suffix },
      })),
    },
    take: 2,
  });
  if (rows.length !== 1) return null;
  const row = rows[0];
  return row.sourceId?.startsWith("order_") &&
    row.idempotencyKey === prefix(row.activity) + row.sourceId + suffix ? row : null;
}
