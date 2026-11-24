/* global globalThis */
import process from "node:process";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { parse } from "graphql";
import { createServer } from "vite";
let vite, action, loader, dbReads;
const shop = "fixture.myshopify.com", locationId = "gid://shopify/Location/1";
const row = { id: "R-12345678-1234-1234-1234-123456789abc", shop, locationId, locationName: "店", status: "held", version: 1, guestName: "Guest", contactPhone: "09012345678", customerId: null, timezone: "Asia/Tokyo", dueDate: "2026-11-25", createdAt: new Date(), createdBy: "123 / POS担当 456", lines: [{ variantId: "gid://shopify/ProductVariant/1", title: "Tシャツ", quantity: 2 }], events: [] };
before(async () => {
  globalThis.reservationApiFixture = {
    token: { dest: `https://${shop}`, sub: "123" },
    db: { stockReservationSettings: { async findUnique() { return globalThis.reservationApiFixture.receiptLayout ? { receiptLayout: globalThis.reservationApiFixture.receiptLayout } : null; } }, stockReservation: {
      async findFirst({ where }) { dbReads++; return where.id === row.id && where.shop === shop && where.locationId === locationId ? structuredClone(row) : null; },
      async findMany({ where }) { dbReads++; return where.shop === shop && where.locationId === locationId ? [structuredClone(row)] : []; },
    } },
  };
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "reservation-auth", enforce: "pre", resolveId(id) {
    if (id === "../db.server") return "\0api-db";
    if (id === "../shopify.server") return "\0api-shopify";
    if (id === "../utils/plan-gate.server") return "\0api-plan";
  }, load(id) {
    if (id === "\0api-db") return "export default globalThis.reservationApiFixture.db";
    if (id === "\0api-shopify") return `export const authenticate = { pos: async () => ({sessionToken:globalThis.reservationApiFixture.token}) }; export const unauthenticated = { admin: async () => ({admin: {graphql: async (query, options) => globalThis.reservationApiFixture.graphql(query, options)}}) };`;
    if (id === "\0api-plan") return "export const planBlockedPosResponse = async () => globalThis.reservationApiFixture.planBlocked ? new Response(\"plan blocked\", {status:403}) : null";
  } }] });
  ({ action, loader } = await vite.ssrLoadModule("/app/routes/api.reservations.tsx"));
});
after(async () => { delete globalThis.reservationApiFixture; delete process.env.RESERVATIONS_ENABLED; delete process.env.RESERVATION_POS_ACCESS; delete process.env.APP_DISTRIBUTION; delete process.env.SHOPIFY_API_KEY; await vite?.close(); });
beforeEach(() => { delete process.env.APP_DISTRIBUTION; delete process.env.SHOPIFY_API_KEY; globalThis.reservationApiFixture.planBlocked = false; globalThis.reservationApiFixture.receiptLayout = null; globalThis.reservationApiFixture.graphql = async () => { throw new Error("unexpected Shopify call"); }; dbReads = 0; process.env.RESERVATIONS_ENABLED = "1"; process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: false } } }); globalThis.reservationApiFixture.token = { dest: `https://${shop}`, sub: "123" }; });
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

test("shop POS default permits authenticated POS users only at configured locations", async () => {
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { "*": { locations: [locationId], contact: true } } });
  const result = await (await post({ command: "detail", id: row.id })).json();
  assert.equal(result.row.phone, row.contactPhone);
  assert.equal((await post({ command: "count" })).status, 200);
  assert.equal((await post({ command: "detail", id: row.id, locationId: "gid://shopify/Location/2" })).status, 403);
  globalThis.reservationApiFixture.token.dest = "https://other.myshopify.com";
  assert.equal((await post({ command: "detail", id: row.id })).status, 403);
});
test("explicit account restrictions cannot inherit shop POS default contact or locations", async () => {
  for (const account of [null, { locations: [], contact: false }, { locations: ["invalid"], contact: true }]) {
    process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { "*": { locations: [locationId], contact: true }, 123: account } });
    assert.equal((await post({ command: "detail", id: row.id, staffMemberId: "456" })).status, 403);
  }
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { "*": { locations: [locationId], contact: true }, 123: { locations: [locationId], contact: false } } });
  const result = await (await post({ command: "detail", id: row.id })).json();
  assert.equal(result.row.phone, "•••• 5678");
});
test("shop POS defaults never grant Admin contact access or permit an anonymous subject", async () => {
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { "*": { locations: [locationId], contact: true } } });
  const { reservationAccountAccess } = await vite.ssrLoadModule("/app/utils/reservations.server.ts");
  assert.equal(reservationAccountAccess(shop, "123"), null);
  assert.equal(reservationAccountAccess(shop, "", true), null);
  assert.equal(reservationAccountAccess(shop, "*", true), null);
  globalThis.reservationApiFixture.token.sub = "";
  assert.equal((await post({ command: "detail", id: row.id })).status, 401);
});

