/* global globalThis */
import process from "node:process";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "vite";
import { parse } from "graphql";
import { Prisma } from "@prisma/client";
let vite, service, db;
let rows, events, stock, responses, calls, failTransport, failDb;
const shop = "fixture.myshopify.com", locationId = "gid://shopify/Location/1", actor = "123";
const variantId = "gid://shopify/ProductVariant/1";
const input = () => ({ id: "R-12345678-1234-1234-1234-123456789abc", timezone: "Asia/Tokyo", name: "Guest", phone: "09012345678", lines: [{ variantId, quantity: 2 }] });
const clone = value => structuredClone(value);
const matches = (row, where) => Object.entries(where).every(([key, value]) => typeof value === "object" && value !== null ? (value.in ? value.in.includes(row[key]) : !value.notIn.includes(row[key])) : row[key] === value);
function makeDb() {
  const reservation = {
    async findUnique({ where }) { return clone(rows.get(where.id) || null); },
    async findFirst({ where }) { return clone([...rows.values()].find(row => matches(row, where)) || null); },
    async findMany({ where }) { return clone([...rows.values()].filter(row => matches(row, where))); },
    async create({ data }) {
      if (rows.has(data.id)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
      const row = { ...clone(data), version: 1, createdAt: new Date(), updatedAt: new Date(), events: [], nextFollowDate: null, checkoutKey: null };
      rows.set(row.id, row); return clone(row);
    },
    async updateMany({ where, data }) {
      const row = [...rows.values()].find(row => matches(row, where));
      if (!row) return { count: 0 };
      const next = clone(data);
      if (next.version?.increment) next.version = row.version + next.version.increment;
      if (data.operation === Prisma.DbNull) next.operation = null;
      Object.assign(row, next); return { count: 1 };
    },
  };
  return { stockReservation: reservation, stockReservationSettings: { async findUnique() { return { days: 7 }; } }, stockReservationEvent: { async create({ data }) { events.push(data); } },
    async $transaction(fn) { if (failDb) { failDb = false; throw new Error("database unavailable"); } return fn(db); } };
}
const admin = {
  async graphql(query, { variables }) {
    parse(query);
    if (query.includes("ReservationLocation")) return Response.json({ data: { location: { id: locationId, name: "店", isActive: true } } });
    if (query.includes("ReservationVariants")) return Response.json({ data: { nodes: variables.ids.map(id => ({ id, displayName: "Tシャツ", inventoryItem: { id: `gid://shopify/InventoryItem/${id.split("/").pop()}`, tracked: true, inventoryLevel: { quantities: Object.entries(stock).map(([name, quantity]) => ({ name, quantity })) } } })) } });
    if (query.includes("ReservationMove")) {
      calls.push(clone(variables));
      if (responses.has(variables.key)) return Response.json(responses.get(variables.key));
      let errors = [];
      for (const change of variables.input.changes) {
        if (stock[change.from.name] !== change.from.changeFromQuantity || stock[change.to.name] !== change.to.changeFromQuantity) errors = [{ message: "CAS", code: "CHANGE_FROM_QUANTITY_STALE" }];
      }
      if (!errors.length) for (const change of variables.input.changes) { stock[change.from.name] -= change.quantity; stock[change.to.name] += change.quantity; }
      const response = { data: { inventoryMoveQuantities: { userErrors: errors, inventoryAdjustmentGroup: errors.length ? null : { id: "adjustment" } } } };
      responses.set(variables.key, response);
      if (failTransport) { failTransport = false; throw new Error("response lost after Shopify commit"); }
      return Response.json(response);
    }
    throw new Error("Unexpected query " + query);
  },
};
before(async () => {
  db = makeDb(); globalThis.reservationTestDb = db;
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "reservation-db", enforce: "pre", resolveId: id => id === "../db.server" ? "\0reservation-db" : null, load: id => id === "\0reservation-db" ? "export default globalThis.reservationTestDb" : null }] });
  service = await vite.ssrLoadModule("/app/utils/reservations.server.ts");
});
after(async () => { delete globalThis.reservationTestDb; delete process.env.RESERVATION_LOCATION_TIMEZONES; await vite?.close(); });
beforeEach(() => { process.env.RESERVATION_LOCATION_TIMEZONES = JSON.stringify({ [shop]: { [locationId]: "Asia/Tokyo" } }); rows = new Map(); events = []; stock = { available: 5, reserved: 0 }; responses = new Map(); calls = []; failTransport = false; failDb = false; });
const create = (body = input()) => service.createReservation({ shop, locationId, actor, admin, input: body });

