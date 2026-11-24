/**
 * レシートのレイアウト（4 種）の保存形式
 *
 * 1 レイアウト = 1 種類のレシート（精算・点検／販売／ギフト／領収書）。
 * - mode "blocks": ブロックの並び（並べ替え・表示切替・文言）から印字 HTML を作る
 * - mode "code":   テンプレートのコード（Liquid）を直接書く上級者向け
 * どちらも receiptLayoutRender.ts の同じレンダラで HTML にするので、プレビューと印字が一致する。
 *
 * 保存先は AppSetting（key = receipt_layout_v1_<kind>）。DB の形は変えない。
 */

export const RECEIPT_KINDS = ["settlement", "sales", "gift", "receipt", "reservation"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const RECEIPT_KIND_LABELS: Record<ReceiptKind, string> = {
  reservation: "取置控え",
  settlement: "精算・点検レシート",
  sales: "販売レシート",
  gift: "ギフトレシート",
  receipt: "領収書",
};

export function isReceiptKind(v: unknown): v is ReceiptKind {
  return typeof v === "string" && (RECEIPT_KINDS as readonly string[]).includes(v);
}

export function receiptLayoutSettingKey(kind: ReceiptKind): string {
  return `receipt_layout_v1_${kind}`;
}

export type BlockSettingValue = string | number | boolean;

export type LayoutBlock = {
  /** 並べ替え・編集の目印（レイアウトの中で一意） */
  id: string;
  /** receiptLayoutBlocks.ts の BLOCK_DEFS のキー */
  type: string;
  hidden?: boolean;
  settings: Record<string, BlockSettingValue>;
};

export type FontFamily = "sans" | "serif" | "mono";

export type LayoutStyle = {
  /** 本文の文字の大きさ（px） */
  fontSizePx: number;
  lineHeight: number;
  fontWeight: 400 | 600 | 700;
  fontFamily: FontFamily;
  /** 余白（px） */
  paddingPx: number;
  /** ブロックの CSS に足す（上級者向け） */
  customCss: string;
};

/** 用紙別の見た目。未保存の幅は従来の本文サイズ・行間を引き継ぐ。 */
export type PaperPrintStyle = {
  fontSizePt: number;
  amountFontSizePt: number;
  logoWidthMm: number;
  marginXMm: number;
  marginYMm: number;
  lineHeight: number;
};

export const PAPER_STYLE_LIMITS = {
  fontSizePt: { min: 8, max: 24 },
  amountFontSizePt: { min: 9, max: 24 },
  logoWidthMm: { min: 15, max: 42 },
  marginXMm: { min: 0.5, max: 4 },
  marginYMm: { min: 0, max: 8 },
  lineHeight: { min: 1, max: 1.8 },
} as const;

export function defaultPaperPrintStyle(mm: 58 | 80): PaperPrintStyle {
  return { fontSizePt: 10, amountFontSizePt: 11, logoWidthMm: mm === 58 ? 30 : 36,
    marginXMm: mm === 58 ? 1 : 1.5, marginYMm: 3, lineHeight: 1.35 };
}

export function resolvePaperPrintStyle(layout: Pick<ReceiptLayout, "style" | "paperWidthMm" | "paperStyles">): PaperPrintStyle {
  return layout.paperStyles?.[layout.paperWidthMm] ?? {
    ...defaultPaperPrintStyle(layout.paperWidthMm),
    fontSizePt: Math.max(8, Math.min(24, layout.style.fontSizePx * 0.75)),
    lineHeight: Math.max(1, Math.min(1.8, layout.style.lineHeight)),
  };
}

export type ReceiptLayout = {
  version: 1;
  kind: ReceiptKind;
  mode: "blocks" | "code";
  paperWidthMm: 58 | 80;
  style: LayoutStyle;
  paperStyles?: Partial<Record<58 | 80, PaperPrintStyle>>;
  /** プレビュー用: 100 CSS pxの診断線を紙上で測った長さ。印字データは変更しない。 */
  previewCalibration?: Partial<Record<58 | 80, number>>;
  blocks: LayoutBlock[];
  /** mode "code" のときのテンプレート（HTML 文書全体） */
  code: string;
};

export const DEFAULT_LAYOUT_STYLE: LayoutStyle = {
  fontSizePx: 13,
  lineHeight: 1.35,
  fontWeight: 400,
  fontFamily: "sans",
  paddingPx: 8,
  customCss: "",
};

/** 入力の上限（保存・描画の両方で守る） */
export const LAYOUT_LIMITS = {
  maxBlocks: 60,
  maxTextLength: 2000,
  maxCodeLength: 100_000,
  maxCssLength: 20_000,
  /** 画像の URL（data:image を含む） */
  maxUrlLength: 200_000,
  fontSizePx: { min: 8, max: 32 },
  lineHeight: { min: 1, max: 2.5 },
  paddingPx: { min: 0, max: 40 },
} as const;

export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * キーの順をそろえた形にする。画面が送る値・サーバーが返す値を同じ文字列にし、
 * 保存したあとに保存の帯が出直さないようにする。
 */
export function canonicalLayout(l: ReceiptLayout): ReceiptLayout {
  return {
    version: 1,
    kind: l.kind,
    mode: l.mode,
    paperWidthMm: l.paperWidthMm,
    ...(l.previewCalibration && Object.keys(l.previewCalibration).length ? {
      previewCalibration: Object.fromEntries(([58, 80] as const).flatMap((mm) =>
        l.previewCalibration?.[mm] === undefined ? [] : [[mm, l.previewCalibration[mm]]])),
    } : {}),
    style: {
      fontSizePx: l.style.fontSizePx,
      lineHeight: l.style.lineHeight,
      fontWeight: l.style.fontWeight,
      fontFamily: l.style.fontFamily,
      paddingPx: l.style.paddingPx,
      customCss: l.style.customCss,
    },
    ...(l.paperStyles && Object.keys(l.paperStyles).length ? {
      paperStyles: Object.fromEntries(([58, 80] as const).flatMap((mm) => {
        const p = l.paperStyles?.[mm];
        return p ? [[mm, { fontSizePt: p.fontSizePt, amountFontSizePt: p.amountFontSizePt,
          logoWidthMm: p.logoWidthMm, marginXMm: p.marginXMm, marginYMm: p.marginYMm, lineHeight: p.lineHeight }]] : [];
      })) as ReceiptLayout["paperStyles"],
    } : {}),
    blocks: l.blocks.map((b) => ({ id: b.id, type: b.type, hidden: b.hidden === true, settings: Object.fromEntries(Object.keys(b.settings).sort().map((k) => [k, b.settings[k]])) })),
    code: l.code,
  };
}
