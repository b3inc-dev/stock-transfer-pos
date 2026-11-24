import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "vite";
let vite, receipt, render;
before(async () => {
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false } });
  receipt = await vite.ssrLoadModule("/app/services/reservationReceiptLayout.ts");
  render = await vite.ssrLoadModule("/app/services/receiptLayoutRender.ts");
});
after(async () => { await vite?.close(); });
const row = { id: "R-TEST-1", locationName: "店舗A", timezone: "Asia/Tokyo", createdAt: "2026-11-25T00:00:00Z", dueDate: "2026-12-02", createdBy: "担当1", guestName: "秘密氏名", contactPhone: "09099999999", customerId: "secret-customer", checkoutKey: "secret-key", lines: [{ title: "商品<&", quantity: 2, sku: "SKU1", barcode: "123" }] };
test("legacy settings migrate into two independently editable layouts", () => {
  const settings = receipt.normalizeReservationReceiptSettings({ companyName: "会社", footerNote: "以前の文言", showSku: true, paperWidth: 58, customerCopy: true, storeCopy: false });
  assert.equal(settings.version, 2); assert.equal(settings.customer.paperWidthMm, 58); assert.equal(settings.storeCopy, false);
  settings.customer.blocks[0].settings.text = "お客様用";
  assert.equal(settings.store.blocks[0].settings.text, "取置控え");
  assert.match(JSON.stringify(settings), /以前の文言/); assert.match(JSON.stringify(settings), /会社/);
  assert.doesNotThrow(() => receipt.normalizeReservationReceiptSettings(settings, true));
});
test("both paper sizes and each copy render through same Liquid engine with no customer data", () => {
  for (const mm of [58, 80]) for (const copy of ["customer", "store"]) {
    const settings = receipt.normalizeReservationReceiptSettings(null);
    settings[copy].paperWidthMm = mm;
    const html = receipt.renderConfiguredReservationReceipt(row, settings, copy);
    assert.match(html, copy === "customer" ? /お客様お渡し用/ : /店舗保管用/);
    assert.equal(html.split("R-TEST-1").length - 1, 1); assert.equal(html.split("2026-12-02").length - 1, 1); assert.match(html, /商品&lt;&amp;/); assert.match(html, /2点/);
    assert.doesNotMatch(html, /秘密氏名|09099999999|secret-customer|secret-key/);
    assert.equal(render.paperWidthPx(mm), mm === 58 ? 181 : 272);
    const data = receipt.reservationReceiptData(row, copy);
    assert.equal(data.guestName, undefined); assert.equal(data.contactPhone, undefined);
  }
});
test("code mode preserves required variables, validates Liquid and escapes values", () => {
  const settings = receipt.normalizeReservationReceiptSettings(null);
  settings.customer.code = render.blocksToCode(settings.customer);
  settings.customer.mode = "code";
  assert.doesNotThrow(() => receipt.normalizeReservationReceiptSettings(settings, true));
  assert.match(receipt.renderConfiguredReservationReceipt(row, settings, "customer"), /商品&lt;&amp;/);
  settings.customer.code = "<p>必須項目を消したコード</p>";
  assert.doesNotThrow(() => receipt.normalizeReservationReceiptSettings(settings, true));
  const protectedHtml = receipt.renderConfiguredReservationReceipt(row, settings, "customer");
  assert.match(protectedHtml, /R-TEST-1/); assert.match(protectedHtml, /2026-12-02/); assert.match(protectedHtml, /2点/);
});
test("disabled copies, missing required blocks and malformed Liquid are rejected", () => {
  const settings = receipt.normalizeReservationReceiptSettings(null);
  settings.storeCopy = false;
  assert.throws(() => receipt.renderConfiguredReservationReceipt(row, settings, "store"), /発行しない/);
  settings.customer.blocks = settings.customer.blocks.filter(block => block.type !== "reservation_items");
  assert.throws(() => receipt.normalizeReservationReceiptSettings(settings, true), /表示して/);
  settings.customerCopy = false;
  assert.throws(() => receipt.normalizeReservationReceiptSettings(settings, true), /1つ以上/);
});
test("printer correction is output-only and idempotent", () => {
  const settings = receipt.normalizeReservationReceiptSettings(null);
  settings.customer.paperWidthMm = 58; settings.printerProfile = "mcp31lb_58";
  const saved = JSON.stringify(settings);
  const html = receipt.renderConfiguredReservationReceipt(row, settings, "customer");
  assert.match(html, /data-receipt-printer-profile="mcp31lb_58"/);
  assert.equal(JSON.stringify(settings), saved);
});

test("comments, hidden CSS and document metadata cannot remove the fixed required section", () => {
  const settings = receipt.normalizeReservationReceiptSettings(null);
  settings.customer.mode = "code";
  settings.customer.code = '<html><head><style>html,body {display:none!important} .reservation-required {display:none!important} @media print {section{display:none!important}}</style><meta http-equiv="refresh" content="0;https://example.invalid"></head><body>{% comment %}reservation.number{% endcomment %}<script>alert(1)</script><p>自由編集</p></body></html>';
  const html = receipt.renderConfiguredReservationReceipt(row, settings, "customer");
  assert.match(html, /class="reservation-required"/); assert.equal(html.split("R-TEST-1").length - 1, 1); assert.equal(html.split("2026-12-02").length - 1, 1); assert.match(html, /2点/);
  assert.doesNotMatch(html, /<script|http-equiv="refresh"/);
  assert.match(html, /\.reservation-design \.reservation-required/);
});
