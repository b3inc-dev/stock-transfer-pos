/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPendingTileCounter, pendingTileSubheading, tileLocationId } from "../extensions/common/pendingTileCount.js";
import { fetchPendingInboundCount } from "../extensions/stock-transfer-inbound/src/inboundApi.js";
import { readPendingStocktakeCount } from "../extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js";
const location = "gid://shopify/Location/1";
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test("all tiles use the requested wording; zero/unknown are not presented as pending", () => {
  assert.equal(pendingTileSubheading(3, "登録・履歴"), "未対応 3件");
  for (const count of [0, null, undefined, -1, 1.5, "3"]) assert.equal(pendingTileSubheading(count, "登録・履歴"), "登録・履歴");
  assert.equal(tileLocationId(1), location); assert.equal(tileLocationId(location), location);
  for (const value of [null, "", "bad", "gid://shopify/InventoryItem/1"]) assert.equal(tileLocationId(value), null);
});
test("refresh coalesces same-store requests, ignores old-store responses and stops after unmount", async () => {
  let current = location, calls = 0;
  const first = deferred(), second = deferred(), values = [];
  const counter = createPendingTileCounter({ getLocation: () => current, load: () => ++calls === 1 ? first.promise : second.promise, onCount: (loc, count) => values.push([loc, count]) });
  const a = counter.refresh(); counter.refresh(); await Promise.resolve(); assert.equal(calls, 1);
  current = "gid://shopify/Location/2";
  const b = counter.checkLocation(); await Promise.resolve(); assert.equal(calls, 2);
  second.resolve(4); await b; first.resolve(9); await a;
  assert.deepEqual(values.at(-1), [current, 4]); assert.ok(!values.some(([, count]) => count === 9));
  const pending = counter.refresh(); counter.stop(); await pending;
  const length = values.length; await counter.refresh(); assert.equal(values.length, length);
});
test("errors clear stale counts without claiming zero, and missing location never fetches", async () => {
  let count = 2, calls = 0, current = location;
  const values = [], counter = createPendingTileCounter({ getLocation: () => current, load: async () => { calls++; if (count === null) throw new Error("offline"); return count; }, onCount: (_, value) => values.push(value) });
  await counter.refresh(); assert.equal(values.at(-1), 2);
  count = null; await counter.refresh(); assert.equal(values.at(-1), null);
  current = null; await counter.checkLocation(); assert.equal(calls, 2);
  counter.stop();
});

test("inbound counts transfer IDs across all pages, excludes other stores, completed/cancelled and empty shipments", async t => {
  const shipment = status => ({ id: status, status });
  const transfer = (id, status = "IN_PROGRESS", ships = [shipment("IN_TRANSIT")], destination = location, receivedQuantity = 0) => ({ id, status, totalQuantity: 3, receivedQuantity, destination: { location: { id: destination } }, shipments: { nodes: ships, pageInfo: { hasNextPage: false } } });
  const extra = transfer("shipment-page", "IN_PROGRESS", [shipment("RECEIVED")]); extra.shipments.pageInfo = { hasNextPage: true, endCursor: "shipment-cursor" };
  const queries = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { query, variables } = JSON.parse(options.body); queries.push({ query, variables }); assert.ok(!query.includes("mutation"));
    if (query.includes("PendingInboundTileShipments")) return Response.json({ data: { inventoryTransfer: { shipments: { nodes: [shipment("PARTIALLY_RECEIVED")], pageInfo: { hasNextPage: false } } } } });
    return Response.json({ data: { inventoryTransfers: variables.after
      ? { nodes: [transfer("first"), transfer("last", "READY_TO_SHIP", [shipment("DRAFT")]), extra], pageInfo: { hasNextPage: false } }
      : { nodes: [transfer("first"), transfer("complete", "TRANSFERRED"), transfer("cancelled", "CANCELED"), transfer("other", "IN_PROGRESS", [shipment("IN_TRANSIT")], "gid://shopify/Location/2"), transfer("received", "IN_PROGRESS", [shipment("RECEIVED")]), transfer("total-done", "IN_PROGRESS", [shipment("IN_TRANSIT")], location, 3), transfer("empty", "DRAFT", [])], pageInfo: { hasNextPage: true, endCursor: "transfer-cursor" } } } });
  });
  assert.equal(await fetchPendingInboundCount(location), 3);
  assert.equal(queries.length, 3);
  assert.ok(queries.some(row => row.variables.after === "transfer-cursor"));
  await assert.rejects(fetchPendingInboundCount(null));
});
test("inbound repeated cursors or failed pages never return a truncated total", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { inventoryTransfers: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "repeat" } } } }));
  await assert.rejects(fetchPendingInboundCount(location), /続きを/);
});

test("stocktake counts unique unfinished IDs for the store from all lightweight chunks without writes", async t => {
  const count = (id, status, locationId = location, extra = {}) => ({ id, status, locationId, productGroupIds: ["g1"], ...extra });
  const pages = [ [count("one", "draft"), count("done", "completed"), count("other", "draft", 2)], [count("two", "in_progress", 1), count("one", "draft"), count("cancel", "cancelled"), count("groups-cancel", "draft", 1, { cancelledGroupIds: ["g1"] }), count("deleted", "draft", 1, { productGroupIds: ["gone"] })] ];
  const keys = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { query, variables } = JSON.parse(options.body); assert.ok(!query.includes("mutation"));
    if (query.includes("PendingStocktakeTileChunk")) { keys.push(variables.key); return Response.json({ data: { currentAppInstallation: { metafield: { value: JSON.stringify(pages[Number(variables.key.slice(-1))]) } } } }); }
    return Response.json({ data: { currentAppInstallation: { list: { value: JSON.stringify({ _chunked: true, totalChunks: 2 }) }, groupIds: { value: '["g1"]' } } } });
  });
  assert.equal(await readPendingStocktakeCount(location), 2);
  assert.deepEqual(keys.sort(), ["inventory_counts_list_v1_c0", "inventory_counts_list_v1_c1"]);
});
test("missing stocktake chunks are errors rather than a partial count", async t => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { query } = JSON.parse(options.body);
    return Response.json({ data: { currentAppInstallation: query.includes("PendingStocktakeTileChunk") ? { metafield: null } : { list: { value: '{"_chunked":true,"totalChunks":1}' }, groupIds: { value: '["g1"]' } } } });
  });
  await assert.rejects(readPendingStocktakeCount(location), /一部を取得/);
});
test("legacy stocktake storage remains readable without applying any status repairs", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { query } = JSON.parse(options.body); calls.push(query); assert.ok(!query.includes("mutation"));
    return Response.json({ data: { currentAppInstallation: query.includes("PendingStocktakeTile") ? { list: null, groupIds: { value: '["g1"]' } } : { metafield: { value: JSON.stringify([{ id: "legacy", locationId: "1", status: "draft", productGroupIds: ["g1"] }]) } } } });
  });
  assert.equal(await readPendingStocktakeCount(location), 1); assert.equal(calls.length, 2);
});