test("timeout after Shopify success replays exact persisted input and key; no duplicate reserve", async () => {
  failTransport = true;
  const pending = await create();
  assert.equal(pending.status, "reserving"); assert.deepEqual(stock, { available: 3, reserved: 2 });
  const held = await create();
  assert.equal(held.status, "held"); assert.deepEqual(stock, { available: 3, reserved: 2 });
  assert.deepEqual(calls[0], calls[1]); assert.equal(events.length, 1);
  assert.equal((await create()).status, "held"); assert.equal(calls.length, 2);
});
test("DB failure after API success can recover with same key", async () => {
  failDb = true;
  await assert.rejects(create(), /database/);
  const held = await create();
  assert.equal(held.status, "held"); assert.deepEqual(stock, { available: 3, reserved: 2 }); assert.deepEqual(calls[0], calls[1]);
});
test("changed customer payload on same registration number is rejected", async () => {
  await create();
  await assert.rejects(create({ ...input(), phone: "09099999999" }), /登録内容/);
  assert.equal(calls.length, 1);
});
test("two devices registering same draft only reserve once", async () => {
  const results = await Promise.all([create(), create()]);
  assert.ok(results.every(row => row.status === "held"));
  assert.deepEqual(stock, { available: 3, reserved: 2 }); assert.equal(events.length, 1);
});
test("last item conflict stops one operation using Shopify CAS", async () => {
  stock.available = 2;
  const result = await Promise.all([create(), create({ ...input(), id: "R-87654321-1234-1234-1234-123456789abc" })]);
  assert.deepEqual(result.map(row => row.status).sort(), ["failed", "held"]);
  assert.deepEqual(stock, { available: 0, reserved: 2 });
});
test("cancel twice and checkout racing cancel cannot return stock twice", async () => {
  const held = await create();
  const cancelled = await service.reservationCommand(held, admin, actor, { command: "cancel", version: held.version });
  assert.equal(cancelled.status, "cancelled"); assert.deepEqual(stock, { available: 5, reserved: 0 });
  await assert.rejects(service.reservationCommand(cancelled, admin, actor, { command: "cancel", version: cancelled.version }));
  await assert.rejects(service.reservationCommand(held, admin, actor, { command: "checkout", version: held.version, deviceId: "1" }));
});
test("23 hour unknown result never reissues an expired idempotency key", async () => {
  failTransport = true; const row = await create();
  row.operation.startedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await assert.rejects(service.resumeReservationMove(row, admin), /23時間/);
  assert.equal(calls.length, 1);
});
test("sale and cancellation stock arithmetic maintains hand count", async () => {
  const held = await create();
  assert.deepEqual(stock, { available: 3, reserved: 2 });
  stock.available -= 2; // Shopify's ordinary POS order decrement, without releasing reservation first.
  const next = rows.get(held.id);
  next.status = "completing";
  next.operation = { key: "paid-operation", startedAt: new Date().toISOString(), actor, success: "sold", rejected: "checkout", input: { changes: [{ inventoryItemId: "1", quantity: 2, from: { name: "reserved", changeFromQuantity: 2 }, to: { name: "available", changeFromQuantity: 1 } }] } };
  const sold = await service.resumeReservationMove(clone(next), admin);
  assert.equal(sold.status, "sold"); assert.deepEqual(stock, { available: 3, reserved: 0 });
});
test("checkout claim is idempotent with the premarked cart key and preserves operator", async () => {
  const held = await create();
  const checkoutKey = "abcdefab-1234-1234-1234-123456789abc";
  const checkout = await service.reservationCommand(held, admin, "123 / POS担当 456", { command: "checkout", version: held.version, checkoutKey, deviceId: "1" });
  assert.equal(checkout.checkoutKey, checkoutKey); assert.equal(checkout.checkoutBy, "123 / POS担当 456");
  // The real API re-reads the row, but the client resends its pre-claim held/version snapshot.
  const replay = await service.reservationCommand(checkout, admin, actor, { command: "checkout", version: held.version, checkoutKey, deviceId: "1" });
  assert.equal(replay.checkoutKey, checkoutKey); assert.equal(replay.status, "checkout");
  assert.equal((await service.reservationCommand(checkout, admin, actor, { command: "checkout", version: checkout.version, checkoutKey, deviceId: "1" })).checkoutKey, checkoutKey);
  await assert.rejects(service.reservationCommand(checkout, admin, actor, { command: "checkout", version: checkout.version, checkoutKey: "aaaaaaab-1234-1234-1234-123456789abc", deviceId: "2" }), error => error.checkoutRejected === true);
});

