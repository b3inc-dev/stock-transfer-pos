/* global globalThis */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "vite";
let vite, action, loader, dbReads;
const shop = "fixture.myshopify.com", locationId = "gid://shopify/Location/1";
const row = { id: "R-12345678-1234-1234-1234-123456789abc", shop, locationId, locationName: "店", status: "held", version: 1, guestName: "Guest", contactPhone: "09012345678", customerId: null, timezone: "Asia/Tokyo", dueDate: "2026-11-25", createdAt: new Date(), createdBy: "123 / POS担当 456", lines: [{ variantId: "gid://shopify/ProductVariant/1", title: "Tシャツ", quantity: 2 }], events: [] };
before(async () => {
  globalThis.reservationApiFixture = {
    token: { dest: `https://${shop}`, sub: "123" },
    db: { stockReservationSettings: { async findUnique() { return globalThis.reservationApiFixture.receiptLayout ? { receiptLayout: globalThis.reservationApiFixture.receiptLayout } : null; } }, stockReservation: {
      async findFirst({ where }) { dbReads++; return where.id === row.id && where.shop === shop && where.locationId === locationId ? structuredClone(row) : null; },
      async findMany() { dbReads++; return [structuredClone(row)]; },
    } },
  };
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "reservation-auth", enforce: "pre", resolveId(id) {
    if (id === "../db.server") return "\0api-db";
    if (id === "../shopify.server") return "\0api-shopify";
    if (id === "../utils/plan-gate.server") return "\0api-plan";
  }, load(id) {
    if (id === "\0api-db") return "export default globalThis.reservationApiFixture.db";
    if (id === "\0api-shopify") return `export const authenticate = { pos: async () => ({sessionToken:globalThis.reservationApiFixture.token}) }; export const unauthenticated = { admin: async () => ({admin: {graphql: async (query, options) => globalThis.reservationApiFixture.graphql(query, options)}}) };`;
    if (id === "\0api-plan") return "export const planBlockedPosResponse = async () => null";
  } }] });
  ({ action, loader } = await vite.ssrLoadModule("/app/routes/api.reservations.tsx"));
});
after(async () => { delete globalThis.reservationApiFixture; delete process.env.RESERVATIONS_ENABLED; delete process.env.RESERVATION_POS_ACCESS; await vite?.close(); });
beforeEach(() => { globalThis.reservationApiFixture.receiptLayout = null; globalThis.reservationApiFixture.graphql = async () => { throw new Error("unexpected Shopify call"); }; dbReads = 0; process.env.RESERVATIONS_ENABLED = "1"; process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: false } } }); globalThis.reservationApiFixture.token = { dest: `https://${shop}`, sub: "123" }; });
const request = (body) => new Request("https://app.invalid/api/reservations", { method: "POST", body: JSON.stringify({ locationId, ...body }), headers: { "Content-Type": "application/json" } });
const post = body => action({ request: request(body) });
test("disabled feature performs no database access", async () => { delete process.env.RESERVATIONS_ENABLED; assert.equal((await post({ command: "detail", id: row.id })).status, 404); assert.equal(dbReads, 0); });
test("authenticated account must have an explicit location grant", async () => {
  assert.equal((await post({ command: "detail", id: row.id, locationId: "gid://shopify/Location/2" })).status, 403);
  delete process.env.RESERVATION_POS_ACCESS;
  assert.equal((await post({ command: "detail", id: row.id })).status, 403); assert.equal(dbReads, 0);
});
test("pinned staff claim cannot elevate contact permissions", async () => {
  const response = await post({ command: "detail", id: row.id, staffMemberId: "owner" });
  const data = await response.json(); assert.equal(data.row.phone, "•••• 5678"); assert.equal(data.row.contactVisible, false);
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: true } } });
  const permitted = await (await post({ command: "detail", id: row.id })).json(); assert.equal(permitted.row.phone, row.contactPhone);
});
test("another signed shop cannot read a reservation even when its account ID and location match", async () => {
  globalThis.reservationApiFixture.token.dest = "https://other.myshopify.com";
  assert.equal((await post({ command: "detail", id: row.id })).status, 403);
});
test("tile count is database-only; receipt excludes PII and enforces store grant", async () => {
  assert.equal((await post({ command: "count" })).status, 200);
  const response = await loader({ request: new Request(`https://app.invalid/api/reservations?receipt=${row.id}&locationId=${encodeURIComponent(locationId)}`) });
  const html = await response.text(); assert.equal(response.status, 200); assert.ok(!html.includes(row.guestName)); assert.ok(!html.includes(row.contactPhone));
  const denied = await loader({ request: new Request(`https://app.invalid/api/reservations?receipt=${row.id}&locationId=gid://shopify/Location/2`) }); assert.equal(denied.status, 403);
});

