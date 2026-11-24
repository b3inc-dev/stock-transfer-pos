/** @typedef {{ customerCopy: boolean, storeCopy: boolean, templateName: string, receiptTitle: string, logoUrl: string, companyName: string, postalCode: string, address: string, address2: string, phone: string, paperWidth: number, fontSize: number, headerAlignment: string, logoPosition: string, companyInfoPosition: string, bodySpacing: string, showIssueDate: boolean, showLocationName: boolean, showStaff: boolean, showSku: boolean, showBarcode: boolean, footerNote: string }} ReservationReceiptLayout */
/** Merchant-editable receipt layout, shared by admin preview and authenticated print endpoint. */
/** @type {Readonly<ReservationReceiptLayout>} */
export const DEFAULT_RESERVATION_RECEIPT = Object.freeze({
  customerCopy: true, storeCopy: true,
  templateName: "取置控え", receiptTitle: "取置控え", logoUrl: "", companyName: "", postalCode: "", address: "", address2: "", phone: "",
  paperWidth: 80, fontSize: 14, headerAlignment: "center", logoPosition: "top", companyInfoPosition: "bottom", bodySpacing: "normal",
  showIssueDate: true, showLocationName: true, showStaff: true, showSku: true, showBarcode: false,
  footerNote: "ご来店時にこの控えをご提示ください。",
});
const enums = { headerAlignment: ["left", "center", "right"], logoPosition: ["top", "inline"], companyInfoPosition: ["top", "bottom"], bodySpacing: ["compact", "normal", "relaxed"] };
/** @param {unknown} input @param {boolean} strict @returns {ReservationReceiptLayout} */
export function normalizeReservationReceipt(input, strict = false) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (strict && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(source).some(key => !Object.hasOwn(DEFAULT_RESERVATION_RECEIPT, key)))) throw new Error("レシートの設定項目を確認してください");
  const output = { ...DEFAULT_RESERVATION_RECEIPT };
  for (const [key, fallback] of Object.entries(DEFAULT_RESERVATION_RECEIPT)) {
    if (!(key in source)) continue;
    let value = source[key], valid = true;
    if (typeof fallback === "boolean") valid = typeof value === "boolean";
    else if (key === "paperWidth") valid = [58, 80].includes(value);
    else if (key === "fontSize") valid = [12, 14, 16].includes(value);
    else if (enums[key]) valid = enums[key].includes(value);
    else { valid = typeof value === "string" && value.length <= (key === "footerNote" ? 1000 : key === "logoUrl" ? 2048 : 200); if (valid) value = value.trim(); }
    if (valid && key === "logoUrl" && value) { try { const url = new URL(value); valid = url.protocol === "https:" && !url.username && !url.password; } catch { valid = false; } }
    if (valid && ["receiptTitle", "templateName"].includes(key) && !value) valid = false;
    if (!valid) { if (strict) throw new Error(key === "logoUrl" ? "ロゴはHTTPSの画像URLを入力してください" : "レシートの入力内容と選択項目を確認してください"); continue; }
    output[key] = value;
  }
  if (!output.customerCopy && !output.storeCopy) { if (strict) throw new Error("発行する控えを1つ以上選んでください"); output.customerCopy = true; }
  return output;
}
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const date = (value, timezone) => new Intl.DateTimeFormat("ja-JP", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
export function renderReservationReceipt(row, input) {
  const layout = normalizeReservationReceipt(input);
  const spacing = { compact: 3, normal: 6, relaxed: 10 }[layout.bodySpacing];
  const logo = layout.logoUrl ? `<img class="logo" src="${escape(layout.logoUrl)}" alt="店舗ロゴ">` : "";
  const company = [layout.companyName, layout.postalCode ? `〒${layout.postalCode}` : "", layout.address, layout.address2, layout.phone].filter(Boolean).map(line => escape(line)).join("<br>");
  const companyBlock = company ? `<div class="company">${company}</div>` : "";
  const heading = `<header>${layout.logoPosition === "top" ? logo : ""}<div class="heading">${layout.logoPosition === "inline" ? logo : ""}<h1>${escape(layout.receiptTitle)}</h1></div></header>`;
  // Customer name, phone, amounts and internal mutation data are deliberately not read here.
  const content = `${heading}${layout.companyInfoPosition === "top" ? companyBlock : ""}${layout.showLocationName ? `<p>${escape(row.locationName)}</p>` : ""}<p class="number">取置番号 ${escape(row.id)}</p><p>${layout.showIssueDate ? `受付 ${escape(date(row.createdAt, row.timezone))}<br>` : ""}<span class="due">受取期限 ${escape(row.dueDate)}</span></p><table><tbody>${row.lines.map(line => `<tr><td>${escape(line.title)}${layout.showSku && line.sku ? `<div class="code">SKU: ${escape(line.sku)}</div>` : ""}${layout.showBarcode && line.barcode ? `<div class="code">JAN: ${escape(line.barcode)}</div>` : ""}</td><td>${escape(line.quantity)}点</td></tr>`).join("")}</tbody></table>${layout.showStaff ? `<p>担当 ${escape(row.createdBy)}</p>` : ""}${layout.companyInfoPosition === "bottom" ? companyBlock : ""}<footer>${escape(layout.footerNote)}</footer>`;
  const copies = [layout.customerCopy ? "お客様控え" : null, layout.storeCopy ? "店舗保管用" : null].filter(Boolean);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:"><title>${escape(layout.receiptTitle)}</title><style>
*{box-sizing:border-box}body{font:${layout.fontSize}px sans-serif;width:${layout.paperWidth === 58 ? 384 : 576}px;max-width:100%;margin:0 auto;padding:12px;color:#000;background:#fff;overflow-wrap:anywhere}header{text-align:${layout.headerAlignment}}h1{font-size:1.35em;margin:0 0 ${spacing}px}.heading{display:flex;align-items:center;justify-content:${{ left: "flex-start", center: "center", right: "flex-end" }[layout.headerAlignment]};gap:12px}.logo{max-width:120px;max-height:80px;object-fit:contain}.company{margin:${spacing * 2}px 0;text-align:${layout.headerAlignment}}p{margin:${spacing * 2}px 0}.number,.due{font-weight:bold}table{width:100%;border-collapse:collapse}td{padding:${spacing}px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap;padding-left:8px}.code{font-size:.85em}footer{white-space:pre-wrap;margin-top:${spacing * 2}px} .copy-label{text-align:center;font-weight:bold}.copy+.copy{border-top:1px dashed #999;margin-top:24px;padding-top:12px} @media print{body{padding:0}.copy{break-after:page;page-break-after:always}.copy:last-child{break-after:auto;page-break-after:auto}.copy+.copy{border:0;margin:0;padding:0}}
</style></head><body>${copies.map(label => `<section class="copy"><p class="copy-label">${label}</p>${content}</section>`).join("")}</body></html>`;
}

/** POS intake only describes copies whose saved settings were successfully loaded. */
export function reservationReceiptNotice(options, faceToFace = true) {
  if (!options || typeof options !== "object") return "";
  const customerCopy = options.customerCopy === true && faceToFace !== false;
  if (customerCopy && options.storeCopy === true) return "お客様控えは登録後、店舗控えは詳細画面から印刷します。";
  if (customerCopy) return "お客様控えは登録後に印刷します。";
  if (options.storeCopy === true) return "店舗控えは詳細画面から印刷できます。";
  return "";
}
