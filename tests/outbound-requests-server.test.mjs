/* global globalThis */
import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { createServer } from "vite";
import process from "node:process";
import { DEFAULT_OUTBOUND_REQUEST_POLICY } from "../extensions/common/outboundRequests.js";
let vite, service, fixture, route;
const enabledBefore = process.env.OUTBOUND_REQUESTS_ENABLED;
const clone = value => structuredClone(value);
const id = "12345678-1234-4234-8234-123456789abc", shop = "fixture.myshopify.com", actor = "123";
const line = (n, quantity) => ({ inventoryItemId: `gid://shopify/InventoryItem/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, title: `商品${n}`, sku: `SKU${n}`, barcode: String(n), quantity, reason: "" });
function matches(row, where) { return Object.entries(where).every(([key, value]) => row?.[key] === value); }
before(async () => {
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{ name: "outbound-db-fixture", enforce: "pre", resolveId(id) {
    if (id === "../shopify.server") return "\0outbound-auth";
    if (id === "../utils/plan-gate.server") return "\0outbound-plan";
    if (id === "../db.server") return "\0outbound-db";
    if (id === "./ensure-inventory-activated-server") return "\0outbound-activate";
  }, load(id) {
    if (id === "\0outbound-auth") return 'export const authenticate = {pos:async()=>{if(globalThis.outboundFixture.authBlocked)throw new Response("Unauthorized",{status:401});return {sessionToken:{dest:"https://fixture.myshopify.com",sub:"123"}};}};export const unauthenticated={admin:async()=>({admin:globalThis.outboundFixture.admin})};';
    if (id === "\0outbound-plan") return "export const planBlockedPosResponse = async () => globalThis.outboundFixture.blocked || null;";
    if (id === "\0outbound-db") return "export default new Proxy({}, { get: (_, key) => globalThis.outboundFixture.db[key] });";
    if (id === "\0outbound-activate") return "export const ensureInventoryActivatedAtLocation = async (_,location,lines) => {globalThis.outboundFixture.activations.push({location,lines});return {ok:true};};";
  } }] });
  service = await vite.ssrLoadModule("/app/utils/outbound-requests.server.ts");
  route = await vite.ssrLoadModule("/app/routes/api.outbound-requests.tsx");
});
after(async () => { await vite?.close(); delete globalThis.outboundFixture; if (enabledBefore === undefined) delete process.env.OUTBOUND_REQUESTS_ENABLED; else process.env.OUTBOUND_REQUESTS_ENABLED = enabledBefore; });
beforeEach(() => {
  process.env.OUTBOUND_REQUESTS_ENABLED = "1";
  fixture = { row: { id, shop, number: "OR-1", version: 1, status: "working", originId: "gid://shopify/Location/1", originName: "A", destinationId: "gid://shopify/Location/2", destinationName: "B", lines: [line(1, 2)], actualLines: [], note: "", dueDate: null, owner: actor, claimKey: "local-device", operationId: null, execution: null, createdAt: new Date(), updatedAt: new Date(), error: null }, policy: { version: 1, policy: { ...DEFAULT_OUTBOUND_REQUEST_POLICY } }, transfers: [], activations: [], events: [], logs: new Map(), counters: {}, failure: null };
  fixture.db = {
    outboundRequest: {
      async findFirst({ where }) { return matches(fixture.row, where) ? clone(fixture.row) : null; },
      async findUniqueOrThrow() { return clone(fixture.row); },
      async updateMany({ where, data }) { if (!matches(fixture.row, where)) return { count: 0 }; for (const [key, value] of Object.entries(data)) fixture.row[key] = key === "version" ? fixture.row.version + value.increment : clone(value); fixture.row.updatedAt = new Date(); return { count: 1 }; },
    },
    outboundRequestSettings: { async findUnique() { return clone(fixture.policy); } },
    outboundRequestEvent: { async create({ data }) { fixture.events.push(data); } },
    inventoryChangeLog: { async upsert({ create }) { fixture.logs.set(create.idempotencyKey, create); return create; } },
    async $transaction(value) { return typeof value === "function" ? value(fixture.db) : Promise.all(value); },
  };
  fixture.admin = admin;
  globalThis.outboundFixture = fixture;
});
const admin = { async graphql(query, { variables = {} } = {}) {
  const ok = data => Response.json({ data });
  if (query.includes("RequestPosLocation")) return ok({ location: { id: variables.id, isActive: true, name: "A" } });
  if (query.includes("OutboundRequestLocations")) return ok({ locations: { nodes: [{ id: fixture.row.originId, name: "A", isActive: true }, { id: fixture.row.destinationId, name: "B", isActive: true }], pageInfo: { hasNextPage: false } } });
  if (query.includes("OutboundRequestVariants")) return ok({ nodes: variables.ids.map(gid => { const n = gid.split("/").pop(); return { id: gid, displayName: `商品${n}`, sku: `SKU${n}`, barcode: n, inventoryItem: { id: `gid://shopify/InventoryItem/${n}` } }; }) });
  if (query.includes("RequestShippingSettings")) return ok({ currentAppInstallation: { metafield: { value: "{}" } } });
  if (query.includes("RequestShopTimezone")) return ok({ shop: { ianaTimezone: "Asia/Tokyo" } });
  if (query.includes("RequestRecoverTransfers")) return ok({ inventoryTransfers: { nodes: fixture.transfers.map(t => ({ ...t, origin: { location: { id: fixture.row.originId } }, destination: { location: { id: fixture.row.destinationId } } })), pageInfo: { hasNextPage: false } } });
  if (query.includes("RequestRecoverShipment")) return ok({ inventoryTransfer: { shipments: { nodes: fixture.transfers.find(t => t.id === variables.id)?.shipments || [] } } });
  let field, entity, value;
  if (query.includes("mutation CreateTransferReady")) {
    field = "inventoryTransferCreateAsReadyToShip"; entity = "inventoryTransfer";
    value = { id: `gid://shopify/InventoryTransfer/${fixture.transfers.length + 1}`, status: "READY_TO_SHIP", note: variables.input.note, shipments: [] };
    fixture.transfers.push(value);
  } else if (query.includes("mutation ShipmentCreateDraft")) {
    field = "inventoryShipmentCreate"; entity = "inventoryShipment";
    value = { id: `gid://shopify/InventoryShipment/${fixture.transfers.length}`, status: "DRAFT", tracking: null, lineItems: { nodes: variables.input.lineItems.map(line => ({ quantity: line.quantity, inventoryItem: { id: line.inventoryItemId } })) } };
    fixture.transfers.find(t => t.id === variables.input.movementId).shipments.push(value);
  } else if (query.includes("mutation MarkShipmentInTransit")) {
    field = "inventoryShipmentMarkInTransit"; entity = "inventoryShipment";
    value = fixture.transfers.flatMap(t => t.shipments).find(s => s.id === variables.id); value.status = "IN_TRANSIT";
  } else if (query.includes("mutation InvShpSetTrk")) {
    field = "inventoryShipmentSetTracking"; entity = "inventoryShipment";
    value = fixture.transfers.flatMap(t => t.shipments).find(s => s.id === variables.id); value.tracking = variables.tracking;
  } else throw new Error(`Unexpected query ${query}`);
  fixture.counters[field] = (fixture.counters[field] || 0) + 1;
  if (fixture.failure === field) { fixture.failure = null; throw new Error("connection lost after Shopify success"); }
  return ok({ [field]: { [entity]: value, userErrors: [] } });
} };
async function begin(actual = fixture.row.lines, tracking = {}) {
  const preview = await service.previewRequest(clone(fixture.row), admin, actual, tracking);
  return service.beginRequest(clone(fixture.row), actor, admin, actual, tracking, preview.token);
}
async function finish(row) {
  for (let i = 0; i < 100 && row.status !== "completed"; i++) {
    if (["uncertain", "retryable"].includes(row.status)) return row;
    row = await service.advanceRequest(row, actor, admin);
  }
  return row;
}
test("confirmation is invalidated by policy changes and request additions before any write", async () => {
  const preview = await service.previewRequest(clone(fixture.row), admin, fixture.row.lines, {});
  fixture.policy.version++;
  await assert.rejects(service.beginRequest(clone(fixture.row), actor, admin, fixture.row.lines, {}, preview.token), /もう一度確認/);
  fixture.policy.version--;
  fixture.row.version++; fixture.row.lines.push(line(2, 1));
  await assert.rejects(service.beginRequest(clone(fixture.row), actor, admin, fixture.row.lines, {}, preview.token), /もう一度確認/);
  assert.equal(fixture.transfers.length, 0);
});
test("two terminals cannot begin or advance the same version twice", async () => {
  const row = clone(fixture.row), preview = await service.previewRequest(row, admin, row.lines, {});
  const attempts = await Promise.allSettled([service.beginRequest(row, actor, admin, row.lines, {}, preview.token), service.beginRequest(row, actor, admin, row.lines, {}, preview.token)]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const next = clone(fixture.row);
  const advances = await Promise.allSettled([service.advanceRequest(next, actor, admin), service.advanceRequest(next, actor, admin)]);
  assert.equal(advances.filter(result => result.status === "fulfilled").length, 1);
});
test("normal completion uses transfers/shipments, zero activation stock and one outbound log", async () => {
  const row = await finish(await begin());
  assert.equal(row.status, "completed");
  assert.equal(fixture.counters.inventoryTransferCreateAsReadyToShip, 1);
  assert.equal(fixture.counters.inventoryShipmentCreate, 1);
  assert.equal(fixture.transfers[0].shipments[0].status, "IN_TRANSIT");
  assert.equal(fixture.logs.size, 1);
  assert.equal([...fixture.logs.values()][0].delta, -2);
  assert.ok(fixture.activations.every(call => call.lines.every(line => line.quantity === 0)), "activation must never invent the requested stock");
});
test("completed requests are visible to the existing inbound destination list without a new receiving flow", async t => {
  await finish(await begin());
  const { fetchPendingTransfersForDestination } = await import("../extensions/stock-transfer-inbound/src/inboundApi.js");
  let received = 0;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "shopify:admin/api/graphql.json");
    return Response.json({ data: { inventoryTransfers: { nodes: fixture.transfers.map(transfer => ({ ...transfer, totalQuantity: 2, receivedQuantity: received, origin: { location: { id: fixture.row.originId } }, destination: { location: { id: fixture.row.destinationId } }, shipments: { nodes: transfer.shipments } })) } } });
  });
  assert.equal((await fetchPendingTransfersForDestination(fixture.row.destinationId)).length, 1);
  assert.equal((await fetchPendingTransfersForDestination(fixture.row.originId)).length, 0);
  received = 2;
  assert.equal((await fetchPendingTransfersForDestination(fixture.row.destinationId)).length, 0);
  assert.equal(fixture.counters.inventoryShipmentMarkInTransit, 1);
});
for (const lost of ["inventoryTransferCreateAsReadyToShip", "inventoryShipmentCreate", "inventoryShipmentMarkInTransit"]) test(`lost ${lost} response reconciles without creating/sending again`, async () => {
  fixture.failure = lost;
  let row = await finish(await begin());
  assert.equal(row.status, "uncertain");
  await assert.rejects(service.advanceRequest(row, actor, admin), /確認/);
  row = await service.reconcileRequest(row, actor, admin);
  row = await finish(row);
  assert.equal(row.status, "completed");
  assert.equal(fixture.counters.inventoryTransferCreateAsReadyToShip, 1);
  assert.equal(fixture.counters.inventoryShipmentCreate, 1);
  assert.equal(fixture.counters.inventoryShipmentMarkInTransit, 1);
});
test("missing reconciliation result never authorizes another transfer creation", async () => {
  fixture.failure = "inventoryTransferCreateAsReadyToShip";
  const row = await finish(await begin()); fixture.transfers = [];
  await assert.rejects(service.reconcileRequest(row, actor, admin), /特定できません/);
  assert.equal(fixture.counters.inventoryTransferCreateAsReadyToShip, 1);
});
test("251 actual lines produce two transfers and two shipments", async () => {
  fixture.row.lines = Array.from({ length: 251 }, (_, i) => line(i + 1, 1));
  const row = await finish(await begin());
  assert.equal(row.status, "completed"); assert.equal(fixture.transfers.length, 2);
  assert.deepEqual(fixture.transfers.map(t => t.shipments[0].lineItems.nodes.length), [250, 1]);
  assert.equal(fixture.logs.size, 251);
});
test("working requests allow product/quantity additions and invalidate previous confirmations", async () => {
  const old = clone(fixture.row), preview = await service.previewRequest(old, admin, old.lines, {});
  const updated = await service.saveRequest(shop, actor, admin, { id, version: old.version, originId: old.originId, destinationId: old.destinationId, dueDate: "", note: "追加", publish: true, lines: [line(1, 3), line(2, 1)] });
  assert.equal(updated.status, "working"); assert.equal(updated.lines.length, 2); assert.equal(updated.claimKey, old.claimKey);
  await assert.rejects(service.beginRequest(old, actor, admin, old.lines, {}, preview.token), /更新されました/);
  await assert.rejects(service.saveRequest(shop, actor, admin, { id, version: updated.version, originId: old.originId, destinationId: old.destinationId, dueDate: "", note: "", publish: true, lines: [line(1, 2)] }), /追加だけ/);
  for (const status of ["processing", "completed", "uncertain", "retryable", "cancelled"]) {
    fixture.row.status = status;
    await assert.rejects(service.saveRequest(shop, actor, admin, { id, version: fixture.row.version, originId: old.originId, destinationId: old.destinationId, dueDate: "", note: "", publish: true, lines: [line(1, 3), line(2, 1)] }), /変更できません/);
  }
  assert.equal(fixture.transfers.length, 0);
});

