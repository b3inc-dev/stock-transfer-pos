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
    return {
      operation: {
        entryId,
        appEventId,
        lines: Array.isArray(pending.lines) ? pending.lines : [],
      },
      reused: true,
    };
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

function keptOperation(operation) {
  const entryId = typeof operation?.entryId === "string" ? operation.entryId.trim() : "";
  const appEventId = typeof operation?.appEventId === "string" ? operation.appEventId.trim() : "";
  if (!entryId || !appEventId) return null;
  return { entryId, appEventId };
}

/**
 * 在庫適用済みの ID は、その後の別エラーでも捨てない。
 * 捨てると次の確定が新しいイベントになり、在庫がもう一度動く。
 */
function firstLines(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

export function operationToKeepAfterError(operation, error, previousPending = null, linesSnapshot = null) {
  const base = shouldReuseOperationAfterError(error)
    ? keptOperation(operation) || keptOperation(previousPending)
    : keptOperation(previousPending);
  if (!base) return null;
  return {
    ...base,
    locationId: String(operation?.locationId || previousPending?.locationId || "").trim(),
    lines: firstLines(operation?.lines, previousPending?.lines, linesSnapshot),
  };
}

function locationIdOf(value) {
  return String(value || "").trim();
}

/**
 * 画面を開き直したときの下書き復元。
 * 別ロケーションでは適用済み操作も明細も復元しない。元のロケーションなら履歴修復用に戻す。
 */
export function planDraftRestore(saved, currentLocationId) {
  const current = locationIdOf(currentLocationId);
  const savedLocation = locationIdOf(saved?.conds?.locationId);
  const operation = appliedOperationFromDraft(saved);
  const operationLocation = locationIdOf(operation?.locationId) || savedLocation;
  if (operation && current && operationLocation === current && operation.lines.length > 0) {
    return { restore: true, operation, lines: operation.lines };
  }
  if (savedLocation && current && savedLocation !== current) {
    return { restore: false, operation: null, lines: [] };
  }
  if (operation && current && operationLocation && operationLocation !== current) {
    const lines = Array.isArray(saved?.lines) ? saved.lines : [];
    return { restore: lines.length > 0, operation: null, lines };
  }
  const lines = firstLines(operation?.lines, saved?.lines);
  if (!lines.length) return { restore: false, operation: null, lines: [] };
  return { restore: true, operation, lines };
}

/** 修復待ちの再確定は、最初に在庫へ出した明細だけを使う。 */
export function resolveConfirmLines(operation, currentLines) {
  if (Array.isArray(operation?.lines) && operation.lines.length > 0) return operation.lines;
  return Array.isArray(currentLines) ? currentLines : [];
}

export function appliedOperationFromDraft(saved) {
  const op = saved?.appliedOperation;
  const kept = keptOperation(op);
  if (!kept) return null;
  return {
    ...kept,
    locationId: locationIdOf(op.locationId),
    lines: Array.isArray(op.lines) ? op.lines : [],
  };
}

export function mergeDraftAppliedOperation(draft, operation, existingSaved = null) {
  const next = { ...(draft || {}) };
  const kept = keptOperation(operation);
  if (kept) {
    next.appliedOperation = {
      ...kept,
      locationId: locationIdOf(operation.locationId) || locationIdOf(draft?.conds?.locationId),
      lines: Array.isArray(operation.lines) ? operation.lines : [],
    };
    return next;
  }
  const foreign = appliedOperationFromDraft(existingSaved);
  const foreignLocation = locationIdOf(foreign?.locationId);
  const currentLocation = locationIdOf(draft?.conds?.locationId);
  if (foreign && foreignLocation && currentLocation && foreignLocation !== currentLocation) {
    next.appliedOperation = existingSaved.appliedOperation;
    return next;
  }
  delete next.appliedOperation;
  return next;
}

export async function saveScreenDraft(storage, key, draft, pendingOperation = null) {
  if (!storage?.set) return null;
  const existing = storage.get ? (await storage.get(key)) || null : null;
  const operation = pendingOperation
    ? { ...pendingOperation, locationId: locationIdOf(pendingOperation.locationId) || locationIdOf(draft?.conds?.locationId) }
    : null;
  const next = mergeDraftAppliedOperation(draft, operation, existing);
  await storage.set(key, next);
  return next;
}

export async function saveAppliedOperation(storage, key, operation) {
  if (!storage?.get || !storage?.set || !keptOperation(operation)) return null;
  const saved = (await storage.get(key)) || {};
  const lines = firstLines(operation.lines, saved.lines);
  const next = mergeDraftAppliedOperation(
    { ...saved, ...(lines.length ? { lines } : {}) },
    {
      ...operation,
      lines,
      locationId: locationIdOf(operation.locationId) || locationIdOf(saved?.conds?.locationId),
    },
    saved
  );
  await storage.set(key, next);
  return next;
}