test("shop POS defaults retain plan gate and support receipt access for another signed POS account", async () => {
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { "*": { locations: [locationId], contact: true } } });
  globalThis.reservationApiFixture.token.sub = "789";
  const receipt = await loader({ request: new Request(`https://app.invalid/api/reservations?receipt=${row.id}&locationId=${encodeURIComponent(locationId)}`) });
  assert.equal(receipt.status, 200);
  assert.ok(!(await receipt.text()).includes(row.contactPhone));
  dbReads = 0;
  globalThis.reservationApiFixture.planBlocked = true;
  assert.equal((await post({ command: "count" })).status, 403);
  assert.equal(dbReads, 0);
});

function publicInstall(scopes = ["read_customers", "read_orders"]) {
  process.env.APP_DISTRIBUTION = "public";
  delete process.env.RESERVATION_POS_ACCESS;
  globalThis.reservationApiFixture.graphql = async query => {
    parse(query);
    if (query.includes("ReservationPosSetup")) return Response.json({ data: { location: { id: locationId, name: "導入店", isActive: true }, shop: { ianaTimezone: "America/New_York" }, currentAppInstallation: { accessScopes: scopes.map(handle => ({ handle })) } } });
    if (query.includes("ReservationSelectedCustomer")) return Response.json({ data: { customer: { displayName: "お客様", phone: "09012345678" } } });
    throw new Error("unexpected public query");
  };
}
test("public installation uses its active POS location and customer without any shop environment entries", async () => {
  publicInstall();
  const result = await (await post({ command: "sessionDisplay", customerId: "gid://shopify/Customer/1" })).json();
  assert.equal(result.locationName, "導入店"); assert.equal(result.accessReady, true); assert.equal(result.customer.phone, "09012345678");
  assert.equal((await post({ command: "count" })).status, 200);
  const receipt = await loader({ request: new Request(`https://app.invalid/api/reservations?receipt=${row.id}&locationId=${encodeURIComponent(locationId)}`) });
  assert.equal(receipt.status, 200); assert.ok(!(await receipt.text()).includes(row.contactPhone));
});
test("public automatic access rejects absent, foreign, mismatched and inactive locations before DB reads", async () => {
  publicInstall();
  for (const location of [null, { id: locationId, isActive: false }, { id: "gid://shopify/Location/2", isActive: true }]) {
    globalThis.reservationApiFixture.graphql = async query => { parse(query); return Response.json({ data: { location } }); };
    assert.equal((await post({ command: "count" })).status, 403);
  }
  assert.equal(dbReads, 0);
});
test("public automatic access never overrides malformed or explicitly denied access settings", async () => {
  publicInstall();
  for (const value of ["invalid", "null", "[]", JSON.stringify({ [shop]: null }), JSON.stringify({ [shop]: { 123: null } }), JSON.stringify({ [shop]: { "*": null } }), JSON.stringify({ [shop]: { 123: { locations: [], contact: false } } })]) {
    process.env.RESERVATION_POS_ACCESS = value;
    assert.equal((await post({ command: "count" })).status, 403);
  }
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: false } } });
  const result = await (await post({ command: "detail", id: row.id })).json(); assert.equal(result.row.phone, "•••• 5678");
});
test("public missing scopes stop reserve and checkout before DB access but allow count and resume", async () => {
  publicInstall([]);
  for (const command of ["create", "checkout", "checkoutAccess", "orders", "complete"]) {
    const response = await post({ command, id: row.id }); assert.equal(response.status, 403);
    const body = await response.json(); assert.match(body.error, /取置 → 設定/);
    if (command === "checkout") assert.notEqual(body.checkoutRejected, true);
  }
  assert.equal(dbReads, 0);
  const display = await (await post({ command: "sessionDisplay", customerId: "gid://shopify/Customer/1" })).json();
  assert.equal(display.accessReady, false); assert.equal(display.customer, null); assert.match(display.notice, /取置 → 設定/);
  assert.equal((await post({ command: "count" })).status, 200);
  assert.equal((await post({ command: "resume", id: row.id })).status, 200);
  const cancel = await post({ command: "cancel", id: row.id, version: 999 }); assert.equal(cancel.status, 409); assert.match((await cancel.json()).error, /ほかの端末/);
});
test("public onboarding retains plan rejection and unknown distribution never enables automatic access", async () => {
  publicInstall(); globalThis.reservationApiFixture.planBlocked = true;
  assert.equal((await post({ command: "count" })).status, 403); assert.equal(dbReads, 0);
  globalThis.reservationApiFixture.planBlocked = false; delete process.env.APP_DISTRIBUTION;
  assert.equal((await post({ command: "count" })).status, 403);
});

