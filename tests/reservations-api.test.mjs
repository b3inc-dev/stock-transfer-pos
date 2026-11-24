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
    db: { stockReservation: {
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
    if (id === "\0api-shopify") return `export const authenticate = { pos: async () => ({sessionToken:globalThis.reservationApiFixture.token}) }; export const unauthenticated = { admin: async () => ({admin: {graphql: async () => {throw new Error('unexpected Shopify call')}}}) };`;
    if (id === "\0api-plan") return "export const planBlockedPosResponse = async () => null";
  } }] });
  ({ action, loader } = await vite.ssrLoadModule("/app/routes/api.reservations.tsx"));
});
after(async () => { delete globalThis.reservationApiFixture; delete process.env.RESERVATIONS_ENABLED; delete process.env.RESERVATION_POS_ACCESS; await vite?.close(); });
beforeEach(() => { dbReads = 0; process.env.RESERVATIONS_ENABLED = "1"; process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: false } } }); globalThis.reservationApiFixture.token = { dest: `https://${shop}`, sub: "123" }; });
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
