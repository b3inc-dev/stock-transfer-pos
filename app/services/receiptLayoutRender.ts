import { receiptTypography } from "./receiptTypography";
import { protectReservationDocument } from "./reservationReceiptDocument";
/**
 * レシートのレイアウト → 印字 HTML（プレビューと印字で同じ関数を使う）
 *
 * ブロックのレイアウトは blocksToCode で Liquid のテンプレートにしてから描く。
 * コード編集のレイアウトはそのテンプレートをそのまま描く。
 * つまり描く道は 1 本で、ブロック→コードに切り替えても見た目は変わらない。
 *
 * 安全のため:
 * - 差し込む値は全部 HTML エスケープ（outputEscape）。`| raw` を付けたときだけそのまま出す
 * - include / render などファイルを読むタグは使えない（templates を空にしている）
 * - 文字数・描く時間・使うメモリに上限を付ける
 * - プレビューは sandbox の iframe（スクリプトは動かない）に出す
 */
import { Liquid } from "liquidjs";
import qrcodeGenerator from "qrcode-generator";
import { getBlockDef, type SettingDef } from "./receiptLayoutBlocks";
import {
  LAYOUT_LIMITS,
  resolvePaperPrintStyle,
  type ReceiptLayout,
} from "./receiptLayoutSchema";

export function paperWidthPx(mm: 58 | 80): number {
  // CSS px は 96dpi。プリンターの 203dpi のドット数とは別。
  return Math.round((mm === 58 ? 48 : 72) * 96 / 25.4);
}

/** 実測から求める描画幅。プリンターのドット数をCSS pxと仮定しない。 */
export function previewViewportPx(layout: Pick<ReceiptLayout, "paperWidthMm" | "previewCalibration">): number {
  const measured = layout.previewCalibration?.[layout.paperWidthMm];
  return measured && measured >= 5 && measured <= 60
    ? (layout.paperWidthMm === 58 ? 48 : 72) * 100 / measured
    : paperWidthPx(layout.paperWidthMm);
}

function formatNumber(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("ja-JP");
}

function formatMoney(v: unknown, currency: string): string {
  const n = Number(v);
  const value = Number.isFinite(n) ? n : 0;
  if (currency === "JPY") {
    const abs = Math.abs(Math.round(value)).toLocaleString("ja-JP");
    return value < 0 ? `-¥${abs}` : `¥${abs}`;
  }
  return `${value.toLocaleString("ja-JP", { maximumFractionDigits: 2 })} ${currency}`;
}

/** 文字列を QR コードの SVG にする（印字・プレビューで同じ。外へ読みに行かない） */
export function qrSvg(value: unknown): string {
  const text = String(value ?? "").slice(0, 1000);
  if (!text) return "";
  // 日本語の URL・文も読めるよう UTF-8 にする
  qrcodeGenerator.stringToBytes = qrcodeGenerator.stringToBytesFuncs["UTF-8"];
  const qr = qrcodeGenerator(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

/**
 * "YYYY-MM-DD" から土日と休みの日（"YYYY-MM-DD" を , ・改行・| で区切った一覧）を除いて n 営業日あとの日を
 * 「2026年11月27日」の形で返す。数えるのは次の日から（Ciara の sales-receipt.liquid と同じ）。
 */
export function businessDayLabel(start: unknown, days: unknown, holidays: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(start ?? ""));
  const n = Math.floor(Number(days));
  if (!m || !Number.isFinite(n) || n < 1 || n > 60) return "";
  const off = new Set(String(holidays ?? "").split(/(?:<br\/>|[\s,|])+/).filter(Boolean));
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  let counted = 0;
  for (let i = 0; i < 200; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const ymd = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6 || off.has(ymd)) continue;
    if (++counted === n) return `${ymd.slice(0, 4)}年${ymd.slice(5, 7)}月${ymd.slice(8, 10)}日`;
  }
  return "";
}

let engine: Liquid | null = null;

