import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESERVATION_RECEIPT, normalizeReservationReceipt, renderReservationReceipt } from "../extensions/common/reservationReceipt.js";
const row = { id: "R-TEST", locationName: "店舗A", timezone: "Asia/Tokyo", createdAt: "2026-11-24T16:00:00Z", dueDate: "2026-12-02", createdBy: "123", guestName: "SECRET NAME", contactPhone: "09099999999", customerId: "SECRET CUSTOMER ID", lines: [{ title: "商品", quantity: 2, sku: "SKU-1", barcode: "12345678" }] };
test("defaults print customer and store copies with page boundaries, fixed reservation number and expiry", () => {
  const html = renderReservationReceipt(row);
  assert.equal((html.match(/<section class="copy">/g) || []).length, 2);
  for (const label of ["お客様控え", "店舗保管用", "取置番号 R-TEST", "受取期限 2026-12-02", "2026/11/25", "page-break-after:always"]) assert.ok(html.includes(label));
  for (const secret of [row.guestName, row.contactPhone, row.customerId]) assert.ok(!html.includes(secret));
});
test("copy selection and display choices are reflected by the same renderer", () => {
  const html = renderReservationReceipt(row, { ...DEFAULT_RESERVATION_RECEIPT, customerCopy: false, paperWidth: 58, showIssueDate: false, showStaff: false, showSku: true, showBarcode: true, receiptTitle: "店舗の取置票" });
  assert.equal((html.match(/<section class="copy">/g) || []).length, 1); assert.ok(!html.includes("お客様控え"));
  assert.ok(html.includes("店舗保管用")); assert.ok(html.includes("width:384px")); assert.ok(html.includes("SKU: SKU-1")); assert.ok(html.includes("JAN: 12345678"));
  assert.ok(!html.includes("受付 2026")); assert.ok(!html.includes("担当 123"));
});
test("markup in user text is escaped and unsafe logo schemes are rejected", () => {
  const attack = '</p><script>alert(1)</script>';
  const html = renderReservationReceipt({ ...row, lines: [{ title: attack, quantity: 1 }] }, { receiptTitle: attack, footerNote: attack, companyName: attack });
  assert.ok(!html.includes("<script>")); assert.ok(html.includes("&lt;script&gt;")); assert.ok(html.includes("default-src 'none'"));
  for (const logoUrl of ["javascript:alert(1)", "http://example.com/a.png", "https://user:secret@example.com/a.png"]) assert.throws(() => normalizeReservationReceipt({ logoUrl }, true), /HTTPS/);
  assert.equal(normalizeReservationReceipt({ logoUrl: "https://example.com/logo.png" }, true).logoUrl, "https://example.com/logo.png");
});
test("invalid design values and empty copy selection fail before saving", () => {
  for (const invalid of [{ customerCopy: false, storeCopy: false }, { paperWidth: 100 }, { fontSize: -1 }, { headerAlignment: 'left;display:none' }, { showStaff: "false" }, { receiptTitle: "" }, { unsupported: true }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => normalizeReservationReceipt(invalid, true));
  assert.deepEqual(normalizeReservationReceipt(null), { ...DEFAULT_RESERVATION_RECEIPT });
});
