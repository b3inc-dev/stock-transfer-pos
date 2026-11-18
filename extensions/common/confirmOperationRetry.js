/**
 * 確定ボタンの再押下で、結果がまだ分からない・在庫適用済みの操作IDを使い回す。
 * 応答なしのあとや履歴だけ失敗したあとに新しい ID を発行すると、別イベントとして在庫がもう一度動く。
 *
 * ID を手放してよいのは、サーバーが「完了」を返したとき（画面側で消す）と、
 * サーバーがはっきり断ったとき（`finalRejection`。同じ ID で送り直しても答えが変わらない）だけ。
 * 応答なし・時間切れ・5xx・処理中・確定後のローカル保存の失敗など、結果が分からない失敗では残す。
 */
export function shouldReuseOperationAfterError(error) {
  if (error && typeof error === "object") {
    if (error.code === "history_incomplete") return true;
    if (error.inventoryApplied === true) return true;
    if (error.finalRejection === true) return false;
  }
  return true;
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
  const current = keptOperation(operation);
  const previous = keptOperation(previousPending);
  // はっきり断られた ID は手放す。別の ID の修復待ちが前から残っていれば、そちらは残す。
  const base = shouldReuseOperationAfterError(error)
    ? current || previous
    : previous && previous.appEventId !== current?.appEventId
      ? previous
      : null;
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

/**
 * 送る中身の目印（商品と数量）。並び順・表示用の項目・在庫数の読み直しでは変わらない。
 * 出庫のチェックポイントの fingerprint（D3b）と同じ考え方。
 */
function lineKey(line) {
  return String(line?.variantId || line?.inventoryItemId || "").trim();
}

export function confirmLinesSignature(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((l) => lineKey(l))
    .map((l) => `${lineKey(l)}:${Number(l?.qty ?? l?.quantity ?? 0) || 0}`)
    .sort()
    .join("|");
}

/**
 * 残っている操作の明細と、いま画面にある明細が違うか。
 * 違うまま同じ ID で送ると、サーバーは前の中身で「完了」を返し、画面の変更が黙って消える。
 * 新しい ID で送ると、前の送信が届いていた場合に在庫がもう一度動く。どちらも避けるため、送らずに明細を戻す。
 */
export function pendingLinesChanged(operation, currentLines) {
  const frozen = Array.isArray(operation?.lines) ? operation.lines : [];
  if (frozen.length === 0) return false;
  return confirmLinesSignature(frozen) !== confirmLinesSignature(currentLines);
}

export const PENDING_LINES_RESTORED_MESSAGE =
  "前回の確定の結果がまだ分からないため、前回の明細に戻しました。この明細のまま「確定」をもう一度押してください（同じ確定のため在庫は二重に変わりません）。";

export const PENDING_RESET_BLOCKED_MESSAGE =
  "前回の確定がまだ終わっていないため、確定した明細のままもう一度「確定」を押してください（在庫は二重に変わりません）";

/**
 * 送る前に、操作 ID を明細と一緒に端末へ残す。
 * 応答が無いまま画面を閉じても、次に開いたときに同じ ID で送り直せる。
 * 保存に失敗しても確定は止めない（ID は画面のメモリに残っている）。
 */
export async function rememberOperationBeforeSend(storage, key, operation) {
  try {
    await saveAppliedOperation(storage, key, operation);
    return true;
  } catch (e) {
    console.warn("[confirmOperationRetry] failed to save operation before send:", e?.message ?? e);
    return false;
  }
}

/** 修復待ち・結果待ちの再確定は、最初に送った明細だけを使う。 */
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

const draftWriteQueues = new Map();

/** 同じ下書きキーの読み取りから書き込みまでを直列化し、古いスナップショットの上書きを防ぐ。 */
function enqueueDraftWrite(key, task) {
  const prev = draftWriteQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  draftWriteQueues.set(key, run.catch(() => {}));
  return run;
}

export async function saveScreenDraft(storage, key, draft, pendingOperation = null) {
  return enqueueDraftWrite(key, async () => {
    if (!storage?.set) return null;
    const existing = storage.get ? (await storage.get(key)) || null : null;
    const operation = pendingOperation
      ? { ...pendingOperation, locationId: locationIdOf(pendingOperation.locationId) || locationIdOf(draft?.conds?.locationId) }
      : null;
    const next = mergeDraftAppliedOperation(draft, operation, existing);
    await storage.set(key, next);
    return next;
  });
}

export async function saveAppliedOperation(storage, key, operation) {
  return enqueueDraftWrite(key, async () => {
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
  });
}

/** この店舗の残っている操作 ID だけを外す（明細の下書きは残す）。サーバーがはっきり断ったとき用。 */
export async function forgetOperation(storage, key, locationId) {
  return enqueueDraftWrite(key, async () => {
    if (!storage?.get || !storage?.set) return null;
    const saved = (await storage.get(key)) || null;
    if (!saved) return null;
    const map = appliedOperationsByLocation(saved);
    const current = locationIdOf(locationId) || locationIdOf(saved?.conds?.locationId);
    if (!current || !map[current]) return saved;
    delete map[current];
    const next = writeOperationMap(saved, map);
    await storage.set(key, next);
    return next;
  });
}

/**
 * 確定が失敗したあと、端末の保存を画面のメモリと揃える。
 * 残す ID があれば保存し、無ければ（はっきり断られた）送る前に残した ID を消す。
 * 消し忘れると、開き直したときに断られた ID と明細が戻り、確定もリセットもできなくなる。
 */
export async function settleOperationAfterError(storage, key, kept, locationId) {
  try {
    if (kept) return await saveAppliedOperation(storage, key, kept);
    return await forgetOperation(storage, key, locationId);
  } catch (e) {
    console.warn("[confirmOperationRetry] failed to update operation after error:", e?.message ?? e);
    return null;
  }
}

/** この店舗の下書きと修復待ちだけを外し、他店舗の修復待ちは残す。 */
export async function clearLocationDraft(storage, key, locationId) {
  return enqueueDraftWrite(key, async () => {
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
  });
}
