import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/routes/webhooks.orders.updated.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

async function deliver({ scope, cancel = false, error = false, location = null }) {
  const lookups = [], pending = [], warnings = [], failures = [];
  const payload = {
    id: 123, line_items: [{ variant_id: 42, quantity: 1 }],
    cancelled_at: cancel ? "2026-01-01T09:00:00Z" : null,
  };
  const admin = { async request({ data }) {
    if (data.includes("fulfillmentOrders")) {
      lookups.push(data);
      if (error) throw new Error("temporary transport failure");
      return { data: { order: { fulfillmentOrders: { edges: [{ node: { assignedLocation: { location } } }] } } } };
    }
    if (data.includes("GetVariant")) return { data: { productVariant: { inventoryItem: { id: "gid://shopify/InventoryItem/42" } } } };
    if (data.includes("GetShopTimezone")) return { data: { shop: { ianaTimezone: "Asia/Tokyo" } } };
    throw new Error("Unexpected GraphQL operation");
  } };
  const modules = {
    "../shopify.server": {
      clients: { Graphql: () => admin },
      authenticate: { webhook: async () => ({ payload, topic: "ORDERS_UPDATED", shop: "sample", session: { scope } }) },
    },
    "../db.server": {
      orderPendingLocation: { async upsert({ create }) { pending.push(create.locationId); } },
      inventoryChangeLog: { async findMany() { return []; }, async findFirst() { return null; } },
    },
    "../utils/graphql-with-retry": { withGraphQLRetry: client => client },
    "../utils/admin-webhook-retry": { findWithAdminWebhookRetry: async () => null },
    "../utils/inventory-change-log": {},
    "../utils/timezone": { getDateInShopTimezone: () => "2026-01-01" },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports, Response, require(key) { assert.ok(Object.hasOwn(modules, key)); return modules[key]; },
    console: { log() {}, info() {}, warn(...args) { warnings.push(args); }, error(...args) { failures.push(args); } },
  });
  const response = await exports.action({ request: new Request("https://example.test/webhook", { method: "POST" }) });
  assert.equal(response.status, 200);
  return { queries: lookups.length, pending, warnings: warnings.length, failures: failures.length };
}

test("unshipped orders stay pending without querying fulfillment orders outside granted scopes", async () => {
  assert.deepEqual(await deliver({ scope: "read_inventory,read_orders" }), { queries: 0, pending: [""], warnings: 0, failures: 0 });
});

test("unlocated cancellations do not query outside granted scopes or create a sale", async () => {
  assert.deepEqual(await deliver({ scope: "read_orders", cancel: true }), { queries: 0, pending: [], warnings: 0, failures: 0 });
});

test("compatible grants retain the lookup and include the assigned location in the pending sale", async () => {
  for (const scope of ["read_orders, read_merchant_managed_fulfillment_orders", "write_assigned_fulfillment_orders", "read_marketplace_fulfillment_orders", "read_buyer_membership_orders"]) {
    const result = await deliver({ scope, location: { id: "gid://shopify/Location/19" } });
    assert.deepEqual(result, { queries: 1, pending: ["19"], warnings: 0, failures: 0 });
  }
});

test("legacy sessions still try the lookup and actual failures remain observable", async () => {
  for (const scope of [undefined, "", "write_third_party_fulfillment_orders"]) {
    assert.deepEqual(await deliver({ scope, error: true }), { queries: 1, pending: [""], warnings: 0, failures: 1 });
  }
});
