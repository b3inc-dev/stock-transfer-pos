/* global globalThis */
import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "vite";
let vite, editor, receipt, layouts, variables, render, fixture, legacy;
const shop = "fixture.myshopify.com", both = { shop, reservation: true, outbound: true };
before(async () => {
  globalThis.unifiedReceiptFixture = fixture = {};
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "receipt-fixture", enforce: "pre", resolveId(id) {
    if (id === "../db.server") return "\0unified-db";
    if (id === "../shopify.server") return "\0unified-auth";
    if (id === "./shop-plan.server") return "\0unified-plan";
    if (id === "./reservations.server" || id === "../utils/reservations.server") return "\0unified-reservation";
    if (id === "./outbound-requests.server") return "\0unified-outbound";
  }, load(id) {
    if (id === "\0unified-db") return "export default new Proxy({}, {get:(_,key)=>globalThis.unifiedReceiptFixture.db[key]})";
    if (id === "\0unified-auth") return 'export const authenticate={admin:async()=>({session:{shop:"fixture.myshopify.com"},admin:{}})}';
    if (id === "\0unified-plan") return 'export const checkShopFeatureAccess=async({feature})=>({access:globalThis.unifiedReceiptFixture.allowed[feature]?"allowed":"blocked"})';
    if (id === "\0unified-reservation") return "export const reservationsEnabled=()=>globalThis.unifiedReceiptFixture.reservationEnabled";
    if (id === "\0unified-outbound") return "export const outboundRequestsEnabled=()=>globalThis.unifiedReceiptFixture.outboundEnabled";
  } }] });
  editor = await vite.ssrLoadModule("/app/utils/receipt-editor.server.ts");
  receipt = await vite.ssrLoadModule("/app/services/outboundRequestReceipt.ts");
  layouts = await vite.ssrLoadModule("/app/services/reservationReceiptLayout.ts");
  variables = await vite.ssrLoadModule("/app/services/receiptLayoutVariables.ts");
  render = await vite.ssrLoadModule("/app/services/receiptLayoutRender.ts");
  legacy = await vite.ssrLoadModule("/app/routes/app.reservations_.receipt.tsx");
});
after(async () => { await vite?.close(); delete globalThis.unifiedReceiptFixture; });
beforeEach(() => {
  Object.assign(fixture, { calls: [], allowed: { reservation: true, outboundRequest: true }, reservationEnabled: true, outboundEnabled: true, rows: { stockReservationSettings: { receiptVersion: 3, receiptLayout: null, days: 9 }, outboundRequestSettings: { receiptVersion: 2, receiptLayout: null, version: 7, policy: { paperWidth: 80, printerProfile: "mpop_58" } } } });
  fixture.db = Object.fromEntries(Object.keys(fixture.rows).map(table => [table, {
    async findUnique({ where }) { assert.equal(where.shop, shop); return structuredClone(fixture.rows[table]); },
    async upsert(args) { fixture.calls.push(args); assert.equal(args.where.shop, shop); },
    async updateMany(args) { fixture.calls.push(args); assert.equal(args.where.shop, shop); if (args.where.receiptVersion !== fixture.rows[table].receiptVersion) return { count: 0 }; Object.assign(fixture.rows[table], { receiptLayout: structuredClone(args.data.receiptLayout), receiptVersion: fixture.rows[table].receiptVersion + 1 }); return { count: 1 }; },
  }]));
  fixture.db.$transaction = async fn => { const before = structuredClone(fixture.rows); try { return await fn(fixture.db); } catch (e) { fixture.rows = before; throw e; } };
});
test("three receipt editors preserve saved Liquid, copy flags and policy while saving atomically", async () => {
  const saved = layouts.normalizeReservationReceiptSettings(null);
  saved.customer = { ...saved.customer, mode: "code", code: "<h1>店舗独自の書式</h1><!-- reservation-items -->" };
  saved.storeCopy = false; fixture.rows.stockReservationSettings.receiptLayout = saved;
  const loaded = await editor.loadReceiptEditor(both);
  assert.equal(loaded.reservation.customer.code, saved.customer.code); assert.equal(loaded.reservation.storeCopy, false);
  assert.equal(loaded.outbound.layout.paperWidthMm, 80); assert.equal(loaded.outbound.printerProfile, "mpop_58");
  const result = await editor.saveReceiptEditor(both, loaded);
  assert.equal(result.reservationVersion, 4); assert.equal(result.outboundVersion, 3);
  assert.equal(fixture.rows.stockReservationSettings.days, 9); assert.equal(fixture.rows.outboundRequestSettings.version, 7);
  assert.deepEqual(fixture.rows.outboundRequestSettings.policy, { paperWidth: 80, printerProfile: "mpop_58" });
  assert.equal(fixture.rows.stockReservationSettings.receiptLayout.customer.code, saved.customer.code);
});
test("a conflict in the second receipt rolls back both and invalid versions cannot write", async () => {
  const loaded = await editor.loadReceiptEditor(both), before = structuredClone(fixture.rows);
  await assert.rejects(() => editor.saveReceiptEditor(both, { ...loaded, outboundVersion: 1 }), /別の画面/);
  assert.deepEqual(fixture.rows, before);
  for (const version of [null, "", "3", -1, 1.5]) await assert.rejects(() => editor.saveReceiptEditor(both, { ...loaded, reservationVersion: version }), /読み直して/);
  assert.deepEqual(fixture.rows, before);
});
test("disabled and unpaid features are gated separately; forged hidden receipt cannot save", async () => {
  fixture.reservationEnabled = false;
  const context = await editor.receiptEditorContext(new Request("https://test/app/receipts"));
  assert.deepEqual(context, { shop, reservation: false, outbound: true });
  const loaded = await editor.loadReceiptEditor(both);
  await assert.rejects(() => editor.saveReceiptEditor(context, loaded), /権限/); assert.equal(fixture.calls.length, 0);
  fixture.allowed.outboundRequest = false;
  await assert.rejects(() => editor.receiptEditorContext(new Request("https://test/app/receipts")), e => e.status === 302);
  fixture.outboundEnabled = false;
  await assert.rejects(() => editor.receiptEditorContext(new Request("https://test/app/receipts")), e => e.status === 404);
});
test("old receipt URL opens the independent editor without copying token query parameters", async () => {
  const result = await legacy.loader({ request: new Request("https://test/app/reservations/receipt?host=embedded&shop=fixture.myshopify.com&id_token=private&tab=store") });
  const location = result.headers.get("Location"); assert.match(location, /^\/app\/receipts\?/); assert.match(location, /tab=customer/); assert.doesNotMatch(location, /private|id_token/);
});
test("outbound code variables and required facts render with three product lines and separate actual counts", () => {
  assert.ok(variables.TEMPLATE_VARIABLES.outbound_request.some(v => v.name === "outbound_request.items"));
  const row = { number: "#OR0001", version: 2, originName: "渋谷店", destinationName: "横浜店", dueDate: "2026-12-03", status: "working", note: "店舗メモ", claimKey: "PRIVATE-CLAIM", owner: "PRIVATE-OWNER", lines: [{ inventoryItemId: "1", productTitle: "シート", title: "シート / 青", variantTitle: "青 / iPhone15", sku: "SKU-001", barcode: "0001", quantity: 2 }], actualLines: [{ inventoryItemId: "1", quantity: 1, reason: "在庫不足" }] };
  for (const width of [58, 80]) for (const profile of ["standard", "mpop_58", "mcp31lb_58"]) {
    const setting = receipt.normalizeOutboundReceiptSettings(null, { paperWidth: width, printerProfile: profile });
    setting.layout = { ...setting.layout, mode: "code", code: '<style>body{display:none}.request-required{display:none}</style><img src="https://cdn.shopify.com/sample.png"><script>unsafe()</script><!-- outbound-request-items -->' };
    const html = receipt.renderConfiguredOutboundRequestReceipt(row, {}, setting);
    for (const value of ["シート</b>", "<div>青 / iPhone15</div>", "<div>SKU-001</div>", "依頼 2<br>検品 1", "在庫不足", "#OR0001", "渋谷店", "横浜店", "2026-12-03"]) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /<script>|unsafe\(\)|PRIVATE-/); assert.match(html, /class="request-required request-info"/);
    assert.match(html, /class="request-design"/); assert.match(html, /img src="https:\/\/cdn.shopify.com/);
    const preview = render.renderReceiptLayout(setting.layout, receipt.outboundReceiptData(row)); assert.equal(preview.ok, true);
    assert.ok(preview.html.includes("依頼 2<br>検品 1"));
  }
  const uninspected = receipt.renderConfiguredOutboundRequestReceipt({ ...row, actualLines: [] }, {});
  assert.ok(!uninspected.includes("検品 0"), "not inspected is not zero inspected");
});
