/* global globalThis */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "vite";
let vite, list, editor, detail, view, fixture;
const shop = "fixture.myshopify.com", id = "12345678-1234-1234-1234-123456789abc";
const origin = "gid://shopify/Location/1", destination = "gid://shopify/Location/2";
const line = { variantId: "gid://shopify/ProductVariant/1", inventoryItemId: "gid://shopify/InventoryItem/1", title: "商品 / 青", sku: "SKU-1", barcode: "00001", quantity: 2 };
before(async () => {
  globalThis.outboundAdminFixture = fixture = {};
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false }, plugins: [{
    name: "outbound-admin-fixture", enforce: "pre",
    resolveId(source) {
      if (source === "../utils/outbound-request-products.server") return "\0request-product-add";
      if (source === "../db.server") return "\0request-admin-db";
      if (source === "../utils/outbound-request-admin.server") return "\0request-admin-auth";
      if (source === "../utils/outbound-requests.server") return "\0request-admin-service";
    },
    load(source) {
      if (source === "\0request-product-add") return "export const requestProductAdd=async(admin,command,form)=>{globalThis.outboundAdminFixture.calls.push({catalog:command});return {products:[],pageInfo:{hasNextPage:false,endCursor:null}}}";
      if (source === "\0request-admin-db") return "export default {outboundRequest:{count:args=>globalThis.outboundAdminFixture.db.outboundRequest.count(args),findMany:args=>globalThis.outboundAdminFixture.db.outboundRequest.findMany(args)},outboundRequestEvent:{findMany:args=>globalThis.outboundAdminFixture.db.outboundRequestEvent.findMany(args)}}";
      if (source === "\0request-admin-auth") return 'export const outboundAdmin = async () => {const f=globalThis.outboundAdminFixture;if(f.denied)throw new Response("Not found",{status:404});return {session:{shop:"fixture.myshopify.com"},admin:{},actor:"管理担当"}}';
      if (source === "\0request-admin-service") return [
        "const f=()=>globalThis.outboundAdminFixture;",
        'export const requestLocations=async()=>[{id:"gid://shopify/Location/1",name:"A"},{id:"gid://shopify/Location/2",name:"B"}];',
        'export const getRequest=async(shop,id)=>{f().calls.push({get:{shop,id}});if(shop!=="fixture.myshopify.com"||id!==f().row.id)throw new Error("Not found");return structuredClone(f().row)};',
        "export const saveRequest=async(shop,actor,admin,input)=>{f().calls.push({save:{shop,actor,input}});return {...f().row,...input}};",
        "export const requestProducts=async()=>[f().row.lines[0]];",
        "export const requestError=message=>new Error(message);",
        "export const requestTransferSummary=async()=>[];",
        "export const changeRequest=async(row,actor,action,changes)=>{f().calls.push({change:{row,actor,action,changes}});f().row={...row,...changes,version:row.version+1};return f().row};",
      ].join("\n");
    },
  }] });
  list = await vite.ssrLoadModule("/app/routes/app.outbound-requests.tsx");
  editor = await vite.ssrLoadModule("/app/routes/app.outbound-requests_.new.tsx");
  detail = await vite.ssrLoadModule("/app/routes/app.outbound-requests_.$id.tsx");
  view = await vite.ssrLoadModule("/app/utils/outbound-request-view.ts");
});
after(async () => { await vite?.close(); delete globalThis.outboundAdminFixture; });
beforeEach(() => {
  fixture.calls = []; fixture.count = 51; fixture.denied = false;
  fixture.row = { id, shop, number: "OR-1", originId: origin, originName: "A", destinationId: destination, destinationName: "B", lines: [line], actualLines: [], dueDate: "2026-12-01", note: "", status: "draft", version: 1, execution: null };
  fixture.db = {
    outboundRequest: {
      async count(args) { fixture.calls.push({ count: args }); return fixture.count; },
      async findMany(args) { fixture.calls.push({ find: args }); return [fixture.row]; },
    },
    outboundRequestEvent: { async findMany(args) { fixture.calls.push({ events: args }); return []; } },
  };
});
const load = query => list.loader({ request: new Request("https://test/app/outbound-requests" + query) });
function post(path, fields) { return new Request("https://test/app/outbound-requests" + path, { method: "POST", body: new URLSearchParams(fields) }); }
test("list filters, counts and pages use the authenticated shop and stable ordering", async () => {
  const params = new URLSearchParams({ origin, destination, status: "working", query: " SKU ", from: "2026-12-01", to: "2026-12-10", sort: "due", page: "1", shop: "other.myshopify.com" });
  params.append("origin", destination); params.append("status", "uncertain");
  const result = await load("?" + params);
  const query = fixture.calls.find(call => call.find).find;
  assert.equal(query.where.shop, shop); assert.equal(fixture.calls.find(call => call.count).count.where.shop, shop);
  assert.deepEqual(query.where.originId.in, [origin, destination]); assert.deepEqual(query.where.destinationId.in, [destination]);
  assert.deepEqual(query.where.status.in, ["working", "uncertain"]); assert.deepEqual(query.where.dueDate, { gte: "2026-12-01", lte: "2026-12-10" });
  assert.equal(query.where.OR[0].number.contains, "SKU"); assert.equal(query.skip, 25); assert.equal(query.take, 25);
  assert.deepEqual(query.orderBy, [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }]);
  assert.equal(result.filters.page, 1);
});
test("malformed filters cannot enter DB conditions and stale pages clamp to available rows", async () => {
  let result = await load("?origin=other&status=secret&from=2026-02-31&to=bad&page=Infinity&sort=wrong");
  let query = fixture.calls.find(call => call.find).find;
  assert.deepEqual(query.where, { shop }); assert.deepEqual(query.orderBy, [{ createdAt: "desc" }, { id: "desc" }]); assert.equal(result.filters.page, 0);
  fixture.calls = []; fixture.count = 0;
  result = await load("?page=999999"); query = fixture.calls.find(call => call.find).find;
  assert.equal(query.skip, 0); assert.equal(result.filters.page, 0);
});
test("list context round trips through details and edits without open redirects or embedded credentials", () => {
  const context = "/app/outbound-requests?origin=" + encodeURIComponent(origin) + "&status=working&query=SKU&page=2";
  const child = view.requestChildUrl("/app/outbound-requests/" + id, context);
  assert.equal(view.requestReturnTo(new URL(child, "https://test").searchParams.get("returnTo")), context);
  for (const value of ["https://evil.invalid/", "//evil.invalid/", "/app/outbound-requests/../settings", "/app/outbound-requests/new"]) assert.equal(view.requestReturnTo(value), "/app/outbound-requests");
  assert.equal(view.requestReturnTo("/app/outbound-requests?page=1&id_token=secret&shop=other"), "/app/outbound-requests?page=1");
});
test("saving a new request always creates a draft even if an old client submits publish", async () => {
  const result = await editor.action({ request: post("/new?returnTo=" + encodeURIComponent("/app/outbound-requests?page=2"), { id, version: "0", originId: origin, destinationId: destination, lines: JSON.stringify([line]), publish: "1" }) });
  const call = fixture.calls.find(call => call.save).save;
  assert.equal(call.shop, shop); assert.equal(call.input.publish, false);
  assert.match(result.headers.get("Location"), /saved=1/); assert.match(result.headers.get("Location"), /returnTo=/);
});
test("editing a published request preserves publication and submitting cannot roll it back to draft", async () => {
  fixture.row.status = "requested";
  await editor.action({ request: post("/new?id=" + id, { id, version: "1", originId: origin, destinationId: destination, lines: JSON.stringify([line]), publish: "0" }) });
  assert.equal(fixture.calls.find(call => call.save).save.input.publish, true);
});
test("publication needs confirmation and the latest version; protected states cannot publish or cancel", async () => {
  let result = await detail.action({ request: post("/" + id, { command: "publish", version: "1" }), params: { id } });
  assert.equal(result.data.ok, false); assert.equal(fixture.calls.filter(call => call.change).length, 0);
  result = await detail.action({ request: post("/" + id, { command: "publish", version: "0", confirmed: "yes" }), params: { id } });
  assert.equal(result.data.ok, false);
  result = await detail.action({ request: post("/" + id, { command: "publish", version: "1", confirmed: "yes" }), params: { id } });
  assert.equal(result.data.ok, true); assert.equal(fixture.row.status, "requested");
  for (const status of ["processing", "uncertain", "retryable", "completed"]) {
    fixture.row.status = status;
    result = await detail.action({ request: post("/" + id, { command: "cancel", version: String(fixture.row.version) }), params: { id } });
    assert.equal(result.data.ok, false);
  }
  assert.equal(fixture.calls.filter(call => call.change).length, 1);
});
test("all admin entry points retain feature/auth gates", async () => {
  fixture.denied = true;
  await assert.rejects(() => load(""), error => error.status === 404);
  await assert.rejects(() => editor.action({ request: post("/new", { id }) }), error => error.status === 404);
  await assert.rejects(() => detail.action({ request: post("/" + id, {}) , params: { id } }), error => error.status === 404);
  assert.equal(fixture.calls.length, 0);
});

test("catalog reads preserve unsaved creation fields and never save or publish", async () => {
  for (const command of ["search", "collections", "collectionProducts", "csv"]) {
    const formData = new FormData(); formData.set("command", command);
    assert.equal(editor.shouldRevalidate({ formData, defaultShouldRevalidate: true }), false);
    const result = await editor.action({ request: post("/new", { command, requestKey: "read-" + command, query: "SKU" }) });
    assert.equal(result.data.requestKey, "read-" + command);
  }
  assert.equal(fixture.calls.filter(call => call.catalog).length, 4);
  assert.equal(fixture.calls.filter(call => call.save || call.change).length, 0);
  assert.equal(editor.shouldRevalidate({ formData: new FormData(), defaultShouldRevalidate: true }), true);
});