test("public checkout claim survives lost response and scope revocation, then resumes with the same key", async () => {
  const { handoffReservationCart, CHECKOUT_PROPERTY, RESERVATION_PROPERTY } = await import("../extensions/common/reservations.js");
  const scopes = ["read_customers", "read_orders"]; publicInstall(scopes);
  const originalFind = globalThis.reservationApiFixture.db.stockReservation.findFirst;
  const originalUpdate = globalThis.reservationApiFixture.db.stockReservation.updateMany;
  let stored = structuredClone(row), writes = 0, loseResponse = true;
  const cart = { properties: {}, lineItems: [], editable: true };
  const pos = { session: { deviceId: 1 }, cart: { current: { value: cart }, async addCartProperties(props) { Object.assign(cart.properties, props); }, async removeCartProperties(keys) { keys.forEach(key => delete cart.properties[key]); }, async addLineItem(variantId, quantity) { cart.lineItems.push({ variantId, quantity }); return "line"; } } };
  globalThis.reservationApiFixture.db.stockReservation.findFirst = async () => structuredClone(stored);
  globalThis.reservationApiFixture.db.stockReservation.updateMany = async ({ where, data }) => { assert.equal(stored.version, where.version); writes++; stored = { ...stored, ...data, version: stored.version + 1 }; return { count: 1 }; };
  const api = async input => {
    const response = await post(input); const body = await response.json();
    if (!body.ok) throw Object.assign(new Error(body.error), { checkoutRejected: body.checkoutRejected });
    if (loseResponse) { loseResponse = false; throw new Error("response lost"); }
    return body;
  };
  try {
    const held = { ...row, checkoutKey: null };
    await assert.rejects(handoffReservationCart(held, pos, api), /response lost/);
    const key = cart.properties[CHECKOUT_PROPERTY]; assert.equal(key, stored.checkoutKey);
    scopes.length = 0;
    await assert.rejects(handoffReservationCart(held, pos, api), /取置 → 設定/);
    assert.equal(cart.properties[CHECKOUT_PROPERTY], key); assert.equal(cart.properties[RESERVATION_PROPERTY], row.id); assert.equal(cart.lineItems.length, 0);
    scopes.push("read_customers", "read_orders");
    await handoffReservationCart(held, pos, api);
    assert.equal(cart.properties[CHECKOUT_PROPERTY], key); assert.equal(writes, 1); assert.equal(cart.lineItems.length, 1); assert.equal(cart.lineItems[0].quantity, 2);
  } finally { globalThis.reservationApiFixture.db.stockReservation.findFirst = originalFind; globalThis.reservationApiFixture.db.stockReservation.updateMany = originalUpdate; }
});

test("public newly added active location needs no access or timezone environment entry", async () => {
  publicInstall();
  const added = "gid://shopify/Location/99";
  globalThis.reservationApiFixture.graphql = async (query, { variables }) => { parse(query); return Response.json({ data: { location: { id: variables.id, name: "追加店舗", isActive: true }, shop: { ianaTimezone: "Europe/Paris" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "read_customers" }] } } }); };
  const display = await (await post({ command: "sessionDisplay", locationId: added })).json(); assert.equal(display.accessReady, true); assert.equal(display.locationName, "追加店舗");
  const count = await (await post({ command: "count", locationId: added })).json(); assert.equal(count.count, 0);
});