function api(command, extra = {}) {
  return route.action({ request: new Request("https://fixture.example/api/outbound-requests", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" }, body: JSON.stringify({ command, id, version: fixture.row.version, locationId: fixture.row.originId, ...extra }) }) });
}
test("POS endpoints require enabled feature, authentication and the plan gate", async () => {
  delete process.env.OUTBOUND_REQUESTS_ENABLED;
  assert.equal((await api("detail")).status, 404);
  process.env.OUTBOUND_REQUESTS_ENABLED = "1";
  fixture.authBlocked = true; assert.equal((await api("detail")).status, 401);
  fixture.authBlocked = false; fixture.blocked = new Response("plan required", { status: 402 });
  assert.equal((await api("detail")).status, 402);
  assert.equal(fixture.events.length, 0);
});
test("another origin cannot read or print a request; device keys are never disclosed", async () => {
  assert.equal((await api("detail", { locationId: "gid://shopify/Location/2" })).status, 404);
  const response = await route.loader({ request: new Request(`https://fixture.example/api/outbound-requests?receipt=${id}&locationId=gid://shopify/Location/2`) });
  assert.equal(response.status, 404);
  const unclaimed = await (await api("detail")).json();
  assert.equal(unclaimed.row.claimed, false); assert.equal(unclaimed.row.claimKey, undefined);
  const claimed = await (await api("detail", { claimKey: "local-device" })).json();
  assert.equal(claimed.row.claimed, true); assert.equal(claimed.row.claimKey, undefined);
});
test("a different terminal cannot save/confirm; stale versions cannot ship", async () => {
  assert.equal((await api("begin", { claimKey: "wrong", actual: fixture.row.lines, token: "forged" })).status, 409);
  assert.equal((await api("save", { claimKey: "wrong", actual: fixture.row.lines })).status, 409);
  assert.equal((await api("begin", { claimKey: "local-device", version: 0, actual: fixture.row.lines })).status, 409);
  assert.equal(fixture.transfers.length, 0);
});
test("saving inspection verifies canonical identities and does not permit extra/over quantities", async () => {
  assert.equal((await api("save", { claimKey: "local-device", actual: [line(1, 3)] })).status, 400);
  assert.equal((await api("save", { claimKey: "local-device", actual: [line(1, 2), line(2, 1)] })).status, 400);
  const response = await api("save", { claimKey: "local-device", actual: [{ ...line(1, 1), title: "forged", inventoryItemId: "gid://shopify/InventoryItem/999" }] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.row.actualLines[0].inventoryItemId, line(1, 1).inventoryItemId);
  assert.equal(body.row.actualLines[0].title, "商品1");
});
test("plan denial stops new shipment writes but never drops a confirmed shipment's log", async () => {
  let row = await begin();
  fixture.blocked = new Response("plan required", { status: 402 });
  assert.equal((await api("advance")).status, 402);
  assert.equal(fixture.transfers.length, 0);
  fixture.blocked = null;
  for (let i = 0; i < 8 && row.execution.stage !== "log"; i++) row = await service.advanceRequest(row, actor, admin);
  assert.equal(row.execution.stage, "log");
  fixture.blocked = new Response("plan required", { status: 402 });
  const response = await api("advance");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).row.status, "completed");
  assert.equal(fixture.logs.size, 1);
});
