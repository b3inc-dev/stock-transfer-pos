import test from "node:test";
import assert from "node:assert/strict";

const gid = (n) => `gid://shopify/InventoryItem/${n}`;
const num = (id) => String(id).split("/").pop();

/** nodes(ids) を模した fetch。deleted は variant=null、failBatchContaining を含むバッチは GraphQL エラー */
function installFetchMock({ deleted = new Set(), failBatchContaining = null } = {}) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    const ids = variables?.ids ?? [];
    calls.push(ids);
    if (failBatchContaining && ids.some((id) => num(id) === failBatchContaining)) {
      return new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 });
    }
    const nodes = ids.map((id) =>
      deleted.has(num(id))
        ? { id, variant: null }
        : { id, variant: { id: `gid://shopify/ProductVariant/${num(id)}`, title: "v", sku: `SKU-${num(id)}`, barcode: "", product: { title: "p" } } }
    );
    return new Response(JSON.stringify({ data: { nodes } }), { status: 200 });
  };
  return calls;
}

const { fetchProductsByGroups } = await import("../extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeApi.js");
const groups = [{ id: "gid://shopify/Group/g1", name: "G1", collectionIds: [] }];
const baseOpts = { filterByInventoryLevel: false, cachedProductGroups: groups, timeoutMs: 5000 };

test("initial load reports unresolved ids and hasMore is id-based (no >=250 heuristic)", async () => {
  installFetchMock({ deleted: new Set(["3", "7"]) });
  const snapshot = Array.from({ length: 300 }, (_, i) => gid(i + 1));
  const r = await fetchProductsByGroups(["g1"], "loc", { ...baseOpts, inventoryItemIdsByGroup: { g1: snapshot }, limit: 2000, offset: 0 });
  assert.equal(r.products.length, 298);
  assert.equal(r.hasMore, false);
  assert.deepEqual(r.unavailableInventoryItemIds.map(num), ["3", "7"]);
  assert.deepEqual(r.failedInventoryItemIds, []);
});

test("load more with exclude fetches only not-yet-loaded ids and never re-adds loaded rows", async () => {
  installFetchMock({ deleted: new Set(["3"]) });
  const snapshot = Array.from({ length: 2100 }, (_, i) => gid(i + 1));
  const first = await fetchProductsByGroups(["g1"], "loc", { ...baseOpts, inventoryItemIdsByGroup: { g1: snapshot }, limit: 2000, offset: 0 });
  assert.equal(first.products.length, 1999);
  assert.equal(first.hasMore, true);

  const exclude = new Set([...first.products.map((p) => num(p.inventoryItemId)), ...first.unavailableInventoryItemIds.map(num)]);
  const more = await fetchProductsByGroups(["g1"], "loc", { ...baseOpts, inventoryItemIdsByGroup: { g1: snapshot }, limit: 600, excludeInventoryItemIds: exclude });
  assert.equal(more.products.length, 100);
  const overlap = more.products.filter((p) => exclude.has(num(p.inventoryItemId)));
  assert.equal(overlap.length, 0);
  assert.equal(more.hasMore, false);
});

test("load more: duplicate ids in snapshot are fetched once", async () => {
  const calls = installFetchMock();
  const snapshot = [gid(1), gid(2), gid(2), "3", gid(3), gid(4)];
  const r = await fetchProductsByGroups(["g1"], "loc", { ...baseOpts, inventoryItemIdsByGroup: { g1: snapshot }, limit: 600, excludeInventoryItemIds: ["1"] });
  assert.deepEqual(r.products.map((p) => num(p.inventoryItemId)), ["2", "3", "4"]);
  assert.deepEqual(calls.flat().map(num), ["2", "3", "4"]);
  assert.equal(r.hasMore, false);
});

test("batch failure is reported as failed ids (client marks consumed for the session)", async () => {
  installFetchMock({ failBatchContaining: "60" });
  const snapshot = Array.from({ length: 120 }, (_, i) => gid(i + 1));
  const r = await fetchProductsByGroups(["g1"], "loc", { ...baseOpts, inventoryItemIdsByGroup: { g1: snapshot }, limit: 600, excludeInventoryItemIds: [] });
  assert.equal(r.products.length, 70);
  assert.equal(r.failedInventoryItemIds.length, 50);
  assert.equal(r.hasMore, false);
});
