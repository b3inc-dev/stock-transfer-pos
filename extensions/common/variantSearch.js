/** Shared product-name / SKU / barcode search rules from the loss screen. */
export function buildVariantSearchQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) return "";

  const isDigitsOnly = /^\d+$/.test(q);
  const hasAlpha = /[A-Za-z]/.test(q);
  const hasSkuLikeSymbol = /[-_./]/.test(q);

  const parts = [];

  // ✅ 1文字から検索可能に変更
  // バーコード検索：数字のみの場合（1文字以上）
  if (isDigitsOnly) {
    // 8桁以上なら barcode 検索、それ以下は通常検索
    if (q.length >= 8) {
      parts.push(`barcode:${q}`);
    } else {
      parts.push(q); // 短い数字も通常検索に含める
    }
  }

  // SKU検索：英字や記号が含まれる場合（1文字以上）
  if (hasAlpha || hasSkuLikeSymbol) {
    parts.push(`sku:${q}`);
  }

  // フリーテキスト検索：1文字から検索可能
  parts.push(q);

  // 重複を除去して結合
  const uniq = Array.from(new Set(parts));
  return uniq.join(" OR ");
}