export function receiptLiquid(): Liquid {
  if (engine) return engine;
  const liquid = new Liquid({
    outputEscape: "escape",
    ownPropertyOnly: true,
    strictFilters: true,
    // ファイルを読ませない（include / render / layout は見つからずエラーになる）
    templates: {},
    parseLimit: LAYOUT_LIMITS.maxCodeLength * 2,
    renderLimit: 1000,
    memoryLimit: 20_000_000,
  });
  liquid.registerFilter("money", function (this: { context: { getSync: (p: string[]) => unknown } }, v: unknown, currency?: string) {
    const fromData = this.context.getSync(["shop", "currency"]);
    return formatMoney(v, String(currency || fromData || "JPY"));
  });
  liquid.registerFilter("number", (v: unknown) => formatNumber(v));
  // 出すときは | qrcode | raw（SVG なのでエスケープしない）
  liquid.registerFilter("qrcode", (v: unknown) => qrSvg(v));
  liquid.registerFilter("business_day_label", (v: unknown, days: unknown, holidays: unknown) => businessDayLabel(v, days, holidays));
  engine = liquid;
  return liquid;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const OUTPUT_TAG = /\{\{[\s\S]*?\}\}/g;

/**
 * 文言の欄の値を Liquid の capture の中身にする。
 * 文字はエスケープし（改行は <br/>）、{{ ... }} の差し込みはそのまま残す（描くときにエスケープされる）。
 */
export function textSettingToLiquid(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(OUTPUT_TAG)) {
    out += escapeHtml(text.slice(last, m.index)).replace(/\r?\n/g, "<br/>");
    out += m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  out += escapeHtml(text.slice(last)).replace(/\r?\n/g, "<br/>");
  return out;
}

function settingToLiquid(def: SettingDef, value: unknown): string {
  const name = `s_${def.key}`;
  switch (def.type) {
    case "checkbox":
      return `{% assign ${name} = ${value === true ? "true" : "false"} %}`;
    case "number": {
      const n = Number(value);
      const v = Number.isFinite(n) ? Math.min(def.max, Math.max(def.min, n)) : def.default;
      return `{% assign ${name} = ${v} %}`;
    }
    case "select": {
      const v = def.options.some((o) => o.value === value) ? String(value) : def.default;
      return `{% assign ${name} = "${v}" %}`;
    }
    case "url": {
      const v = typeof value === "string" && isSafeImageUrl(value) ? value : "";
      return `{% capture ${name} %}${escapeHtml(v)}{% endcapture %}`;
    }
    default:
      return `{% capture ${name} %}${textSettingToLiquid(String(value ?? ""))}{% endcapture %}`;
  }
}

/** 画像の URL は https（または data:image）だけ。引用符・空白・山括弧は入れない */
export function isSafeImageUrl(url: string): boolean {
  if (!url) return true;
  if (/["'<>\s\\{}]/.test(url)) return false;
  return /^https:\/\/[^/]+\//i.test(url) || /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(url);
}

/** 画面の大きさ・文字の大きさなど、全部のレシートに共通の CSS */
export function baseCss(layout: Pick<ReceiptLayout, "paperWidthMm" | "style" | "paperStyles">): string {
  const p = resolvePaperPrintStyle(layout);
  const typography = receiptTypography(layout);
  return [
    `*{box-sizing:border-box}`,
    `@page{size:auto;margin:0}`,
    `html,body{margin:0;padding:0;background:#fff}`,
    `body{padding:${p.marginYMm}mm ${p.marginXMm}mm;width:100%;max-width:100%;overflow-wrap:anywhere;color:#000;font-family:${typography.fontFamily};font-size:${typography.fontSize};line-height:${p.lineHeight};font-weight:${typography.fontWeight}}`,
    `p{margin:0}`,
    `.blk{margin:6px 0}`,
    `.a-left{text-align:left}.a-center{text-align:center}.a-right{text-align:right}`,
    `.b{font-weight:700}`,
    // Keep explicit block sizes as multipliers of the paper-specific total size.
    `.fs-s{font-size:.85em;--receipt-font-scale:.85}.fs-m{font-size:1em;--receipt-font-scale:1}.fs-l{font-size:1.3em;--receipt-font-scale:1.3}.fs-xl{font-size:1.8em;--receipt-font-scale:1.8}`,
    `.row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin:2px 0}`,
    `.row>span:first-child{min-width:0;flex:1;overflow-wrap:anywhere}`,
    `.row>span:last-child{min-width:0;max-width:65%;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}`,
    `.print-value,.row .print-value{font-size:${typography.quantitySize}}`,
    // The standard total/receipt amount block uses l (1.3): normalize it to
    // the recommended 14pt total. Other sizes retain their relative ratios.
    // Do not force bold here: totals inherit total_bold from their row;
    // receipt amounts retain their own .b class.
    `.print-total,.row .print-total{font-size:calc(max(14pt,${p.amountFontSizePt}pt) * var(--receipt-font-scale,1.3) / 1.3)}`,
    `.item{margin:6px 0}`,
    `.indent{padding-left:12px}`,
    `.logo{display:inline-block;max-width:${Math.min(100, p.logoWidthMm / (layout.paperWidthMm === 58 ? 48 : 72) * 100)}%;height:auto}`,
    `.hr{border:0;margin:8px 0}`,
    `.hr-none{border-top:0}.hr-solid{border-top:1px solid #000}.hr-thick{border-top:3px solid #000}.hr-dashed{border-top:1px dashed #000}.hr-dotted{border-top:2px dotted #000}`,
    `.ul-solid{border-bottom:1px solid #000;padding-bottom:4px}.ul-thick{border-bottom:3px solid #000;padding-bottom:6px}.ul-dashed{border-bottom:1px dashed #000;padding-bottom:4px}.ul-dotted{border-bottom:2px dotted #000;padding-bottom:4px}`,
    `.amount{padding:8px 0}`,
    `.stamp{display:inline-flex;align-items:center;justify-content:center;border:1px solid #000;font-size:.85em}`,
    `.stamps{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px}`,
    `.stamp{max-width:100%}`,
    `.qr{margin:0 auto;max-width:100%}.qr svg{width:100%;height:auto;display:block}`,
    `.thin{font-weight:300}.muted{opacity:.8}.strike{text-decoration:line-through}`,
    `.lines>div+div{margin-top:2px}`,
  ].join("\n");
}

/**
 * CSS は {% raw %} で囲んで出すので、raw を閉じる文字と </style> は入れさせない。
 * 印字のときに外へ読みに行かないよう、@import と data: 以外の url() も入れさせない。
 */
export function isSafeCss(css: string): boolean {
  return (
    !/\{%-?\s*endraw/i.test(css) &&
    !/<\/style/i.test(css) &&
    !/@import/i.test(css) &&
    !/url\(\s*['"]?\s*(?!data:)/i.test(css)
  );
}

/**
 * 文言の欄に書けるかを確かめる。書けないときは理由を返す。
 * - {% %} のタグは書けない（{{ }} の差し込みだけ）
 * - {{ と }} は組で使う（組にならないと、作るテンプレートが壊れる）
 * - | raw は使えない（注文のメモなどお客様が入れた値をそのまま出さないため）
 */
export function textSettingProblem(text: string): string | null {
  if (/\{%/.test(text)) return "{% %} のタグは書けません（{{ }} の差し込みだけ使えます）。";
  const tags = [...text.matchAll(OUTPUT_TAG)].map((m) => m[0]);
  const rest = text.replace(OUTPUT_TAG, "");
  if (/\{\{|\}\}/.test(rest)) return "{{ と }} の組が合っていません。";
  for (const tag of tags) {
    if (/\|\s*raw\b/.test(tag)) return "文言の欄では | raw は使えません。";
    if (/["'][^"']*\}\}/.test(tag.slice(0, -2))) return "差し込みの中の文字に }} は書けません。";
    try {
      receiptLiquid().parse(tag);
    } catch (e) {
      return `差し込み ${tag} の書き方が正しくありません（${describeLiquidError(e).replace(/^\d+ 行目 \d+ 文字目: /, "")}）。`;
    }
  }
  return null;
}

/**
 * 断片を読みやすくする（コード編集で見るため）。<div・<hr・for の前で改行するだけで、
 * 属性の中には入らない場所なので、出す HTML の見た目は変わらない（改行はブロックの間の空白になるだけ）。
 */
function readableTemplate(t: string): string {
  return t.replace(/(?!^)(<div\b|<hr\b|\{% for |\{% endfor %\})/g, "\n$1");
}

/** ブロックのレイアウト → Liquid のテンプレート（HTML 文書全体） */
export function blocksToCode(layout: ReceiptLayout): string {
  const parts: string[] = [];
  for (const block of layout.blocks) {
    if (layout.kind === "reservation" && ["reservation_info", "reservation_items"].includes(block.type)) continue;
    if (block.hidden) continue;
    const def = getBlockDef(block.type);
    if (!def) continue;
    const settings = { ...block.settings, ...(def.derived?.(block.settings) ?? {}) };
    const assigns = def.settings.map((s) => settingToLiquid(s, settings[s.key]));
    for (const [k, v] of Object.entries(def.derived?.(block.settings) ?? {})) {
      assigns.push(`{% assign s_${k} = "${String(v).replace(/[^a-z_]/gi, "")}" %}`);
    }
    parts.push(`{%- comment -%} ${def.label} {%- endcomment -%}\n${assigns.join("\n")}\n${readableTemplate(def.template)}`);
  }
  const css = layout.style.customCss && isSafeCss(layout.style.customCss) ? `\n${layout.style.customCss}` : "";
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{{ document.title }}</title>
<style>{% raw %}
/* receipt-managed-paper-start */
${baseCss(layout)}
/* receipt-managed-paper-end */${css}
{% endraw %}</style>
</head>
<body>
${parts.join("\n")}
</body>
</html>
`;
}

export type RenderResult = { ok: true; html: string } | { ok: false; error: string; html: string };

/** レイアウトのテンプレート（ブロックならコードにしたもの） */
export function layoutTemplate(layout: ReceiptLayout): string {
  return layout.mode === "code" ? layout.code : blocksToCode(layout);
}

/** レイアウトとデータから印字 HTML を作る。失敗したら理由と、理由を書いた HTML を返す */
export function renderReceiptLayout(layout: ReceiptLayout, data: Record<string, unknown>): RenderResult {
  // 生成したコードの管理対象 CSS だけ、現在の用紙・設定で更新する。
  // 手書きの CSS はそのまま。Liquid からも現在の用紙を参照できる。
  const template = layoutTemplate(layout).replace(
    /\/\* receipt-managed-paper-start \*\/[\s\S]*?\/\* receipt-managed-paper-end \*\//,
    () => `/* receipt-managed-paper-start */\n${baseCss(layout)}\n/* receipt-managed-paper-end */`,
  );
  if (template.length > LAYOUT_LIMITS.maxCodeLength * 2) {
    return errorResult("テンプレートが長すぎます。");
  }
  try {
    const html = receiptLiquid().parseAndRenderSync(template, {
      ...data,
      paper: { width_mm: layout.paperWidthMm, printable_width_mm: layout.paperWidthMm === 58 ? 48 : 72,
        ...resolvePaperPrintStyle(layout) },
    });
    return { ok: true, html: layout.kind === "reservation" ? protectReservationDocument(html, data, layout) : html };
  } catch (e) {
    return errorResult(describeLiquidError(e));
  }
}

/** Liquid の誤りを「何行目の何」が分かる日本語にする */
export function describeLiquidError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const lineMatch = /line:(\d+), col:(\d+)/.exec(msg);
  const where = lineMatch ? `${lineMatch[1]} 行目 ${lineMatch[2]} 文字目: ` : "";
  const reason = msg.replace(/, line:\d+, col:\d+[\s\S]*$/, "");
  if (/undefined filter: (\w+)/.test(reason)) return `${where}使えないフィルター「${/undefined filter: (\w+)/.exec(reason)![1]}」があります。`;
  if (/Failed to lookup/.test(reason)) return `${where}include・render などほかのファイルを読むタグは使えません。`;
  if (/memory alloc limit|template render limit|parse length limit/.test(reason)) return `${where}テンプレートが大きすぎるか、繰り返しが多すぎます。`;
  if (/not closed|unexpected|not found|illegal/i.test(reason)) return `${where}タグの書き方が正しくありません（${reason}）。`;
  return `${where}${reason}`;
}

function errorResult(error: string): RenderResult {
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"/></head><body style="font-family:sans-serif;padding:12px;color:#8e1f0b">${escapeHtml(error)}</body></html>`;
  return { ok: false, error, html };
}
