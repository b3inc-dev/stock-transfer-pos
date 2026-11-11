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
        locationId: locationIdOf(pending.locationId),
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
function operationRecord(operation) {
  const kept = keptOperation(operation);
  if (!kept) return null;
  return {
    ...kept,
    locationId: locationIdOf(operation.locationId),
    lines: Array.isArray(operation.lines) ? operation.lines : [],
  };
}

export function appliedOperationsByLocation(saved) {
  const map = {};
  const raw = saved?.appliedOperationsByLocation;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, op] of Object.entries(raw)) {
      const loc = locationIdOf(op?.locationId) || locationIdOf(key);
      const record = operationRecord({ ...op, locationId: loc });
      if (record) map[loc] = { ...record, locationId: loc };
    }
  }
  const legacy = operationRecord(saved?.appliedOperation);
  if (legacy) {
    const loc = legacy.locationId || locationIdOf(saved?.conds?.locationId);
    if (loc && !map[loc]) map[loc] = { ...legacy, locationId: loc };
  }
  return map;
}

export function planDraftRestore(saved, currentLocationId) {
  const current = locationIdOf(currentLocationId);
  const savedLocation = locationIdOf(saved?.conds?.locationId);
  const map = appliedOperationsByLocation(saved);
  const operation = current ? map[current] || null : null;
  if (operation && operation.lines.length > 0) {
    return { restore: true, operation, lines: operation.lines };
  }
  if (savedLocation && current && savedLocation !== current) {
    return { restore: false, operation: null, lines: [] };
  }
  const lines = Array.isArray(saved?.lines) ? saved.lines : [];
  if (!lines.length) return { restore: false, operation: null, lines: [] };
  return { restore: true, operation: null, lines };
}

/** 修復待ちの再確定は、最初に在庫へ出した明細だけを使う。 */
export function resolveConfirmLines(operation, currentLines) {
  if (Array.isArray(operation?.lines) && operation.lines.length > 0) return operation.lines;
  return Array.isArray(currentLines) ? currentLines : [];
}

export function appliedOperationFromDraft(saved, currentLocationId) {
  const map = appliedOperationsByLocation(saved);
  const current = locationIdOf(currentLocationId);
  if (current && map[current]) return map[current];
  if (!current) {
    const values = Object.values(map);
    if (values.length === 1) return values[0];
  }
  return null;
}

function writeOperationMap(saved, map) {
  const next = { ...(saved || {}) };
  delete next.appliedOperation;
  if (Object.keys(map).length > 0) next.appliedOperationsByLocation = map;
  else delete next.appliedOperationsByLocation;
  return next;
}

export function mergeDraftAppliedOperation(draft, operation, existingSaved = null) {
  const map = appliedOperationsByLocation(existingSaved);
  const record = operationRecord({
    ...operation,
    locationId: locationIdOf(operation?.locationId) || locationIdOf(draft?.conds?.locationId),
  });
  if (record) map[record.locationId || ""] = { ...record, locationId: record.locationId };
  return writeOperationMap({ ...(existingSaved || {}), ...(draft || {}) }, map);
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
  const locationId = locationIdOf(operation.locationId) || locationIdOf(saved?.conds?.locationId);
  const savedLocation = locationIdOf(saved?.conds?.locationId);
  const draft = { ...saved };
  if (!savedLocation || savedLocation === locationId) {
    if (lines.length) draft.lines = lines;
    draft.conds = { ...(saved.conds || {}), ...(locationId ? { locationId } : {}) };
  }
  const next = mergeDraftAppliedOperation(draft, { ...operation, lines, locationId }, saved);
  await storage.set(key, next);
  return next;
}

/** この店舗の下書きと修復待ちだけを外し、他店舗の修復待ちは残す。 */
export async function clearLocationDraft(storage, key, locationId) {
  if (!storage?.get || !storage?.set) {
    if (storage?.delete) await storage.delete(key);
    return null;
  }
  const saved = (await storage.get(key)) || null;
  if (!saved) {
    if (storage.delete) await storage.delete(key);
    return null;
  }
  const current = locationIdOf(locationId) || locationIdOf(saved?.conds?.locationId);
  const map = appliedOperationsByLocation(saved);
  if (current) delete map[current];
  const savedLocation = locationIdOf(saved?.conds?.locationId);
  const clearingVisibleDraft = !savedLocation || !current || savedLocation === current;
  if (Object.keys(map).length === 0 && clearingVisibleDraft) {
    if (storage.delete) await storage.delete(key);
    else await storage.set(key, null);
    return null;
  }
  const next = writeOperationMap(saved, map);
  if (clearingVisibleDraft) next.lines = [];
  await storage.set(key, next);
  return next;
}
