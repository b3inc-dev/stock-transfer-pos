/* global globalThis */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "vite";
import { readFileSync } from "node:fs";
let vite, page, helper, fixture;
const shop = "fixture.myshopify.com", locationId = "gid://shopify/Location/1", id = "R-12345678-1234-1234-1234-123456789abc";
const rowFixture = () => ({ id, status: "held", locationId, locationName: "店舗A", timezone: "Asia/Tokyo", customerId: null, guestName: "Guest", contactPhone: "09012345678", anonymizedAt: null,
  lines: [{ variantId: "gid://shopify/ProductVariant/1", title: "Tシャツ / 青 / M", quantity: 2 }], dueDate: "2026-12-01", nextFollowDate: null,
  createdAt: new Date("2026-11-24T16:00:00Z"), createdBy: "123 / POS担当 456", checkoutBy: null, endedAt: null, endedBy: null, orderId: null, lastError: null,
  checkoutKey: "SECRET-CHECKOUT-KEY", requestHash: "INTERNAL-HASH", operation: { input: "INTERNAL-MUTATION" },
  events: [{ id: "event1", kind: "held", actor: "123 / POS担当 456", followDate: null, createdAt: new Date("2026-11-24T16:00:00Z") }] });
before(async () => {
  fixture = { row: rowFixture(), calls: [], queries: [], sessionToken: { sub: "123" }, shop, blocked: null, customerError: false, orderError: false };
  fixture.admin = { async graphql(query, options) {
    fixture.queries.push({ query, variables: options.variables });
    assert.doesNotMatch(query, /\bmutation\b/);
    if (query.includes("ReservationAdminCustomer")) {
      if (fixture.customerError) throw new Error("RAW CUSTOMER VALUE 09099999999");
      return Response.json({ data: { customer: { displayName: "Member", phone: "08012345678" } } });
    }
    if (query.includes("ReservationAdminOrder")) {
      if (fixture.orderError) throw new Error("RAW ORDER ERROR");
      return Response.json({ data: { order: { name: "#1001" } } });
    }
    throw new Error("Unexpected query");
  } };
  fixture.db = { stockReservation: { async findFirst(args) {
    fixture.calls.push(args);
    if (args.where.shop !== shop || args.where.id !== id || !fixture.row) return null;
    const value = structuredClone(fixture.row);
    value.events = value.events.slice(args.select.events.skip, args.select.events.skip + args.select.events.take);
    return value;
  } } };
  globalThis.reservationAdminDetailFixture = fixture;
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "admin-detail-fixture", enforce: "pre", resolveId(id) {
    if (id === "../db.server") return "\0detail-db";
    if (id === "../shopify.server") return "\0detail-auth";
    if (id === "../utils/plan-gate.server") return "\0detail-plan";
  }, load(id) {
    if (id === "\0detail-db") return "export default globalThis.reservationAdminDetailFixture.db";
    if (id === "\0detail-auth") return "export const authenticate = {admin: async () => {const f=globalThis.reservationAdminDetailFixture;return {session:{shop:f.shop},sessionToken:f.sessionToken,admin:f.admin}}}";
    if (id === "\0detail-plan") return "export const adminPlanRedirect = async () => globalThis.reservationAdminDetailFixture.blocked";
  } }] });
  page = await vite.ssrLoadModule("/app/routes/app.reservations_.$id.tsx");
  helper = await vite.ssrLoadModule("/app/utils/reservation-admin-detail.server.ts");
});
after(async () => { delete globalThis.reservationAdminDetailFixture; delete process.env.RESERVATIONS_ENABLED; delete process.env.RESERVATION_POS_ACCESS; await vite?.close(); });
beforeEach(() => {
  Object.assign(fixture, { row: rowFixture(), calls: [], queries: [], sessionToken: { sub: "123" }, shop, blocked: null, customerError: false, orderError: false });
  process.env.RESERVATIONS_ENABLED = "1"; process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: false } } });
});
const load = (query = "", recordId = id) => page.loader({ request: new Request(`https://app.invalid/app/reservations/${recordId}${query}`), params: { id: recordId } });
const view = async (query = "") => { const result = await load(query); return { ...result.data, detail: await result.data.detail, headers: result.init?.headers }; };

