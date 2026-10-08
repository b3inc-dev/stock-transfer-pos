/**
 * POS 明細リストの表示ページネーション（DOM 件数上限）。
 * データ取得の「さらに読み込む」とは別レイヤ。
 * @see docs/STOCKTAKE_POS_LIST_PERFORMANCE_REQUIREMENTS.md
 * @see docs/PERFORMANCE_UX_REQUIREMENTS_ALL_FEATURES.md
 */

/** 1 画面あたりの描画行数（推奨 50） */
export const LIST_ITEMS_PER_PAGE = 50;

/**
 * @param {unknown[]} items
 * @param {number} page 1-based
 * @param {number} [pageSize]
 * @returns {{
 *   total: number,
 *   totalPages: number,
 *   currentPage: number,
 *   startIdx: number,
 *   displayed: unknown[],
 *   showPagination: boolean,
 *   rangeStart: number,
 *   rangeEnd: number,
 * }}
 */
export function getListPageSlice(items, page, pageSize = LIST_ITEMS_PER_PAGE) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Number(pageSize) || LIST_ITEMS_PER_PAGE);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / size) || 1);
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const startIdx = (currentPage - 1) * size;
  const displayed = list.slice(startIdx, startIdx + size);
  return {
    total,
    totalPages,
    currentPage,
    startIdx,
    displayed,
    showPagination: total > size,
    rangeStart: total === 0 ? 0 : startIdx + 1,
    rangeEnd: Math.min(startIdx + size, total),
  };
}
