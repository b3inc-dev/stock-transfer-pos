/**
 * POS 明細リスト用「前へ / 次へ」コントロール。
 * getListPageSlice の戻り値を渡す。
 */
export function ListPageControls({ pageInfo, onPageChange }) {
  if (!pageInfo?.showPagination) return null;
  const { rangeStart, rangeEnd, total, currentPage, totalPages } = pageInfo;
  const goPrev = () => onPageChange?.(Math.max(1, currentPage - 1));
  const goNext = () => onPageChange?.(Math.min(totalPages, currentPage + 1));
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
