/**
 * Transfer の状態の言葉とバッジの色（UI ルール v1.1 5章: 状態は文字でなくバッジ、色は意味で決める）。
 * 入出庫の一覧と詳細で同じ言葉・同じ色にする。
 */
export const TRANSFER_STATUS_LABEL: Record<string, string> = {
  DRAFT: "下書き",
  READY_TO_SHIP: "配送準備完了",
  IN_PROGRESS: "処理中",
  IN_TRANSIT: "進行中",
  RECEIVED: "受領",
  TRANSFERRED: "入庫済み",
  CANCELED: "キャンセル",
  OTHER: "その他",
};

export type TransferStatusTone = "success" | "info" | "neutral";

/** 緑＝終わった（受領・入庫済み）、灰＝止めた・終わった（下書き・キャンセル）、青＝進んでいる（それ以外）。 */
export function transferStatusTone(status: string): TransferStatusTone {
  if (status === "RECEIVED" || status === "TRANSFERRED") return "success";
  if (status === "DRAFT" || status === "CANCELED") return "neutral";
  return "info";
}

export function transferStatusLabel(status: string): string {
  return TRANSFER_STATUS_LABEL[status] || status;
}
