import { receiptTypography } from "./receiptTypography";
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
  const reservation = data.reservation as { number: string; due_date: string; copy_label: string; intake_label?: string; created_at_label: string; items: { title: string; variant_title?: string; quantity: number; sku?: string; barcode?: string }[] };
  if (!reservation?.number || !Array.isArray(reservation.items)) throw new Error("取置控えの必須情報がありません");
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => scopedCss(match[1])).join("\n");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  const clean = (fragment: string) => sanitizeHtml(fragment, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "svg", "path", "rect", "g", "line"],
    allowedAttributes: { "*": ["class", "style"], img: ["src", "alt", "width", "height"], svg: ["viewBox", "viewbox", "width", "height", "xmlns"], path: ["d", "fill"], rect: ["x", "y", "width", "height", "fill"], g: ["fill"], line: ["x1", "y1", "x2", "y2", "stroke"] },
    allowedSchemes: ["https", "data"], allowedSchemesByTag: { img: ["https", "data"] },
    allowProtocolRelative: false,
    // Scripts, external styles, frames/forms and document metadata never enter the print document.
    nonTextTags: ["style", "script", "textarea", "option", "noscript"],
  });
  const paper = resolvePaperPrintStyle(layout);
  const typography = receiptTypography(layout);
  const info = layout.blocks.find(block => block.type === "reservation_info")?.settings;
  const items = layout.blocks.find(block => block.type === "reservation_items")?.settings;
  const staff = data.staff as { name?: string } | undefined;
  const design = (fragment: string) => fragment.trim() ? `<div class="reservation-design">${clean(fragment)}</div>` : "";
  const marker = /<!-- reservation-items(?::sku)? -->/;
  const showSku = marker.exec(body)?.[0] === "<!-- reservation-items:sku -->" || items?.show_sku;
  const itemSection = `<section class="reservation-required reservation-items"><div class="required-item-header"><span>アイテム</span><span>数量</span></div>${reservation.items.map(item => `<div class="required-item"><div class="required-description"><span class="required-title">${escape(item.title)}</span>${item.variant_title ? `<div class="required-variant">${escape(item.variant_title)}</div>` : ""}${showSku && item.sku ? `<div class="required-code">${escape(item.sku)}</div>` : ""}${items?.show_barcode && item.barcode ? `<div class="required-code">JAN: ${escape(item.barcode)}</div>` : ""}</div><span class="required-quantity">${escape(item.quantity)}点</span></div>`).join("")}</section>`;
  // Only the first marker positions the protected list. Sanitize each side independently,
  // so merchant markup/CSS can neither wrap nor hide the required list or footer.
  const fragments = body.split(marker);
  const content = design(fragments[0]) + itemSection + (fragments.length > 1 ? design(fragments.slice(1).join("")) : "");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>取置控え</title><style>
html,body{margin:0;padding:0;background:#fff;color:#000;font-family:${typography.fontFamily};font-size:${typography.fontSize};line-height:${typography.lineHeight};font-weight:${typography.fontWeight}}*{box-sizing:border-box}
${styles}
.reservation-design{contain:paint!important;isolation:isolate!important;position:relative!important;overflow:hidden!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;transform:none!important}
.reservation-required{padding:${paper.marginYMm}mm ${paper.marginXMm}mm;overflow-wrap:anywhere}.reservation-items{padding-top:0;padding-bottom:8px;border-bottom:3px solid #000}.required-item-header{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #000;padding-bottom:4px;font-weight:700}.required-title{font-weight:700}.required-description{min-width:0;flex:1}.required-variant,.required-code{font-size:1em;font-weight:400}.reservation-required .required-item{margin:6px 0}.reservation-details{text-align:center}.reservation-required p{margin:2px 0}.reservation-details>p{font-size:.85em}.reservation-details .reservation-due{font-size:1.3em;font-weight:700;line-height:1.35}.reservation-due-label{display:block;font-size:.65em;font-weight:400}.reservation-due-value{display:block}.reservation-required b{font-weight:inherit}.reservation-required .reservation-number{font-size:1.3em;font-weight:700;line-height:1.35}.reservation-required .required-item{display:flex;gap:8px;justify-content:space-between}.reservation-required .required-item .required-quantity{white-space:nowrap;font-size:${typography.quantitySize};font-variant-numeric:tabular-nums}body{width:100%;max-width:100%}@page{size:auto;margin:0}
</style></head><body>${content}<section class="reservation-required reservation-details"><p><b>${escape(reservation.copy_label)}</b></p>${reservation.intake_label ? `<p>${escape(reservation.intake_label)}</p>` : ""}<p class="reservation-number">取置番号 ${escape(reservation.number)}</p><p class="reservation-due"><span class="reservation-due-label">受取期限</span><b class="reservation-due-value">${escape(reservation.due_date)}</b></p>${info?.show_date !== false ? `<p>受付 ${escape(reservation.created_at_label)}</p>` : ""}${info?.show_staff !== false ? `<p>担当 ${escape(staff?.name)}</p>` : ""}</section></body></html>`;
}
