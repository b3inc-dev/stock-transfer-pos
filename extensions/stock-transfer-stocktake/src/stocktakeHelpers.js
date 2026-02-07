/**
 * POS UI 公式 Badge（s-badge）用の tone（棚卸ステータス用）
 * バッジにはメインのステータスのみ表示する
 */
export function getStatusBadgeTone(statusLabel) {
  const s = String(statusLabel || "").trim();
  if (!s) return "neutral";
  if (/下書き/i.test(s)) return "caution";
  if (/処理中/i.test(s)) return "info";
  if (/完了|処理済み/i.test(s)) return "success";
  if (/キャンセル/i.test(s)) return "critical";
  if (/未処理/i.test(s)) return "neutral";
  return "neutral";
}
