/**
 * 管理画面の見た目トークン。
 * 正本はホーム（app._index）、設定（app.settings）、入出庫履歴（app.history）、
 * ナビ（AppNavBar）、文字（root.tsx の Inter 読み込み）。
 * 色・余白の数値を変えるときは docs/ADMIN_UI_GUIDELINES.md も更新する。
 */

/** Inter を先に使い、日本語の字形はシステムフォントへ落とす。 */
export const adminFontFamily =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif';

export const adminColors = {
  text: "#202223",
  subdued: "#6d7175",
  /** ナビの選択中・主操作・保存。設定の選択枠もこれに揃える。 */
  interactive: "#2c6ecb",
  selectedBg: "#eff6ff",
  navBg: "#f6f6f7",
  line: "#e1e3e5",
  card: "#ffffff",
  warningBg: "#fff4e5",
  warningBorder: "#e0b252",
  critical: "#d72c0d",
  success: "#008060",
  successBg: "#e3f1df",
} as const;

/** 本文・ナビの目安。ページ見出しは s-page の heading に任せる。 */
export const adminBodyFontSizePx = 14;

/**
 * 在庫明細の数量比較表のセル余白。
 * 行を増やすための密度なので、これより大きくしない。
 */
export const adminQtyCellPaddingPx = 8;
