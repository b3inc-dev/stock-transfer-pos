/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "vite";

// Opt in only against a migrated test database. Never clear unrelated shops or use production data.
test("PostgreSQL request transactions fence competing terminals and preserve one shipment/log", { skip: !process.env.OUTBOUND_REQUEST_TEST_DATABASE_URL }, async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = process.env.OUTBOUND_REQUEST_TEST_DATABASE_URL;
  let options = { datasourceUrl: url };
  if (process.env.OUTBOUND_REQUEST_TEST_ADAPTER_MODULE) {
    const { PrismaPg } = createRequire(import.meta.url)(process.env.OUTBOUND_REQUEST_TEST_ADAPTER_MODULE);
    options = { adapter: new PrismaPg({ connectionString: url }) };
  }
  const db = new PrismaClient(options), id = randomUUID(), shop = `outbound-test-${id}.myshopify.com`, actor = "123";
  globalThis.outboundPostgresDb = db;
  const vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "postgres-request-db", enforce: "pre", resolveId(id) { if (id === "../db.server") return "\0postgres-request-db"; }, load(id) { if (id === "\0postgres-request-db") return "export default globalThis.outboundPostgresDb;"; } }] });
  let transferCount = 0, shipmentCount = 0, markCount = 0;
  const variant = { id: "gid://shopify/ProductVariant/1", displayName: "検証商品", sku: "TEST-1", barcode: "1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } };
  const admin = { async graphql(query, { variables = {} } = {}) {
    const ok = data => Response.json({ data });
    if (query.includes("OutboundRequestLocations")) return ok({ locations: { nodes: [{ id: "gid://shopify/Location/1", name: "A", isActive: true }, { id: "gid://shopify/Location/2", name: "B", isActive: true }], pageInfo: { hasNextPage: false } } });
    if (query.includes("OutboundRequestVariants")) return ok({ nodes: variables.ids.map(() => variant) });
    if (query.includes("RequestShippingSettings")) return ok({ currentAppInstallation: { metafield: null } });
    if (query.includes("RequestShopTimezone")) return ok({ shop: { ianaTimezone: "Asia/Tokyo" } });
    if (query.includes("CheckInventoryItems") || query.includes("VerifyInventoryLevels")) return ok({ nodes: variables.ids.map(id => ({ id, tracked: true, inventoryLevel: { id: "gid://shopify/InventoryLevel/1" } })) });
    if (query.includes("mutation CreateTransferReady")) { transferCount++; return ok({ inventoryTransferCreateAsReadyToShip: { inventoryTransfer: { id: "gid://shopify/InventoryTransfer/1", status: "READY_TO_SHIP" }, userErrors: [] } }); }
    if (query.includes("mutation ShipmentCreateDraft")) { shipmentCount++; return ok({ inventoryShipmentCreate: { inventoryShipment: { id: "gid://shopify/InventoryShipment/1", status: "DRAFT" }, userErrors: [] } }); }
    if (query.includes("mutation MarkShipmentInTransit")) { markCount++; return ok({ inventoryShipmentMarkInTransit: { inventoryShipment: { id: "gid://shopify/InventoryShipment/1", status: "IN_TRANSIT" }, userErrors: [] } }); }
    throw new Error(`Unexpected test query: ${query}`);
  } };
  try {
    const service = await vite.ssrLoadModule("/app/utils/outbound-requests.server.ts");
    const input = { id, originId: "gid://shopify/Location/1", destinationId: "gid://shopify/Location/2", lines: [{ variantId: variant.id, quantity: 2 }], dueDate: "", note: "test", publish: true };
    let row = await service.saveRequest(shop, actor, admin, input);
    assert.equal((await service.saveRequest(shop, actor, admin, input)).id, row.id, "retry must not duplicate registration");
    row = await service.changeRequest(row, actor, "作業を開始", { status: "working", owner: actor, claimKey: randomUUID() });
    const preview = await service.previewRequest(row, admin, row.lines, {});
    const results = await Promise.allSettled([service.beginRequest(row, actor, admin, row.lines, {}, preview.token), service.beginRequest(row, actor, admin, row.lines, {}, preview.token)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    row = await service.getRequest(shop, id);
    const attempts = await Promise.allSettled([service.advanceRequest(row, actor, admin), service.advanceRequest(row, actor, admin)]);
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    row = await service.getRequest(shop, id);
    for (let i = 0; i < 12 && row.status !== "completed"; i++) row = await service.advanceRequest(row, actor, admin);
    assert.equal(row.status, "completed");
    assert.deepEqual([transferCount, shipmentCount, markCount], [1, 1, 1]);
    const logs = await db.inventoryChangeLog.findMany({ where: { shop } });
    assert.equal(logs.length, 1); assert.equal(logs[0].delta, -2);
    assert.equal(await db.outboundRequest.count({ where: { shop } }), 1);
    await assert.rejects(service.advanceRequest(row, actor, admin));
  } finally {
    await vite.close();
    await db.outboundRequest.deleteMany({ where: { shop } });
    await db.outboundRequestSettings.deleteMany({ where: { shop } });
    await db.inventoryChangeLog.deleteMany({ where: { shop } });
    await db.$disconnect(); delete globalThis.outboundPostgresDb;
  }
});
