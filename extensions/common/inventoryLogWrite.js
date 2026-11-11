/**
 * 在庫変更履歴の書き込み結果を分類する純粋関数。
 * 在庫反映そのものとは分離し、再送は同じ idempotency key / appEventId に寄せる。
 */

export function toRawId(id) {
  if (id == null) return "";
  const s = String(id).trim();
  if (!s) return "";
  if (s.startsWith("gid://")) {
    const last = s.split("/").pop();
    return last || s;
  }
  return s;
}

/**
 * @returns {"duplicate_idempotency"|"db_unavailable"|"auth_failed"|"invalid_entry"|"unknown"}
 */
export function classifyInventoryLogWriteError(error) {
  const status = error instanceof Response ? error.status : Number(error?.status);
  if (status === 401 || status === 403) {
    return {
      code: "auth_failed",
      retryable: true,
      idempotentSuccess: false,
      message: "Session token rejected",
    };
  }

  const prismaCode = typeof error?.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error?.message || error || "Unknown error");
  const target = Array.isArray(error?.meta?.target) ? error.meta.target.map(String) : [];
  const duplicateKey =
    prismaCode === "P2002" &&
    (target.length === 0 || target.some((t) => /idempotency/i.test(t)));
  if (duplicateKey || /unique constraint/i.test(message) && /idempotency/i.test(message)) {
    return {
      code: "duplicate_idempotency",
      retryable: false,
      idempotentSuccess: true,
      message: "Log already exists",
    };
  }

  if (
    prismaCode === "P1001" ||
    prismaCode === "P1002" ||
    prismaCode === "P1008" ||
    prismaCode === "P1017" ||
    /can't reach database|timed? ?out|econnreset|econnrefused|connection reset/i.test(message)
  ) {
    return {
      code: "db_unavailable",
      retryable: true,
      idempotentSuccess: false,
      message: message.slice(0, 300) || "Database unavailable",
    };
  }

  if (/missing required fields/i.test(message)) {
    return {
      code: "invalid_entry",
      retryable: false,
      idempotentSuccess: false,
      message: "Missing required fields",
    };
  }

  return {
    code: "unknown",
    retryable: false,
    idempotentSuccess: false,
    message: message.slice(0, 300) || "Unknown error",
  };
}

export function isHistoryIncompleteSummary(errorSummary) {
  if (typeof errorSummary !== "string" || !errorSummary) return false;
  return (
    errorSummary.startsWith("history_incomplete:") ||
    errorSummary.startsWith("post_process_error_after_completed:") ||
    errorSummary.startsWith("post_process_error_after_shopify:")
  );
}

/**
 * completed の再送で Shopify を再実行してよいか。
 * 履歴未完了だけなら履歴の upsert に限る。
 * @returns {"retry_history_only"|"return_completed"|"continue"}
 */
export function decideCompletedEventRetry(event) {
  const status = event?.status ?? "";
  if (status === "completed" && isHistoryIncompleteSummary(event?.errorSummary)) {
    return { action: "retry_history_only" };
  }
  if (status === "completed") return { action: "return_completed" };
  return { action: "continue" };
}

export function historyNoteForAppEvent(appEventId) {
  const id = typeof appEventId === "string" ? appEventId.trim() : "";
  return id ? `appEventId:${id}` : null;
}

export function noteMatchesAppEvent(note, appEventId) {
  if (typeof note !== "string" || !appEventId) return false;
  const prefix = `appEventId:${appEventId}`;
  if (note === prefix) return true;
  if (!note.startsWith(prefix)) return false;
  const next = note.charAt(prefix.length);
  return next === ";" || next === "|" || next === " " || next === ",";
}

export function appEventNoteWhere(appEventId) {
  const exact = `appEventId:${appEventId}`;
  return {
    OR: [
      { note: exact },
      { note: { startsWith: `${exact};` } },
      { note: { startsWith: `${exact}|` } },
      { note: { startsWith: `${exact} ` } },
    ],
  };
}

/**
 * 直近の同一 activity 行を上書きしてよいか。
 * 別 appEventId の行は別操作なので新規作成する。
 * @returns {"update"|"create"}
 */
export function resolveSameActivityAction({
  incomingAppEventId = null,
  existingNote = null,
  existingSourceId = null,
  incomingSourceId = null,
  existingDelta = null,
  incomingDelta = null,
}) {
  if (incomingAppEventId && noteMatchesAppEvent(existingNote, incomingAppEventId)) return "update";
  if (
    incomingAppEventId &&
    typeof existingNote === "string" &&
    existingNote.includes("appEventId:") &&
    !noteMatchesAppEvent(existingNote, incomingAppEventId)
  ) {
    return "create";
  }
  const sameSource = String(incomingSourceId || "") === String(existingSourceId || "");
  const sameDelta =
    incomingDelta == null || existingDelta == null || Number(existingDelta) === Number(incomingDelta);
  if (sameSource && sameDelta) return "update";
  return "create";
}

