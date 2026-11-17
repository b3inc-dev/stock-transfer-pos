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