test("product search returns SKU, JAN, image, current-store stock and cursor with bounded page size", async () => {
  const calls = [];
  globalThis.reservationApiFixture.graphql = async (query, { variables }) => {
    calls.push({ query, variables });
    return Response.json({ data: { productVariants: { nodes: [{ id: "gid://shopify/ProductVariant/1", displayName: "Tシャツ / 青", title: "青", sku: "SKU-1", barcode: "1234567890123", image: { url: "https://image.invalid/1" }, product: { title: "Tシャツ" }, inventoryItem: { tracked: true, inventoryLevel: { quantities: [{ quantity: 4 }] } } }], pageInfo: { hasNextPage: true, endCursor: "next" } } } });
  };
  const result = await (await post({ command: "products", query: "SKU-1", first: 99999, after: "previous" })).json();
  assert.equal(calls[0].variables.first, 50); assert.equal(calls[0].variables.location, locationId); assert.equal(calls[0].variables.query, "sku:SKU-1 OR SKU-1"); assert.equal(calls[0].variables.after, "previous");
  assert.equal(result.products[0].available, 4); assert.equal(result.products[0].eligible, true); assert.equal(result.products[0].sku, "SKU-1"); assert.equal(result.products[0].imageUrl, "https://image.invalid/1"); assert.equal(result.pageInfo.endCursor, "next");
});
test("scanner queries use exact codes; restoring metadata uses validated variant IDs", async () => {
  const calls = [];
  globalThis.reservationApiFixture.graphql = async (query, { variables }) => { calls.push({ query, variables }); return Response.json({ data: variables.ids ? { nodes: [] } : { productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }); };
  await post({ command: "products", query: "12345678", scan: true });
  assert.equal(calls[0].variables.query, 'barcode:"12345678" OR sku:"12345678"');
  await post({ command: "products", ids: ["gid://shopify/ProductVariant/1", "invalid", "gid://shopify/ProductVariant/1"] });
  assert.deepEqual(calls[1].variables.ids, ["gid://shopify/ProductVariant/1"]); assert.equal(calls[1].variables.location, locationId);
});

test("printed receipt uses the saved layout and shared renderer used by admin preview", async () => {
  const layout = { receiptTitle: "店舗の取置伝票", customerCopy: true, storeCopy: false, paperWidth: 58 };
  globalThis.reservationApiFixture.receiptLayout = layout;
  const response = await loader({ request: new Request(`https://app.invalid/api/reservations?receipt=${row.id}&locationId=${encodeURIComponent(locationId)}`) });
  const { renderReservationReceipt } = await import("../extensions/common/reservationReceipt.js");
  assert.equal(await response.text(), renderReservationReceipt(row, layout));
  assert.match(response.headers.get("Content-Security-Policy"), /img-src https:/);
});

test("session display can show store name without granting access to customer data or reservations", async () => {
  delete process.env.RESERVATION_POS_ACCESS; const calls = [];
  globalThis.reservationApiFixture.graphql = async (query, { variables }) => { calls.push({ query, variables }); assert.ok(query.includes("ReservationSessionDisplay")); return Response.json({ data: { location: { id: locationId, name: "店舗の実名", isActive: true }, shop: { ianaTimezone: "Asia/Tokyo" } } }); };
  const result = await (await post({ command: "sessionDisplay", customerId: "gid://shopify/Customer/1", contact: true })).json();
  assert.equal(result.locationName, "店舗の実名"); assert.equal(result.customer, null); assert.equal(result.accessReady, false); assert.match(result.notice, /利用設定/); assert.equal(calls.length, 1);
  assert.equal((await post({ command: "products", query: "test" })).status, 403);
});
test("selected customer display respects signed contact grants and distinguishes missing phone", async () => {
  let phone = "09012345678";
  globalThis.reservationApiFixture.graphql = async query => Response.json({ data: query.includes("ReservationSessionDisplay") ? { location: { id: locationId, name: "店舗A", isActive: true }, shop: { ianaTimezone: "Asia/Tokyo" } } : { customer: { displayName: "選択されたお客様", phone } } });
  const masked = await (await post({ command: "sessionDisplay", customerId: "gid://shopify/Customer/1", contact: true })).json();
  assert.equal(masked.customer.name, "選択されたお客様"); assert.equal(masked.customer.phone, "•••• 5678");
  phone = null; const noPhone = await (await post({ command: "sessionDisplay", customerId: "gid://shopify/Customer/1" })).json();
  assert.equal(noPhone.customer.hasPhone, false); assert.equal(noPhone.customer.phone, "");
});
