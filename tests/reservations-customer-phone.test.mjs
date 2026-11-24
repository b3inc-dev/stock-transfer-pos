/* global globalThis */
import assert from "node:assert/strict";
import { test, before, beforeEach, after } from "node:test";
import { createServer } from "vite";
import { parse } from "graphql";
import { normalizeCustomerPhone } from "../extensions/common/customerPhone.js";
let vite, service, row, phone, writes, events, mutation, readFailure;
const initial = () => ({ id: "R-phone-fixture", shop: "fixture.myshopify.com", locationId: "gid://shopify/Location/1", customerId: "gid://shopify/Customer/1", contactPhone: "090-1234-5678", customerPhoneSaveState: "pending", status: "held", anonymizedAt: null, version: 2 });
const matches = (row, where) => Object.entries(where).every(([key, value]) => value && typeof value === "object" ? value.in.includes(row[key]) : row[key] === value);
const admin = { async graphql(query, options) {
  parse(query);
  if (query.includes("CustomerPhoneScopes")) return Response.json({ data: { currentAppInstallation: { accessScopes: [{ handle: "write_customers" }] } } });
  if (query.includes("CustomerPhoneCheck")) { if (readFailure) throw new Error("private lookup failure"); return Response.json({ data: { customer: { id: row.customerId, phone } } }); }
  if (query.includes("CustomerPhoneSave")) { writes++; return mutation(options.variables.input); }
  throw new Error("unexpected query");
} };
before(async () => {
  const db = { stockReservation: { async findFirst({ where }) { return matches(row, where) ? structuredClone(row) : null; }, async updateMany({ where, data }) { if (!matches(row, where)) return { count: 0 }; Object.assign(row, data); return { count: 1 }; } }, stockReservationEvent: { async create({ data }) { events.push(data); } }, async $transaction(fn) { return fn(db); } };
  globalThis.phoneFixtureDb = db;
  vite = await createServer({ configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, plugins: [{ name: "phone-db", enforce: "pre", resolveId: id => id === "../db.server" ? "\0phone-db" : null, load: id => id === "\0phone-db" ? "export default globalThis.phoneFixtureDb" : null }] });
  service = await vite.ssrLoadModule("/app/utils/reservation-customer-phone.server.ts");
});
beforeEach(() => { row = initial(); phone = null; writes = 0; events = []; readFailure = false; mutation = async input => { assert.deepEqual(Object.keys(input).sort(), ["id", "phone"]); phone = input.phone; return Response.json({ data: { customerUpdate: { customer: { id: row.customerId, phone }, userErrors: [] } } }); }; });
after(async () => { await vite?.close(); delete globalThis.phoneFixtureDb; });
const save = () => service.saveReservationCustomerPhone(structuredClone(row), admin, "123");
test("customer phone canonicalization accepts domestic and fullwidth inputs without changing stored contact", () => {
  assert.equal(normalizeCustomerPhone("０９０－１２３４－５６７８"), "+819012345678");
  assert.equal(normalizeCustomerPhone("+81 90-1234-5678"), "+819012345678");
  for (const invalid of ["123", "abc", "+000000000", "090;DROP", ""]) assert.throws(() => normalizeCustomerPhone(invalid));
});
test("opted-in phone saves only id and phone and replay never mutates inventory or duplicates writes", async () => {
  assert.equal((await save()).customerPhoneSaveState, "saved");
  assert.equal((await save()).customerPhoneSaveState, "saved");
  assert.equal(writes, 1); assert.equal(row.version, 2); assert.equal(row.contactPhone, "090-1234-5678");
  assert.equal(events.length, 1); assert.equal(events[0].kind, "customer_phone_saved");
  assert.ok(!JSON.stringify(events).includes("1234-5678"));
});
test("already matching number is confirmed without a write; different existing number is preserved", async () => {
  phone = "09012345678"; assert.equal((await save()).customerPhoneSaveState, "saved"); assert.equal(writes, 0);
  row = initial(); phone = "+818011112222"; assert.equal((await save()).customerPhoneSaveState, "conflict"); assert.equal(writes, 0); assert.equal(phone, "+818011112222");
});
test("lost successful response is reconciled by reading, not by repeating the mutation", async () => {
  mutation = async input => { phone = input.phone; throw new Error("lost response with private data"); };
  assert.equal((await save()).customerPhoneSaveState, "saved"); assert.equal(writes, 1);
});
test("unknown outcome remains verification-only even when the current phone is empty", async () => {
  mutation = async () => { throw new Error("transport unknown"); };
  assert.equal((await save()).customerPhoneSaveState, "unknown");
  assert.equal((await save()).customerPhoneSaveState, "unknown"); assert.equal(writes, 1);
  phone = "+819012345678"; assert.equal((await save()).customerPhoneSaveState, "saved"); assert.equal(writes, 1);
});
test("concurrent requests and a crashed saving state cannot send another mutation", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  mutation = async input => { entered(); await new Promise(resolve => { release = resolve; }); phone = input.phone; return Response.json({ data: { customerUpdate: { customer: { id: row.customerId, phone }, userErrors: [] } } }); };
  const first = save(); await waiting; assert.equal((await save()).customerPhoneSaveState, "saving"); release(); await first; assert.equal(writes, 1);
  row = { ...initial(), customerPhoneSaveState: "saving" }; phone = null; assert.equal((await save()).customerPhoneSaveState, "saving"); assert.equal(writes, 1);
});
test("definite validation failure allows a checked retry and never exposes mutation body", async () => {
  mutation = async () => Response.json({ data: { customerUpdate: { customer: null, userErrors: [{ message: "private duplicate details" }] } } });
  assert.equal((await save()).customerPhoneSaveState, "failed"); assert.equal(writes, 1);
  phone = "+818011112222"; assert.equal((await save()).customerPhoneSaveState, "conflict"); assert.equal(writes, 1);
});
test("no intent, anonymized data, invalid status and read failure cannot write a phone", async () => {
  row.customerPhoneSaveState = null; await save(); assert.equal(writes, 0);
  row = { ...initial(), anonymizedAt: new Date() }; await assert.rejects(save); assert.equal(writes, 0);
  row = { ...initial(), status: "cancelled" }; await assert.rejects(save); assert.equal(writes, 0);
  row = initial(); readFailure = true; await assert.rejects(save); assert.equal(row.customerPhoneSaveState, "pending"); assert.equal(writes, 0);
});
