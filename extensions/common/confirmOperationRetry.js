/**
 * 確定ボタンの再押下で、在庫適用済みの操作IDを使い回す。
 * 履歴だけ失敗したあとに新しい ID を発行すると、別イベントとして在庫がもう一度動く。
 */

export function shouldReuseOperationAfterError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === "history_incomplete") return true;
  if (error.inventoryApplied === true) return true;
  return false;
}

/**
 * @param {{ entryId?: string, appEventId?: string } | null} pending
 * @param {() => { entryId: string, appEventId: string }} mint
 */
export function beginConfirmOperation(pending, mint) {
  const entryId = typeof pending?.entryId === "string" ? pending.entryId.trim() : "";
  const appEventId = typeof pending?.appEventId === "string" ? pending.appEventId.trim() : "";
  if (entryId && appEventId) {
    return { operation: { entryId, appEventId }, reused: true };
  }
  const created = mint();
  return {
    operation: {
      entryId: String(created?.entryId || "").trim(),
      appEventId: String(created?.appEventId || "").trim(),
    },
    reused: false,
  };
}

export function operationToKeepAfterError(operation, error) {
  const entryId = typeof operation?.entryId === "string" ? operation.entryId.trim() : "";
  const appEventId = typeof operation?.appEventId === "string" ? operation.appEventId.trim() : "";
  if (!entryId || !appEventId) return null;
  if (!shouldReuseOperationAfterError(error)) return null;
  return { entryId, appEventId };
}