test("read-only view shows products, dates, state and audit labels, excluding persisted mutation secrets", async () => {
  const result = await view(); const detail = result.detail;
  assert.equal(detail.lines[0].title, "Tシャツ / 青 / M"); assert.equal(detail.totalQuantity, 2);
  assert.equal(detail.createdAt, "2026/11/25 01:00"); assert.equal(detail.createdBy, "POS担当番号 456"); assert.equal(detail.statusLabel, "取置中");
  assert.equal(detail.events[0].label, "取置登録");
  const serialized = JSON.stringify(detail);
  for (const secret of ["SECRET-CHECKOUT-KEY", "INTERNAL-HASH", "INTERNAL-MUTATION", fixture.row.contactPhone]) assert.ok(!serialized.includes(secret));
  assert.equal(page.action, undefined); assert.equal(fixture.calls[0].where.shop, shop); assert.equal(fixture.calls[0].select.operation, undefined);
});
test("signed account and correct store permission are required for unmasked contact", async () => {
  assert.equal((await view()).detail.phone, "•••• 5678");
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: true } } });
  assert.equal((await view()).detail.phone, fixture.row.contactPhone);
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: ["gid://shopify/Location/2"], contact: true }, "": { locations: [locationId], contact: true } } });
  assert.equal((await view()).detail.phone, "•••• 5678");
  fixture.sessionToken = undefined;
  assert.equal((await view("?subject=123")).detail.phone, "•••• 5678");
});
test("disabled feature, missing reservation, another shop and denied plan never disclose data", async () => {
  delete process.env.RESERVATIONS_ENABLED; await assert.rejects(load(), error => error instanceof Response && error.status === 404); assert.equal(fixture.calls.length, 0);
  process.env.RESERVATIONS_ENABLED = "1";
  await assert.rejects(load("", "other"), error => error instanceof Response && error.status === 404);
  fixture.shop = "other.myshopify.com"; await assert.rejects(load(), error => error instanceof Response && error.status === 404);
  fixture.shop = shop; fixture.calls = []; fixture.blocked = new Response(null, { status: 302, headers: { Location: "/app/plan" } });
  assert.equal((await load()).status, 302); assert.equal(fixture.calls.length, 0);
});
test("member names and phones are fetched live and degrade without losing product/history data", async () => {
  fixture.row.customerId = "gid://shopify/Customer/8"; fixture.row.contactPhone = null; fixture.row.guestName = null;
  let detail = (await view()).detail; assert.equal(detail.name, "Member"); assert.equal(detail.phone, "•••• 5678");
  fixture.customerError = true; detail = (await view()).detail;
  assert.equal(detail.lines.length, 1); assert.equal(detail.events.length, 1); assert.ok(detail.notice.message.includes("顧客"));
  assert.ok(!JSON.stringify(detail).includes("RAW CUSTOMER VALUE"));
});
test("anonymized record never refetches customer data or returns stale stored contacts", async () => {
  fixture.row.customerId = "gid://shopify/Customer/8"; fixture.row.anonymizedAt = new Date();
  process.env.RESERVATION_POS_ACCESS = JSON.stringify({ [shop]: { 123: { locations: [locationId], contact: true } } });
  const detail = (await view()).detail;
  assert.equal(detail.name, "匿名化済み"); assert.equal(detail.phone, "削除済み"); assert.equal(fixture.queries.length, 0);
});
test("sold order link is tied to signed shop and valid stored order; cancelled records have no order action", async () => {
  fixture.row.status = "sold"; fixture.row.orderId = "gid://shopify/Order/123"; fixture.row.endedAt = new Date("2026-11-25T01:00:00Z"); fixture.row.endedBy = "123 / POS担当 456";
  let detail = (await view()).detail; assert.equal(detail.order.href, "https://admin.shopify.com/store/fixture/orders/123"); assert.equal(detail.order.label, "注文 #1001を見る"); assert.equal(detail.endedAt, "2026/11/25 10:00");
  fixture.orderError = true; detail = (await view()).detail; assert.ok(detail.order); assert.ok(detail.notice); assert.ok(!JSON.stringify(detail).includes("RAW ORDER ERROR"));
  fixture.row.orderId = "https://evil.invalid"; assert.equal((await view()).detail.order, null);
  fixture.row.orderId = "gid://shopify/Order/123"; fixture.row.status = "cancelled"; assert.equal((await view()).detail.order, null);
});
test("history pages keep list filters and include all later events rather than silently stopping at thirty", async () => {
  fixture.row.events = Array.from({ length: 61 }, (_, index) => ({ id: `event${index}`, kind: index % 2 ? "planned" : "unreachable", actor: "123 / POS担当 456", followDate: "2026-12-02", createdAt: new Date() }));
  const result = await view("?ended=1&page=2&historyPage=1");
  assert.equal(result.backTo, "/app/reservations?ended=1&page=2"); assert.equal(fixture.calls[0].select.events.skip, 25);
  assert.equal(result.detail.events.length, 25); assert.equal(result.detail.events[0].id, "event25"); assert.equal(result.detail.hasNextHistory, true);
  assert.equal((await view("?historyPage=2")).detail.events.length, 11);
});
test("malformed page values and product data fail safely without exposing raw keys", async () => {
  assert.deepEqual(helper.reservationListState(new URL("https://test/?page=Infinity&historyPage=-3&ended=1")), { page: 0, historyPage: 0, ended: true });
  fixture.row.lines.push({ title: "broken", quantity: "no" }); fixture.row.events[0].kind = "INTERNAL_UNKNOWN_EVENT";
  const detail = (await view()).detail; assert.equal(detail.totalQuantity, 2); assert.ok(detail.notice.message.includes("商品明細")); assert.equal(detail.events[0].label, "対応記録");
});
test("list links preserve page state and keep contact deletion separate from navigation", () => {
  const source = readFileSync("app/routes/app.reservations.tsx", "utf8");
  assert.match(source, /<GuardedLink to=\{`\/app\/reservations\//); assert.match(source, /ended=\$\{ended/); assert.match(source, /page=\$\{page\}/);
  assert.ok(source.indexOf("</GuardedLink>") < source.indexOf("<ConfirmAction label="));
});
