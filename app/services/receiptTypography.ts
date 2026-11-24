import { resolvePaperPrintStyle, type FontFamily, type ReceiptLayout } from "./receiptLayoutSchema";

// Same font stacks and paper-specific size resolution as POS Receipt settlement printing.
const FONT_STACKS: Record<FontFamily, string> = {
  sans: '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif',
  serif: '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", serif',
  mono: 'ui-monospace, "SFMono-Regular", "Noto Sans Mono", monospace',
};
export function receiptTypography(layout: Pick<ReceiptLayout, "paperWidthMm" | "style" | "paperStyles">) {
  const paper = resolvePaperPrintStyle(layout);
  return {
    fontFamily: FONT_STACKS[layout.style.fontFamily],
    fontSize: layout.paperStyles?.[layout.paperWidthMm] ? `${paper.fontSizePt}pt` : `${layout.style.fontSizePx}px`,
    fontWeight: layout.style.fontWeight,
    lineHeight: paper.lineHeight,
    quantitySize: `${paper.amountFontSizePt}pt`,
  };
}