export function buildInventoryLogIdempotencyKey({
  shop,
  appEventId = null,
  activity,
  inventoryItemId,
  locationId,
  sourceId = null,
  timestampIso = "",
}) {
  const item = toRawId(inventoryItemId);
  const loc = toRawId(locationId);
  const eventId = typeof appEventId === "string" ? appEventId.trim() : "";
  if (eventId) return `${shop}_app_${eventId}_${item}_${loc}`;
  if (sourceId) return `${shop}_${activity}_${item}_${loc}_${sourceId}`;
  return `${shop}_${activity}_${item}_${loc}_${timestampIso}`;
}

export function summarizeLogWriteBatch(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => !r || r.ok === false);
  if (failed.length === 0) {
    return { ok: true, httpStatus: 200, failedCount: 0, results: list };
  }
  const codes = failed.map((r) => r?.errorCode || "unknown");
  let errorCode = "partial_entry_failure";
  let httpStatus = 422;
  if (failed.length === list.length && codes.every((c) => c === "invalid_entry")) {
    errorCode = "invalid_entry";
    httpStatus = 400;
  } else if (failed.length === list.length && codes.every((c) => c === "db_unavailable")) {
    errorCode = "db_unavailable";
    httpStatus = 503;
  } else if (failed.length === list.length && codes.every((c) => c === "auth_failed")) {
    errorCode = "auth_failed";
    httpStatus = 401;
  } else if (codes.some((c) => c === "db_unavailable" || c === "unknown")) {
    errorCode = "partial_entry_failure";
    httpStatus = 503;
  }
  const error = failed
    .map((r) => r?.error)
    .filter(Boolean)
    .join("; ")
    .slice(0, 300) || errorCode;
  return { ok: false, httpStatus, errorCode, error, failedCount: failed.length, results: list };
}

/**
 * POS が履歴 API の応答を成功とみなすか。
 * 複数件の HTTP 200 でも、明細の失敗や historyIncomplete は成功にしない。
 */
export function interpretLogChunkResponse(httpStatus, data) {
  const status = Number(httpStatus);
  const body = data && typeof data === "object" ? data : {};
  const code = typeof body.errorCode === "string" ? body.errorCode : null;
  if (code === "duplicate_idempotency" || body.message === "Log already exists") {
    return { success: true, retryable: false, errorCode: "duplicate_idempotency" };
  }
  const results = Array.isArray(body.results) ? body.results : null;
  const entryFailed = Boolean(results?.some((r) => r && r.ok === false));
  if (body.historyIncomplete === true || code === "history_incomplete") {
    return { success: false, retryable: true, errorCode: "history_incomplete" };
  }
  if (status >= 200 && status < 300 && body.ok !== false && !entryFailed) {
    return { success: true, retryable: false, errorCode: null };
  }
  if (code === "auth_failed" || status === 401 || status === 403) {
    return { success: false, retryable: true, errorCode: "auth_failed" };
  }
  if (code === "invalid_entry") {
    return { success: false, retryable: false, errorCode: "invalid_entry" };
  }
  if (code === "db_unavailable" || status === 429 || (status >= 500 && status < 600)) {
    return { success: false, retryable: true, errorCode: code || "db_unavailable" };
  }
  if (code === "partial_entry_failure" || entryFailed || status === 422) {
    return { success: false, retryable: true, errorCode: code || "partial_entry_failure" };
  }
  return { success: false, retryable: false, errorCode: code || "unknown" };
}

/**
 * Shopify を呼ばず、completed イベントの明細から履歴行を upsert する。
 * 同じ key の再送は行を増やさない。
 */
export async function replayCompletedHistory(db, args) {
  const lines = Array.isArray(args?.lines) ? args.lines : [];
  let written = 0;
  for (const line of lines) {
    try {
      const idempotencyKey = buildInventoryLogIdempotencyKey({
        shop: args.shop,
        appEventId: args.appEventId,
        activity: args.activity,
        inventoryItemId: line.inventoryItemId,
        locationId: args.locationId,
      });
      const rawItemId = toRawId(line.inventoryItemId);
      const rawLocId = toRawId(args.locationId);
      const quantityAfter = line.quantityAfter ?? null;
      await db.inventoryChangeLog.upsert({
        where: { shop_idempotencyKey: { shop: args.shop, idempotencyKey } },
        create: {
          shop: args.shop,
          timestamp: args.requestedAt,
          date: args.date,
          inventoryItemId: rawItemId,
          variantId: line.variantId ?? null,
          sku: line.sku ?? "",
          locationId: rawLocId,
          locationName: args.locationName || rawLocId,
          activity: args.activity,
          delta: line.delta ?? null,
          quantityAfter,
          sourceType: args.activity,
          sourceId: args.sourceId ?? null,
          idempotencyKey,
          note: historyNoteForAppEvent(args.appEventId),
        },
        update: {
          delta: line.delta ?? null,
          quantityAfter,
          activity: args.activity,
          sourceType: args.activity,
          sourceId: args.sourceId ?? null,
          locationName: args.locationName || rawLocId,
          note: historyNoteForAppEvent(args.appEventId),
        },
      });
      written += 1;
    } catch (error) {
      const classified = classifyInventoryLogWriteError(error);
      if (classified.idempotentSuccess) {
        written += 1;
        continue;
      }
      return { ok: false, written, errorCode: classified.code, error: classified.message };
    }
  }
  return { ok: true, written };
}
