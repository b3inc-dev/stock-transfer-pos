/* eslint-disable react/prop-types -- Shared Preact components follow StockProductRowParts. */
/**
 * POS 明細リスト用「前へ / 次へ」コントロール。
 * getListPageSlice の戻り値を渡す。
 */
export function ListPageControls({ pageInfo, onPageChange, modern = false, disabled = false }) {
  if (!pageInfo?.showPagination) return null;
  const { rangeStart, rangeEnd, total, currentPage, totalPages } = pageInfo;
  const goPrev = () => onPageChange?.(Math.max(1, currentPage - 1));
  const goNext = () => onPageChange?.(Math.min(totalPages, currentPage + 1));
  if (modern) return <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
    <s-button disabled={disabled || currentPage <= 1} onClick={goPrev}>前へ</s-button>
    <s-text type="small" color="subdued">{rangeStart}–{rangeEnd} / 全{total}件</s-text>
    <s-button disabled={disabled || currentPage >= totalPages} onClick={goNext}>次へ</s-button>
  </s-stack>;
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-text tone="subdued" size="small">
        {rangeStart}–{rangeEnd} / 全{total}件
      </s-text>
      <s-button
        kind="secondary"
        size="slim"
        disabled={currentPage <= 1}
        onClick={goPrev}
        onPress={goPrev}
      >
        前へ
      </s-button>
      <s-button
        kind="secondary"
        size="slim"
        disabled={currentPage >= totalPages}
        onClick={goNext}
        onPress={goNext}
      >
        次へ
      </s-button>
    </s-stack>
  );
}
