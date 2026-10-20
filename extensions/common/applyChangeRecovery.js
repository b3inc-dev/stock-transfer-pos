/**
 * apply-change の「応答不明」判定と、appEventId 状態照会結果の解釈（純粋関数）。
 * 同一 appEventId のまま判断するためのもので、新しい appEventId は作らない。
 */

/** WebKit "Load failed" / Chromium "Failed to fetch" / AbortError 等、HTTP 応答を受け取れなかった例外 */
export function isUncertainFetchError(err) {
  if (!err) return false;
  const name = String(err?.name || "");
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (name === "TypeError") return true;
  const msg = String(err?.message || err);
  return /load failed|failed to fetch|network ?error|networkerror|connection (refused|reset|lost)|net::|abort|timed? ?out|timeout/i.test(
    msg
  );
}

/**
 * apply-change の HTTP 応答を分類する。
 * @returns {"success"|"pending"|"partial_failed"|"auth"|"retryable"|"fatal"}
 */
export function classifyApplyChangeResponse(httpStatus, data) {
  const status = Number(httpStatus);
  const evStatus = typeof data?.status === "string" ? data.status : "";
  if (status >= 200 && status < 300 && data?.ok !== false) return "success";
  if (status === 202 || evStatus === "pending" || evStatus === "applying") return "pending";
  if (evStatus === "partial_failed" || data?.partiallyApplied === true) return "partial_failed";
  if (status === 401) return "auth";
  if (status === 429 || (status >= 500 && status < 600)) return "retryable";
  return "fatal";
}

/**
 * statusOnly 照会の応答から次の行動を決める。
 * - completed: 在庫は適用済み → 成功扱い
 * - resend: イベント無し / failed（在庫未適用）→ 同じ appEventId で本リクエストを再送してよい
 * - wait: pending / applying（処理中または固着）→ 再送しない
 * - manual: partial_failed（一部適用済み）→ 再送しない・手動確認
 * - unknown: 照会自体が失敗
 * @returns {"completed"|"resend"|"wait"|"manual"|"unknown"}
 */
export function decideFromEventStatus(statusResp) {
  if (!statusResp || statusResp.ok !== true) return "unknown";
  if (statusResp.found !== true) return "resend";
  switch (statusResp.status) {
    case "completed":
      return "completed";
    case "failed":
      return "resend";
    case "pending":
    case "applying":
      return "wait";
    case "partial_failed":
      return "manual";
    default:
      return "unknown";
  }
}

export const APPLY_PENDING_MESSAGE =
  "在庫調整をサーバーで処理中です。数分待ってから「確定」をもう一度押してください（同じ確定のため在庫は二重に変わりません）。続く場合は管理者に連絡してください。";
export const APPLY_UNCERTAIN_MESSAGE =
  "在庫APIの応答を受け取れませんでした（通信が途切れた可能性）。数分待ってから「確定」をもう一度押してください（同じ確定のため在庫は二重に変わりません）。";
export const APPLY_PARTIAL_MESSAGE =
  "在庫調整が一部だけ反映された可能性があります（partial_failed）。再確定せず管理者に連絡してください。";
