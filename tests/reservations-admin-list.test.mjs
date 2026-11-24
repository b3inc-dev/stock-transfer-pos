/* global globalThis */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "vite";
let vite, page, fixture;
const shop = "fixture.myshopify.com";
before(async () => {
  fixture = { calls: [], total: 26 };
  globalThis.reservationListFixture = fixture;
  fixture.db = { stockReservation: {
    async count(args) { fixture.calls.push({ count: args }); return fixture.total; },
    async findMany(args) { fixture.calls.push({ find: args }); return []; },
  } };
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "reservation-list-fixture", enforce: "pre",
    resolveId(id) { if (id === "../db.server") return "\0list-db"; if (id === "../shopify.server") return "\0list-auth"; },
    load(id) { if (id === "\0list-db") return "export default globalThis.reservationListFixture.db"; if (id === "\0list-auth") return 'export const authenticate = { admin: async () => ({ session: { shop: "fixture.myshopify.com" } }) }'; },
  }] });
  page = await vite.ssrLoadModule("/app/routes/app.reservations.tsx");
});
after(async () => { await vite?.close(); delete globalThis.reservationListFixture; delete process.env.RESERVATIONS_ENABLED; });
beforeEach(() => { fixture.calls = []; fixture.total = 26; process.env.RESERVATIONS_ENABLED = "1"; });
const load = async query => { const result = await page.loader({ request: new Request(`https://test/app/reservations${query}`) }); await result.data.rows; return result.data; };
test("history filters, counts and location choices stay within authenticated shop", async () => {
  const result = await load("?locations=gid%3A%2F%2Fshopify%2FLocation%2F1&statuses=held&sort=asc&page=1&shop=other.myshopify.com");
  for (const entry of fixture.calls) assert.equal((entry.count || entry.find).where.shop, shop);
  const rows = fixture.calls.find(entry => entry.find?.take).find;
  assert.deepEqual(rows.where.locationId, { in: ["gid://shopify/Location/1"] }); assert.deepEqual(rows.where.status, { in: ["held"] });
  assert.equal(rows.skip, 25); assert.equal(rows.take, 25); assert.deepEqual(rows.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.equal(result.page, 1); assert.equal(rows.select.guestName, undefined); assert.equal(rows.select.contactPhone, undefined);
});
test("invalid filter and pagination values do not become DB conditions", async () => {
  const result = await load("?locations=other&statuses=secret&sort=invalid&page=Infinity");
  const rows = fixture.calls.find(entry => entry.find?.take).find;
  assert.deepEqual(rows.where, { shop }); assert.equal(result.page, 0); assert.equal(result.sort, "desc");
});
test("empty result clamps stale pagination to first page", async () => {
  fixture.total = 0;
  const result = await load("?page=999999");
  assert.equal(result.page, 0); assert.equal(fixture.calls.find(entry => entry.find?.take).find.skip, 0);
});
test("disabled reservation history remains unavailable", async () => {
  process.env.RESERVATIONS_ENABLED = "0";
  await assert.rejects(() => load(""), error => error.status === 404); assert.equal(fixture.calls.length, 0);
});
