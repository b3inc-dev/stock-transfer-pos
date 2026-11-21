import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { matchPendingSale } from "../app/utils/match-pending-sale.ts";
import * as inventoryHistoryOrder from "../app/utils/inventory-history-order.ts";
import * as repairInventoryLogMetadata from "../app/utils/repairInventoryLogMetadata.js";

test("a sale preserves a previous adjustment ending at the sale's starting quantity", async () => {
  const timestamp = new Date("2026-01-15T12:00:00Z");
  const prior = {
    id: 1, shop: "sample", activity: "admin_webhook", delta: 1, quantityAfter: 10,
    inventoryItemId: "21", locationId: "31", timestamp: new Date(+timestamp - 12 * 60_000),
  };
  const history = [{ ...prior }];
  const order = { orderId: "test-order", quantity: 2, locationId: "31" };
  let pending = [order];

  const log = {
    async findFirst({ where }) {
      if (where.activity === undefined && where.quantityAfter === undefined && !where.OR) {
        return history.at(-1);
      }
      // This row falls inside the old 30-minute rescue window, but is a separate movement.
      if (where.activity === "admin_webhook" && where.quantityAfter === prior.quantityAfter &&
          where.timestamp.gte <= prior.timestamp && prior.timestamp <= where.timestamp.lte) {
        return history[0];
      }
      return null;
    },
    async findUnique({ where }) {
      return history.find((row) => row.idempotencyKey === where.shop_idempotencyKey.idempotencyKey) ?? null;
    },
    async findMany() { return []; },
    async create({ data }) { history.push({ id: history.length + 1, ...data }); },
    async update({ where, data }) {
      const row = history.find((candidate) => candidate.id === where.id);
      assert.ok(row);
      Object.assign(row, data);
    },
  };
  const db = {
    inventoryChangeLog: log,
    orderPendingLocation: {
      async findMany() { return pending; },
      async deleteMany() { pending = []; },
    },
  };
  const payload = { inventory_item_id: "21", location_id: "31", available: 8, updated_at: timestamp.toISOString() };
  const modules = {
    "../shopify.server": {
      authenticate: { webhook: async () => ({ shop: "sample", topic: "INVENTORY_LEVELS_UPDATE", payload }) },
    },
    "../db.server": db,
    "../utils/graphql-with-retry": {},
    "../utils/timezone": { getDateInShopTimezone: () => "2026-01-15" },
    "../utils/match-pending-sale": { matchPendingSale },
    "../utils/inventory-history-order": inventoryHistoryOrder,
    "../utils/repairInventoryLogMetadata.js": repairInventoryLogMetadata,
  };
  const source = readFileSync(new URL("../app/routes/webhooks.inventory_levels.update.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports, Response, Date, setTimeout,
    require(path) {
      assert.ok(Object.hasOwn(modules, path), "Unexpected dependency " + path);
      return modules[path];
    },
    console: { log() {}, warn() {}, error(...args) { throw new Error(args.join(" ")); } },
  });

  const request = new Request("https://example.test/webhook", { method: "POST" });
  for (let delivery = 0; delivery < 2; delivery++) {
    assert.equal((await exports.action({ request })).status, 200);
  }
  assert.deepEqual(history[0], prior);
  assert.deepEqual(history.map((row) => [row.activity, row.delta, row.quantityAfter]), [
    ["admin_webhook", 1, 10], ["order_sales", -2, 8],
  ]);
  assert.equal(history[1].sourceId, "order_test-order");
  assert.deepEqual(pending, []);
});
