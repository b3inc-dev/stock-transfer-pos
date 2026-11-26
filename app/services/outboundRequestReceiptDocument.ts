import { scopedReceiptCss, cleanReceiptFragment } from "./reservationReceiptDocument";
import { receiptTypography } from "./receiptTypography";
import { resolvePaperPrintStyle, type ReceiptLayout } from "./receiptLayoutSchema";
import type { OutboundRequestPrintData } from "./receiptLayoutData";
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Merchant code remains in a confined design area, outside operational facts. */
export function protectOutboundRequestDocument(html: string, data: Record<string, unknown>, layout: ReceiptLayout) {
  const row = data.outbound_request as OutboundRequestPrintData;
  if (!row?.number || !Array.isArray(row.items)) throw new Error("出庫依頼書の必須情報がありません");
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => scopedReceiptCss(match[1], "request-design")).join("\n");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  const paper = resolvePaperPrintStyle(layout), type = receiptTypography(layout);
  const settings = layout.blocks.find(block => block.type === "outbound_request_items")?.settings;
  const info = layout.blocks.find(block => block.type === "outbound_request_info")?.settings;
  const design = (fragment: string) => fragment.trim() ? '<div class="request-design">' + cleanReceiptFragment(fragment) + '</div>' : "";
  const fragments = body.split(/<!-- outbound-request-items -->/);
  const items = `<section class="request-required"><div class="request-item"><b>アイテム</b><b>数量</b></div>${row.items.map(item => `<div class="request-item"><div class="request-description"><b>${escape(item.title)}</b>${item.variant_title ? `<div>${escape(item.variant_title)}</div>` : ""}${settings?.show_sku !== false && item.sku ? `<div>${escape(item.sku)}</div>` : ""}${settings?.show_barcode !== false && item.barcode ? `<div>JAN: ${escape(item.barcode)}</div>` : ""}${item.reason ? `<div>理由: ${escape(item.reason)}</div>` : ""}</div><div class="request-quantity">依頼 ${escape(item.requested)}${item.actual !== null ? `<br>${row.status_label === "出庫完了" ? "出庫" : "検品"} ${escape(item.actual)}` : ""}</div></div>`).join("")}</section>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>出庫依頼書</title><style>
html,body{margin:0;padding:0;width:100%;background:#fff;color:#000;font-family:${type.fontFamily};font-size:${type.fontSize};line-height:${type.lineHeight};font-weight:${type.fontWeight}}*{box-sizing:border-box}${styles}
.request-design{contain:paint!important;isolation:isolate!important;position:relative!important;overflow:hidden!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;transform:none!important}
.request-required{padding:${paper.marginYMm}mm ${paper.marginXMm}mm;overflow-wrap:anywhere}.request-item{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #000}.request-description{min-width:0;flex:1}.request-quantity{white-space:nowrap;font-size:${type.quantitySize};font-variant-numeric:tabular-nums}.request-info{text-align:center;border-top:3px solid #000}.request-info p{margin:3px 0}.request-number{font-size:1.3em;font-weight:700}@page{size:auto;margin:0}
</style></head><body>${design(fragments[0])}${items}${fragments.length > 1 ? design(fragments.slice(1).join("")) : ""}<section class="request-required request-info"><p class="request-number">依頼番号 ${escape(row.number)}</p><p>出庫元: ${escape(row.origin_name)}</p><p>移動先: ${escape(row.destination_name)}</p><p>希望出庫日: ${escape(row.due_date)}</p><p>${escape(row.status_label)}${info?.show_version !== false ? "・版" + escape(row.version) : ""}</p></section></body></html>`;
}
