/**
 * レイアウトの読み込み（ゆるく直す）と保存前の確認（1 つでも誤りがあれば保存しない）
 */
import { blockDefsForKind, defaultSettings, getBlockDef } from "./receiptLayoutBlocks";
import { sampleTemplateData } from "./receiptLayoutData";
import { defaultLayout } from "./receiptLayoutPresets";
import {
  isSafeCss,
  isSafeImageUrl,
  receiptLiquid,
  renderReceiptLayout,
  textSettingProblem,
  describeLiquidError,
} from "./receiptLayoutRender";
import {
  BLOCK_ID_PATTERN,
  canonicalLayout,
  DEFAULT_LAYOUT_STYLE,
  LAYOUT_LIMITS,
  RECEIPT_KIND_LABELS,
  PAPER_STYLE_LIMITS,
  defaultPaperPrintStyle,
  type PaperPrintStyle,
  type BlockSettingValue,
  type LayoutBlock,
  type LayoutStyle,
  type ReceiptKind,
  type ReceiptLayout,
} from "./receiptLayoutSchema";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function clamp(n: unknown, min: number, max: number, d: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
}

function normalizeStyle(raw: unknown): LayoutStyle {
  const s = isObj(raw) ? raw : {};
  const L = LAYOUT_LIMITS;
  return {
    fontSizePx: clamp(s.fontSizePx, L.fontSizePx.min, L.fontSizePx.max, DEFAULT_LAYOUT_STYLE.fontSizePx),
    lineHeight: clamp(s.lineHeight, L.lineHeight.min, L.lineHeight.max, DEFAULT_LAYOUT_STYLE.lineHeight),
    fontWeight: s.fontWeight === 600 || s.fontWeight === 700 ? s.fontWeight : 400,
    fontFamily: s.fontFamily === "serif" || s.fontFamily === "mono" ? s.fontFamily : "sans",
    paddingPx: clamp(s.paddingPx, L.paddingPx.min, L.paddingPx.max, DEFAULT_LAYOUT_STYLE.paddingPx),
    customCss: typeof s.customCss === "string" && isSafeCss(s.customCss) ? s.customCss.slice(0, L.maxCssLength) : "",
  };
}

/**
 * 保存してあるレイアウトを読む。壊れていたら初めの値に戻し、知らないブロックは外す。
 * （保存のときは validateLayoutInput で断るので、ここで外すのは古い版・手で壊した値だけ）
 */
function normalizePaperStyles(raw: unknown): ReceiptLayout["paperStyles"] {
  if (!isObj(raw)) return undefined;
  const profiles: NonNullable<ReceiptLayout["paperStyles"]> = {};
  for (const mm of [58, 80] as const) {
    const saved = raw[mm];
    if (!isObj(saved)) continue;
    const defaults = defaultPaperPrintStyle(mm);
    const p = {} as PaperPrintStyle;
    for (const key of Object.keys(PAPER_STYLE_LIMITS) as (keyof PaperPrintStyle)[]) {
      const range = PAPER_STYLE_LIMITS[key];
      p[key] = clamp(saved[key], range.min, range.max, defaults[key]);
    }
    profiles[mm] = p;
  }
  return Object.keys(profiles).length ? profiles : undefined;
}

export function normalizeLayout(raw: unknown, kind: ReceiptKind): ReceiptLayout {
  if (!isObj(raw) || raw.kind !== kind || !Array.isArray(raw.blocks)) return defaultLayout(kind);
  const allowed = new Set(blockDefsForKind(kind).map((d) => d.type));
  const blocks: LayoutBlock[] = [];
  const ids = new Set<string>();
  for (const b of raw.blocks.slice(0, LAYOUT_LIMITS.maxBlocks)) {
    if (!isObj(b) || typeof b.type !== "string" || !allowed.has(b.type)) continue;
    const def = getBlockDef(b.type)!;
    let id = typeof b.id === "string" && BLOCK_ID_PATTERN.test(b.id) ? b.id : "";
    for (let n = blocks.length + 1; !id || ids.has(id); n++) id = `${b.type}-${n}`.slice(0, 64);
    ids.add(id);
    const settings = defaultSettings(def);
    const given = isObj(b.settings) ? b.settings : {};
    for (const s of def.settings) {
      const v = given[s.key];
      if (s.type === "checkbox" && typeof v === "boolean") settings[s.key] = v;
      else if (s.type === "number" && typeof v === "number") settings[s.key] = clamp(v, s.min, s.max, s.default);
      else if (s.type === "select" && s.options.some((o) => o.value === v)) settings[s.key] = v as string;
      else if (s.type === "url" && typeof v === "string" && v.length <= LAYOUT_LIMITS.maxUrlLength && isSafeImageUrl(v)) settings[s.key] = v;
      else if ((s.type === "text" || s.type === "textarea") && typeof v === "string" && v.length <= LAYOUT_LIMITS.maxTextLength && !textSettingProblem(v)) settings[s.key] = v;
    }
    blocks.push({ id, type: b.type, hidden: b.hidden === true, settings });
  }
  return canonicalLayout({
    version: 1,
    kind,
    mode: raw.mode === "code" ? "code" : "blocks",
    paperWidthMm: raw.paperWidthMm === 58 ? 58 : 80,
    style: normalizeStyle(raw.style),
    paperStyles: normalizePaperStyles(raw.paperStyles),
    previewCalibration: normalizePreviewCalibration(raw.previewCalibration),
    blocks,
    code: typeof raw.code === "string" ? raw.code.slice(0, LAYOUT_LIMITS.maxCodeLength) : "",
  });
}

