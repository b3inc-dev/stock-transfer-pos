import { resolvePaperPrintStyle, type ReceiptLayout } from "./receiptLayoutSchema";
/** Merchant HTML/CSS is confined to the design area; required facts live outside it. */
import sanitizeHtml from "sanitize-html";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SCOPE = "reservation-design";
function scopedCss(css: string) {
  const root = postcss.parse(css);
  root.walkAtRules(rule => { if (!["media", "supports"].includes(rule.name.toLowerCase())) rule.remove(); });
  root.walkRules(rule => {
    rule.selector = selectorParser(selectors => {
      selectors.each(selector => {
        selector.walkTags(tag => { if (["html", "body"].includes(tag.value.toLowerCase())) tag.replaceWith(selectorParser.universal({ value: "*" })); });
        selector.walkPseudos(pseudo => { if (pseudo.value === ":root") pseudo.replaceWith(selectorParser.universal({ value: "*" })); });
        // Root styles now apply to the wrapper. All other selectors stay beneath it.
        if (selector.nodes.every(node => node.type === "universal" || node.type === "combinator")) {
          selector.removeAll(); selector.append(selectorParser.className({ value: SCOPE }));
        } else {
          selector.prepend(selectorParser.combinator({ value: " " })); selector.prepend(selectorParser.className({ value: SCOPE }));
        }
      });
    }).processSync(rule.selector);
  });
  return root.toString();
}
export function protectReservationDocument(html: string, data: Record<string, unknown>, layout: ReceiptLayout) {
  const reservation = data.reservation as { number: string; due_date: string; copy_label: string; created_at_label: string; items: { title: string; quantity: number; sku?: string; barcode?: string }[] };
  if (!reservation?.number || !Array.isArray(reservation.items)) throw new Error("取置控えの必須情報がありません");
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => scopedCss(match[1])).join("\n");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  const clean = sanitizeHtml(body, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "svg", "path", "rect", "g", "line"],
    allowedAttributes: { "*": ["class", "style"], img: ["src", "alt", "width", "height"], svg: ["viewBox", "viewbox", "width", "height", "xmlns"], path: ["d", "fill"], rect: ["x", "y", "width", "height", "fill"], g: ["fill"], line: ["x1", "y1", "x2", "y2", "stroke"] },
    allowedSchemes: ["https", "data"], allowedSchemesByTag: { img: ["https", "data"] },
    allowProtocolRelative: false,
    // Scripts, external styles, frames/forms and document metadata never enter the print document.
    nonTextTags: ["style", "script", "textarea", "option", "noscript"],
  });
  const paper = resolvePaperPrintStyle(layout);
  const info = layout.blocks.find(block => block.type === "reservation_info")?.settings;
  const items = layout.blocks.find(block => block.type === "reservation_items")?.settings;
  const staff = data.staff as { name?: string } | undefined;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>取置控え</title><style>
html,body{margin:0;padding:0;background:#fff;color:#000;font:${paper.fontSizePt}pt/${paper.lineHeight} sans-serif}*{box-sizing:border-box}
${styles}
.reservation-design{contain:paint!important;isolation:isolate!important;position:relative!important;overflow:hidden!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;transform:none!important}
.reservation-required{padding:${paper.marginYMm}mm ${paper.marginXMm}mm;border-top:1px dashed #000;overflow-wrap:anywhere}.reservation-required p{margin:2mm 0}.reservation-required .required-item{display:flex;gap:8px;justify-content:space-between}.reservation-required .required-item span:last-child{white-space:nowrap}body{width:100%;max-width:100%}@page{size:auto;margin:0}
</style></head><body><div class="reservation-design">${clean}</div><section class="reservation-required"><p><b>${escape(reservation.copy_label)}</b></p><p><b>取置番号 ${escape(reservation.number)}</b></p><p><b>受取期限 ${escape(reservation.due_date)}</b></p>${info?.show_date !== false ? `<p>受付 ${escape(reservation.created_at_label)}</p>` : ""}${info?.show_staff !== false ? `<p>担当 ${escape(staff?.name)}</p>` : ""}${reservation.items.map(item => `<div class="required-item"><span>${escape(item.title)}${items?.show_sku && item.sku ? `<br>SKU: ${escape(item.sku)}` : ""}${items?.show_barcode && item.barcode ? `<br>JAN: ${escape(item.barcode)}` : ""}</span><span>${escape(item.quantity)}点</span></div>`).join("")}</section></body></html>`;
}
