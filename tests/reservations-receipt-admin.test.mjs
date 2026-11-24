/* global globalThis */
import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { createServer } from "vite";
import { DEFAULT_RESERVATION_RECEIPT } from "../extensions/common/reservationReceipt.js";
let vite, route, fixture;
before(async () => {
  fixture = { calls: [], blocked: null, version: 0 };
  fixture.table = { async findUnique(args) { fixture.calls.push(args); return { receiptVersion: fixture.version, receiptLayout: null, days: 7 }; }, async upsert(args) { fixture.calls.push(args); return {}; }, async updateMany(args) { fixture.calls.push(args); if (args.where.receiptVersion !== fixture.version) return { count: 0 }; fixture.version++; return { count: 1 }; } };
  fixture.db = { stockReservationSettings: fixture.table, async $transaction(fn) { return fn(fixture.db); } }; globalThis.receiptEditorFixture = fixture;
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "receipt-editor-fixture", enforce: "pre", resolveId(id) { if (id === "../db.server") return "\0receipt-db"; if (id === "../shopify.server") return "\0receipt-auth"; if (id === "../utils/plan-gate.server") return "\0receipt-plan"; }, load(id) {
    if (id === "\0receipt-db") return "export default globalThis.receiptEditorFixture.db";
    if (id === "\0receipt-auth") return 'export const authenticate = {admin: async () => ({session:{shop:"fixture.myshopify.com"},admin:{}})}';
    if (id === "\0receipt-plan") return "export const adminPlanRedirect = async () => globalThis.receiptEditorFixture.blocked";
  } }] });
  route = await vite.ssrLoadModule("/app/routes/app.reservations_.receipt.tsx");
});
beforeEach(() => { fixture.calls = []; fixture.version = 0; fixture.blocked = null; process.env.RESERVATIONS_ENABLED = "1"; });
after(async () => { await vite?.close(); delete globalThis.receiptEditorFixture; delete process.env.RESERVATIONS_ENABLED; });
const save = (layout = DEFAULT_RESERVATION_RECEIPT, version = 0) => { const form = new FormData(); form.set("layout", JSON.stringify(layout)); form.set("version", String(version)); return route.action({ request: new Request("https://test/app/reservations/receipt", { method: "POST", body: form }) }); };
test("layout save is tenant scoped and leaves reservation days unchanged", async () => {
  const result = await save(); assert.equal(result.data.ok, true); assert.equal(result.data.version, 1);
  const update = fixture.calls.find(call => call.data).data; assert.equal(update.days, undefined); assert.equal(update.receiptLayout.storeCopy, true);
  for (const call of fixture.calls) assert.equal(call.where.shop, "fixture.myshopify.com");
  const second = await save({ ...DEFAULT_RESERVATION_RECEIPT, storeCopy: false }, 1); assert.equal(second.data.ok, true); assert.equal(second.data.version, 2);
});
test("stale editor cannot overwrite a newer design", async () => {
  fixture.version = 2; const result = await save(); assert.equal(result.init.status, 409); assert.equal(fixture.version, 2);
});
test("invalid copies and injected markup values are rejected before database writes", async () => {
  const result = await save({ ...DEFAULT_RESERVATION_RECEIPT, customerCopy: false, storeCopy: false }); assert.equal(result.init.status, 400); assert.equal(fixture.calls.length, 0);
});
test("disabled feature and blocked plans cannot change the receipt", async () => {
  process.env.RESERVATIONS_ENABLED = "0"; await assert.rejects(() => save(), error => error.status === 404);
  process.env.RESERVATIONS_ENABLED = "1"; fixture.blocked = new Response(null, { status: 302 }); assert.equal((await save()).status, 302); assert.equal(fixture.calls.length, 0);
});