export type ValidateResult = { ok: true; layout: ReceiptLayout } | { ok: false; errors: string[] };

function normalizePreviewCalibration(raw: unknown): ReceiptLayout["previewCalibration"] {
  if (!isObj(raw)) return undefined;
  const entries = ([58, 80] as const).flatMap((mm) => {
    const v = raw[mm];
    return typeof v === "number" && Number.isFinite(v) && v >= 5 && v <= 60 ? [[mm, v]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function checkLiquid(text: string): string | null {
  try {
    receiptLiquid().parse(text);
    return null;
  } catch (e) {
    return describeLiquidError(e);
  }
}

/**
 * 画面から届いたレイアウトを確かめる。誤りは全部集めて返し、1 つでもあれば保存しない。
 * 受け取れない欄（知らないブロック・知らない設定）は黙って捨てずに誤りにする。
 */
export function validateLayoutInput(raw: unknown, kind: ReceiptKind): ValidateResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["レイアウトの形が正しくありません。"] };
  if (raw.kind !== kind) errors.push(`${RECEIPT_KIND_LABELS[kind]}のレイアウトではありません。`);
  if (raw.mode !== "blocks" && raw.mode !== "code") errors.push("編集のしかた（ブロック／コード）が正しくありません。");
  if (raw.paperWidthMm !== 58 && raw.paperWidthMm !== 80) errors.push("用紙の幅は 58mm か 80mm にしてください。");

  const L = LAYOUT_LIMITS;
  if (raw.previewCalibration !== undefined) {
    if (!isObj(raw.previewCalibration)) errors.push("プレビュー補正値が正しくありません。");
    else for (const [mm, v] of Object.entries(raw.previewCalibration)) {
      if (!["58", "80"].includes(mm) || typeof v !== "number" || !Number.isFinite(v) || v < 5 || v > 60)
        errors.push("診断線の実測は用紙幅ごとに5〜60mmで指定してください。");
    }
  }
  const st = isObj(raw.style) ? raw.style : null;
  if (!st) errors.push("見た目の設定がありません。");
  else {
    const num = (k: string, label: string, r: { min: number; max: number }) => {
      const v = st[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < r.min || v > r.max) errors.push(`${label}は ${r.min}〜${r.max} にしてください。`);
    };
    num("fontSizePx", "文字の大きさ", L.fontSizePx);
    num("lineHeight", "行の高さ", L.lineHeight);
    num("paddingPx", "余白", L.paddingPx);
    if (![400, 600, 700].includes(st.fontWeight as number)) errors.push("文字の太さが正しくありません。");
    if (!["sans", "serif", "mono"].includes(st.fontFamily as string)) errors.push("書体が正しくありません。");
    if (typeof st.customCss !== "string") errors.push("追加の CSS が正しくありません。");
    else if (st.customCss.length > L.maxCssLength) errors.push(`追加の CSS は ${L.maxCssLength.toLocaleString()} 文字までです。`);
    else if (!isSafeCss(st.customCss)) errors.push("追加の CSS に </style>・endraw・@import・外の url() は書けません。");
  }

  if (raw.paperStyles !== undefined) {
    if (!isObj(raw.paperStyles)) errors.push("用紙別の見た目が正しくありません。");
    else {
      for (const [mm, profile] of Object.entries(raw.paperStyles)) {
        if ((mm !== "58" && mm !== "80") || !isObj(profile)) {
          errors.push("用紙別の見た目は 58mm・80mm の設定だけを受け取れます。");
          continue;
        }
        for (const key of Object.keys(PAPER_STYLE_LIMITS) as (keyof PaperPrintStyle)[]) {
          const value = profile[key];
          const range = PAPER_STYLE_LIMITS[key];
          if (typeof value !== "number" || !Number.isFinite(value) || value < range.min || value > range.max) {
            errors.push(`${mm}mm の見た目の数値は範囲内で入力してください（${range.min}〜${range.max}）。`);
          }
        }
      }
    }
  }

  const allowed = new Set(blockDefsForKind(kind).map((d) => d.type));
  const blocks: LayoutBlock[] = [];
  if (!Array.isArray(raw.blocks)) errors.push("ブロックの一覧がありません。");
  else {
    if (raw.blocks.length > L.maxBlocks) errors.push(`ブロックは ${L.maxBlocks} 個までです。`);
    const ids = new Set<string>();
    raw.blocks.forEach((b, i) => {
      const at = `${i + 1} 番目のブロック`;
      if (!isObj(b) || typeof b.type !== "string") return void errors.push(`${at}の形が正しくありません。`);
      const def = getBlockDef(b.type);
      if (!def || !allowed.has(b.type)) return void errors.push(`${at}（${b.type}）は${RECEIPT_KIND_LABELS[kind]}では使えません。`);
      const name = `${at}「${def.label}」`;
      if (typeof b.id !== "string" || !BLOCK_ID_PATTERN.test(b.id) || ids.has(b.id)) errors.push(`${name}の ID が正しくありません。`);
      else ids.add(b.id);
      const given = isObj(b.settings) ? b.settings : {};
      const known = new Set(def.settings.map((s) => s.key));
      for (const k of Object.keys(given)) if (!known.has(k)) errors.push(`${name}に受け取れない設定「${k}」があります。`);
      const settings: Record<string, BlockSettingValue> = {};
      for (const s of def.settings) {
        const v = given[s.key] ?? s.default;
        const field = `${name}の「${s.label}」`;
        switch (s.type) {
          case "checkbox":
            if (typeof v !== "boolean") errors.push(`${field}が正しくありません。`);
            break;
          case "number":
            if (typeof v !== "number" || !Number.isFinite(v) || v < s.min || v > s.max) errors.push(`${field}は ${s.min}〜${s.max} にしてください。`);
            break;
          case "select":
            if (!s.options.some((o) => o.value === v)) errors.push(`${field}の選択が正しくありません。`);
            break;
          case "url":
            if (typeof v !== "string" || !isSafeImageUrl(v)) errors.push(`${field}は https:// で始まる画像の URL にしてください。`);
            else if (v.length > L.maxUrlLength) errors.push(`${field}が長すぎます（${L.maxUrlLength.toLocaleString()} 文字まで）。画像は Shopify の「ファイル」に上げて、その URL を入れてください。`);
            break;
          default: {
            if (typeof v !== "string") { errors.push(`${field}が正しくありません。`); break; }
            if (v.length > L.maxTextLength) errors.push(`${field}は ${L.maxTextLength} 文字までです。`);
            const problem = textSettingProblem(v);
            if (problem) errors.push(`${field}: ${problem}`);
          }
        }
        settings[s.key] = v as BlockSettingValue;
      }
      blocks.push({ id: String(b.id), type: b.type, hidden: b.hidden === true, settings });
    });
  }

  if (typeof raw.code !== "string") errors.push("コードがありません。");
  else if (raw.code.length > L.maxCodeLength) errors.push(`コードは ${L.maxCodeLength.toLocaleString()} 文字までです。`);
  else if (raw.mode === "code") {
    if (!raw.code.trim()) errors.push("コードが空です。");
    else {
      const err = checkLiquid(raw.code);
      if (err) errors.push(`コード: ${err}`);
    }
  }

  if (errors.length) return { ok: false, errors };
  const layout: ReceiptLayout = canonicalLayout({
    version: 1,
    kind,
    mode: raw.mode as ReceiptLayout["mode"],
    paperWidthMm: raw.paperWidthMm as 58 | 80,
    style: normalizeStyle(raw.style),
    paperStyles: normalizePaperStyles(raw.paperStyles),
    previewCalibration: normalizePreviewCalibration(raw.previewCalibration),
    blocks,
    code: raw.code as string,
  });
  // 見本のデータで描けるか（描くときの誤りも保存の前に止める）
  const rendered = renderReceiptLayout(layout, sampleTemplateData(kind));
  if (!rendered.ok) {
    return {
      ok: false,
      errors: [
        layout.mode === "code"
          ? `見本のデータで描けませんでした: ${rendered.error}`
          : `見本のデータで描けませんでした（ブロックの文言の差し込みを確かめてください）: ${rendered.error.replace(/^\d+ 行目 \d+ 文字目: /, "")}`,
      ],
    };
  }
  return { ok: true, layout };
}
