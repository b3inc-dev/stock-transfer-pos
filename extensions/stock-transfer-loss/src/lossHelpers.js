/**
 * POS UI 公式 Badge（s-badge）用の tone（ロスステータス用）
 * バッジにはメインのステータスのみ表示する
 */
export function getStatusBadgeTone(statusLabel) {
  const s = String(statusLabel || "").trim();
  if (!s) return "neutral";
  if (/キャンセル/i.test(s)) return "critical";
  if (/登録済み/i.test(s)) return "success";
  return "neutral";
}
