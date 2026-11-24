import { japanesePhoneDisplay } from "../../extensions/common/customerDisplay.js";
import { reservationDisplayNumber, reservationIntakeLabel } from "../../extensions/common/reservations.js";
/** POS Receipt live 6df3d07 を基準にした取置用の設定と、印刷データの許可リスト。 */
import { normalizeReservationReceipt } from "../../extensions/common/reservationReceipt.js";
import { defaultLayout, RESERVATION_FOOTER_TEXT } from "./receiptLayoutPresets";
import { canonicalLayout, type ReceiptLayout } from "./receiptLayoutSchema";
import { sampleTemplateData, type ReceiptTemplateData } from "./receiptLayoutData";
import { validateLayoutInput } from "./receiptLayoutValidate";
import { renderReceiptLayout } from "./receiptLayoutRender";
import { applyPrinterProfile, normalizePrinterProfile, printerGeometry, type ReceiptPrinterProfile } from "./receiptPrinterProfile";
export type ReservationReceiptSettings = { version: 2; customerCopy: boolean; storeCopy: boolean; printerProfile: ReceiptPrinterProfile; customer: ReceiptLayout; store: ReceiptLayout };
export type ReservationReceiptRow = { id: string; number?: number | null; intakeMethod?: string | null; locationName: string; locationAddress?: { zip?: string | null; province?: string | null; city?: string | null; address1?: string | null; address2?: string | null; phone?: string | null; countryCode?: string; formatted?: string[] }; timezone: string; createdAt: string | Date; dueDate: string; createdBy: string; lines: unknown };
export function normalizeReservationReceiptSettings(input: unknown, strict = false): ReservationReceiptSettings {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (raw.version === 2) {
    if (typeof raw.customerCopy !== "boolean" || typeof raw.storeCopy !== "boolean" || (!raw.customerCopy && !raw.storeCopy)) throw new Error("発行する控えを1つ以上選んでください");
    if (!["standard", "mpop_58", "mcp31lb_58"].includes(String(raw.printerProfile))) throw new Error("プリンター補正を選択してください");
    const layouts = ["customer", "store"].map(key => {
      const result = validateLayoutInput(raw[key], "reservation");
      if (!result.ok) throw new Error(result.errors.join("\n"));
      const layout = result.layout;
      if (layout.mode === "blocks") {
        if (!["reservation_info", "reservation_items"].every(type => layout.blocks.some(block => block.type === type && !block.hidden))) throw new Error("取置番号・受取期限・商品・数量は表示してください");
      }
      return canonicalLayout(layout);
    });
    return { version: 2, customerCopy: raw.customerCopy, storeCopy: raw.storeCopy, printerProfile: normalizePrinterProfile(raw.printerProfile), customer: layouts[0], store: layouts[1] };
  }
  const legacy = normalizeReservationReceipt(input, strict);
  const build = () => {
    const layout = defaultLayout("reservation");
    layout.paperWidthMm = legacy.paperWidth as 58 | 80;
    layout.style.fontSizePx = legacy.fontSize;
    layout.style.lineHeight = { compact: 1.15, normal: 1.35, relaxed: 1.6 }[legacy.bodySpacing] || 1.35;
    for (const block of layout.blocks) {
      if (block.type === "heading") block.settings.text = legacy.receiptTitle;
      if (block.type === "text") block.settings.text = legacy.footerNote === "ご来店時にこの控えをご提示ください。" ? RESERVATION_FOOTER_TEXT : legacy.footerNote;
      if (block.type === "reservation_info") Object.assign(block.settings, { show_date: legacy.showIssueDate, show_staff: legacy.showStaff });
      if (block.type === "reservation_items") Object.assign(block.settings, { show_sku: legacy.showSku, show_barcode: legacy.showBarcode });
      if (block.type === "store_info") Object.assign(block.settings, { show_name: legacy.showLocationName, show_address: true, show_phone: true });
    }
    // Preserve merchant issuer data as editable blocks; customer data is never copied.
    if (legacy.logoUrl) layout.blocks.unshift({ id: "logo", type: "logo", hidden: false, settings: { image_url: legacy.logoUrl, use_shop_logo: false, text: "", width_percent: 50, bold: true, align: legacy.headerAlignment } });
    const issuer = [legacy.companyName, legacy.postalCode, legacy.address, legacy.address2, legacy.phone].filter(Boolean).join("\n");
    if (issuer) layout.blocks.push({ id: "issuer-text", type: "text", hidden: false, settings: { text: issuer, align: legacy.headerAlignment, size: "s" } });
    return canonicalLayout(layout);
  };
  return { version: 2, customerCopy: legacy.customerCopy, storeCopy: legacy.storeCopy, printerProfile: "standard", customer: build(), store: build() };
}
export function reservationReceiptData(row: ReservationReceiptRow, copy: "customer" | "store"): ReceiptTemplateData {
  const address = copy === "customer" ? row.locationAddress : undefined;
  const addressLines = !address ? [] : address.countryCode === "JP" ? [[address.province, address.city, address.address1].filter(Boolean).join(""), address.address2].filter(Boolean) as string[] : address.formatted || [address.address1, address.address2, address.city, address.province].filter(Boolean) as string[];
  // Do not spread row here: it contains customer PII and internal operation/checkout keys.
  return { kind: "reservation", document: { title: "取置控え" }, shop: { name: row.locationName, currency: "JPY", logo_url: "" },
    location: { name: row.locationName, zip: address?.zip || "", address_lines: addressLines, phone: japanesePhoneDisplay(address?.phone) }, staff: { name: row.createdBy }, printed_at: "",
    reservation: { number: reservationDisplayNumber(row), due_date: row.dueDate, created_at_label: new Intl.DateTimeFormat("ja-JP", { timeZone: row.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.createdAt)), copy_label: copy === "customer" ? "お客様控え" : "店舗保管用", intake_label: copy === "store" ? reservationIntakeLabel(row) : "",
      items: receiptLines(row.lines) } };
}
export function reservationSampleData(copy: "customer" | "store") {
  const data = sampleTemplateData("reservation");
  if (data.kind === "reservation") { data.reservation.copy_label = copy === "customer" ? "お客様控え" : "店舗保管用"; data.reservation.intake_label = copy === "store" ? "店頭で受付" : ""; if (copy === "store") data.location = { ...data.location, zip: "", address_lines: [], phone: "" }; }
  return data;
}
export function renderConfiguredReservationReceipt(row: ReservationReceiptRow, raw: unknown, copy: "customer" | "store") {
  const settings = normalizeReservationReceiptSettings(raw);
  if (copy === "customer" && row.intakeMethod === "inquiry") throw new Error("お問い合わせでの受付は、お客様控えを発行しません");
  if (!(copy === "customer" ? settings.customerCopy : settings.storeCopy)) throw new Error("この控えは管理画面で発行しない設定です");
  const layout = settings[copy];
  const result = renderReceiptLayout(layout, reservationReceiptData(row, copy));
  if (!result.ok) throw new Error(result.error);
  const html = applyPrinterProfile(result.html, settings.printerProfile, layout.paperWidthMm);
  const viewport = printerGeometry(settings.printerProfile, layout.paperWidthMm).viewportPx;
  return viewport ? html.replace(/<meta\s+name=["']viewport["'][^>]*>/i, `<meta name="viewport" content="width=${viewport}, initial-scale=1">`) : html;
}

function receiptLines(input: unknown) {
  if (!Array.isArray(input)) throw new Error("取置商品の記録を確認してください");
  return input.map(line => {
    if (!line || typeof line !== "object" || typeof line.title !== "string" || !Number.isInteger(line.quantity) || line.quantity < 1) throw new Error("取置商品の記録を確認してください");
    return { title: line.title, quantity: line.quantity, sku: typeof line.sku === "string" ? line.sku : "", barcode: typeof line.barcode === "string" ? line.barcode : "" };
  });
}