test("POS due-date filter runs before pagination and today uses configured store timezone", async () => {
  const today = "2026-12-01";
  for (let i = 0; i < 30; i++) rows.set(`row-${i}`, { id: `row-${i}`, shop, locationId, status: "held", timezone: "Pacific/Honolulu", guestName: "Guest", contactPhone: "09012345678", customerId: null, dueDate: i < 26 ? today : "2026-12-02", lines: [], createdAt: new Date(), nextFollowDate: null });
  process.env.RESERVATION_LOCATION_TIMEZONES = JSON.stringify({ [shop]: { [locationId]: "Pacific/Honolulu" } });
  const result = await service.listReservations(shop, locationId, admin, "active", "", 1, today);
  assert.equal(result.total, 26); assert.equal(result.rows.length, 1); assert.equal(result.hasNextPage, false); assert.equal(result.allTotal, 30);
  const { localDate } = await import("../extensions/common/reservations.js");
  assert.equal(result.today, localDate(Date.now(), "Pacific/Honolulu"));
  await assert.rejects(() => service.listReservations(shop, locationId, admin, "active", "", 0, "2026-02-31"), /日付/);
});

test("history clamps a stale second page after another device reduces results", async () => {
  for (let i = 0; i < 26; i++) rows.set(`row-${i}`, { id: `row-${i}`, shop, locationId, status: "held", timezone: "Asia/Tokyo", guestName: "Guest", contactPhone: "09012345678", customerId: null, dueDate: "2026-12-01", lines: [], createdAt: new Date(), nextFollowDate: null });
  assert.equal((await service.listReservations(shop, locationId, admin, "active", "", 1)).page, 1);
  rows.delete("row-0");
  const result = await service.listReservations(shop, locationId, admin, "active", "", 1);
  assert.equal(result.page, 0); assert.equal(result.total, 25); assert.equal(result.rows.length, 25); assert.equal(result.hasNextPage, false);
});

test("GraphQL marker is removed before parsing single-line and multiline operations", async () => {
  for (const query of ["#graphql query { shop { name } }", "#graphql\nquery { shop { name } }"]) {
    const result = await service.reservationQuery({ graphql: async document => { parse(document); return Response.json({ data: { shop: { name: "店" } } }); } }, query);
    assert.equal(result.shop.name, "店");
  }
});
test("history is oldest registration first regardless of due date and follow-up", async () => {
  for (const [id, createdAt, dueDate] of [["new", "2026-11-24", "2020-01-01"], ["old", "2026-11-20", "2030-01-01"]]) rows.set(id, { id, shop, locationId, status: "held", timezone: "Asia/Tokyo", guestName: "Guest", customerId: null, dueDate, createdAt: new Date(createdAt), lines: [], nextFollowDate: null });
  const result = await service.listReservations(shop, locationId, admin, "active", "", 0);
  assert.deepEqual(result.rows.map(row => row.id), ["old", "new"]);
});
