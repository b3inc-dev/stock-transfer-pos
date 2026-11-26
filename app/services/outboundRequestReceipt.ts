import { normalizeOutboundRequestPolicy, OUTBOUND_REQUEST_LABELS } from "../../extensions/common/outboundRequests.js";
import { applyPrinterProfile, normalizePrinterProfile, printerGeometry, type ReceiptPrinterProfile } from "./receiptPrinterProfile";
import { defaultLayout } from "./receiptLayoutPresets";
import { validateLayoutInput } from "./receiptLayoutValidate";
import { canonicalLayout, type ReceiptLayout } from "./receiptLayoutSchema";
import { renderReceiptLayout } from "./receiptLayoutRender";
import type { RequestRow } from "../utils/outbound-requests.server";
import type { ReceiptTemplateData } from "./receiptLayoutData";
export type OutboundReceiptSettings = { version: 1; printerProfile: ReceiptPrinterProfile; layout: ReceiptLayout };
export function normalizeOutboundReceiptSettings(raw: unknown, policyInput?: unknown): OutboundReceiptSettings {
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("出庫依頼書の設定を確認してください");
    const value = raw as Record<string, unknown>, checked = validateLayoutInput(value.layout, "outbound_request");
    if (value.version !== 1 || !checked.ok || !["standard", "mpop_58", "mcp31lb_58"].includes(String(value.printerProfile))) throw new Error(checked.ok ? "出庫依頼書の設定を確認してください" : checked.errors.join("\n"));
    if (checked.layout.mode === "blocks" && !["outbound_request_info", "outbound_request_items"].every(type => checked.layout.blocks.some(block => block.type === type && !block.hidden))) throw new Error("依頼番号・出庫元・移動先・商品と数量は表示してください");
    return { version: 1, printerProfile: normalizePrinterProfile(value.printerProfile), layout: canonicalLayout(checked.layout) };
  }
  const policy = normalizeOutboundRequestPolicy(policyInput), layout = defaultLayout("outbound_request");
  layout.paperWidthMm = policy.paperWidth as 58 | 80;
  return { version: 1, printerProfile: normalizePrinterProfile(policy.printerProfile), layout };
}
export function outboundReceiptData(row: RequestRow): ReceiptTemplateData {
  const actual = new Map(row.actualLines.map(item => [item.inventoryItemId, item]));
  const lines = [...row.lines, ...row.actualLines.filter(item => !row.lines.some(line => line.inventoryItemId === item.inventoryItemId)).map(item => ({ ...item, quantity: 0 }))];
  return { kind: "outbound_request", document: { title: "出庫依頼書" }, shop: { name: row.originName, currency: "JPY", logo_url: "" }, location: { name: row.originName, zip: "", address_lines: [], phone: "" }, staff: { name: "" }, printed_at: "", outbound_request: { number: row.number, version: row.version, origin_name: row.originName, destination_name: row.destinationName, due_date: row.dueDate || "指定なし", status_label: OUTBOUND_REQUEST_LABELS[row.status as keyof typeof OUTBOUND_REQUEST_LABELS] || "要確認", note: row.note, items: lines.map(line => ({ title: line.productTitle || line.title, variant_title: line.variantTitle || "", sku: line.sku || "", barcode: line.barcode || "", requested: line.quantity, actual: actual.has(line.inventoryItemId) ? actual.get(line.inventoryItemId)!.quantity : row.status === "completed" ? 0 : null, reason: actual.get(line.inventoryItemId)?.reason || "" })) } };
}
/** Same renderer and printer geometry for preview and POS printing. */
export function renderConfiguredOutboundRequestReceipt(row: RequestRow, policy: unknown, raw?: unknown) {
  const settings = normalizeOutboundReceiptSettings(raw, policy), layout = settings.layout, rendered = renderReceiptLayout(layout, outboundReceiptData(row));
  if (!rendered.ok) throw new Error(rendered.error);
  const html = applyPrinterProfile(rendered.html, settings.printerProfile, layout.paperWidthMm), viewport = printerGeometry(settings.printerProfile, layout.paperWidthMm).viewportPx;
  return viewport ? html.replace(/<meta\s+name=["']viewport["'][^>]*>/i, '<meta name="viewport" content="width=' + viewport + ', initial-scale=1">') : html;
}
