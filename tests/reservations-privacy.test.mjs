import assert from "node:assert/strict";
import { test } from "node:test";
import { handleComplianceWebhook } from "../app/utils/compliance-webhook.ts";
function fixture() {
  const calls = [];
  const table = name => ({ async deleteMany(args) { calls.push({ name, command: "delete", args }); return { count: 1 }; } });
  const db = Object.fromEntries(["session", "inventoryChangeLog", "inventoryChangeEvent", "inventoryCountDocument", "orderPendingLocation", "refundPendingLocation", "stockReservationSettings"].map(name => [name, table(name)]));
  db.stockReservation = { ...table("stockReservation"), async updateMany(args) { calls.push({ name: "stockReservation", command: "update", args }); return { count: 1 }; } };
  db.stockReservationPrivacyRequest = { ...table("stockReservationPrivacyRequest"), async upsert(args) { calls.push({ name: "stockReservationPrivacyRequest", command: "upsert", args }); } };
  const handle = (topic, payload) => handleComplianceWebhook({ topic, shop: "fixture.myshopify.com", payload, db, getDistribution: () => "public", isShopStillInstalled: async () => false, log: () => {} });
  return { calls, handle };
}
test("data request durably records a shop-scoped request ID without copying contact values", async () => {
  const { calls, handle } = fixture(); await handle("CUSTOMERS_DATA_REQUEST", { customer: { id: 1 }, data_request: { id: 2 } });
  assert.deepEqual(calls[0].args.create, { id: "fixture.myshopify.com:2", shop: "fixture.myshopify.com", customerId: "gid://shopify/Customer/1" });
});
test("customer redact anonymizes contacts without changing inventory or reservation status", async () => {
  const { calls, handle } = fixture(); await handle("customers/redact", { customer: { id: 1 } });
  const update = calls.find(call => call.command === "update");
  assert.equal(update.args.where.shop, "fixture.myshopify.com"); assert.equal(update.args.data.contactPhone, null); assert.equal(update.args.data.customerId, null); assert.ok(!("status" in update.args.data)); assert.ok(!("lines" in update.args.data));
});
test("shop redact deletes reservations (events cascade), settings and request IDs", async () => {
  const { calls, handle } = fixture(); await handle("shop/redact", {});
  for (const name of ["stockReservation", "stockReservationSettings", "stockReservationPrivacyRequest"]) assert.ok(calls.some(call => call.name === name && call.command === "delete" && call.args.where.shop === "fixture.myshopify.com"));
});
test("mandatory privacy pages are independent of subscription plan and feature switch", async () => {
  const { featureForAdminPath } = await import("../extensions/common/planAccess.js");
  assert.equal(featureForAdminPath("/app/reservations/customer-data"), null);
  assert.equal(featureForAdminPath("/app/reservation-privacy"), null);
  assert.equal(featureForAdminPath("/app/reservations/privacy"), null);
  assert.equal(featureForAdminPath("/app/reservations"), "reservation");
});
