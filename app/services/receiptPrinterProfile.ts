/** 出力時だけ適用する機器補正。保存済み帳票・金額・Liquid は書き換えない。 */
export const PRINTER_PROFILE_OPTIONS = [
  { value: "standard", label: "標準（補正なし）" },
  { value: "mpop_58", label: "mPOP・58mm" },
  { value: "mcp31lb_58", label: "58mmの横縮み・右端欠けを補正（MCP31LBで確認）" },
];
export type ReceiptPrinterProfile = "standard" | "mpop_58" | "mcp31lb_58";
export const MC_PRINT3_HELP_URL = "https://help.shopify.com/en/manual/sell-in-person/hardware/receipt-printers/mC-Print3/troubleshooting";
export function normalizePrinterProfile(value: unknown): ReceiptPrinterProfile {
  return value === "mpop_58" || value === "mcp31lb_58" ? value : "standard";
}
export function printerGeometry(value: unknown, paper: 58 | 80) {
  const profile = paper === 58 ? normalizePrinterProfile(value) : "standard";
  return {
    profile,
    // 実測: mPOP 100px=12mm、MCP31LB 横8mm/縦12mm。
    viewportPx: profile === "mcp31lb_58" ? 600 : profile === "mpop_58" ? 400 : undefined,
    horizontalScale: profile === "mcp31lb_58" ? 2 / 3 : 1,
  };
}
const MARKER = 'data-receipt-printer-profile="mcp31lb_58"';
/** ブロック・手書きLiquid・旧帳票に同じ補正。二重適用はしない。 */
export function applyPrinterProfile(html: string, value: unknown, paper: 58 | 80): string {
  if (printerGeometry(value, paper).profile !== "mcp31lb_58" || html.includes(MARKER)) return html;
  // 診断Bを手書きで貼った帳票には重ねない。既存検証用テンプレートとの互換。
  if (/class=["'][^"']*\bmcp-correction\b/.test(html)) return html;
  const start = /<body\b[^>]*>/i.exec(html);
  const end = /<\/body\s*>/i.exec(html);
  if (!start || !end || end.index < start.index) {
    // カスタムLiquidはHTML断片も許す。印字時のwithPrintCspと同じ文書化を行う。
    return applyPrinterProfile(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"/></head><body>${html}</body></html>`, value, paper);
  }
  // 旧帳票のhtml/body固定mm幅を機器の全幅へ戻す。内側の内容・字体・余白は保持。
  const style = `<style ${MARKER}>html,body{width:100%!important;max-width:100%!important;min-width:0!important}body>div[data-receipt-printer-content]{width:64%!important;max-width:none!important;transform:scaleX(1.5)!important;transform-origin:top left!important}</style>`;
  const bodyStart = start.index + start[0].length;
  return html.slice(0, bodyStart) + style + '<div data-receipt-printer-content="1">' + html.slice(bodyStart, end.index) + '</div>' + html.slice(end.index);
}
