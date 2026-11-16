import assert from "node:assert/strict";
import { test } from "node:test";
import { historyInventoryFilterIds, historyProductBatches, historyProductKey, historyProductKeys, indexHistoryProducts, recoveredHistorySku } from "../app/utils/change-history-product.ts";

const itemId = "gid://shopify/InventoryItem/17";
const variantId = "gid://shopify/ProductVariant/31";
const item = (nodes, hasNextPage = false) => ({ id: itemId, variants: { nodes, pageInfo: { hasNextPage } } });
const variant = { id: variantId, sku: "CURRENT", product: { title: "Sample" }, selectedOptions: [{ value: "Blue" }] };

test("a missing variant uses the same inventory item in either stored ID format", () => {
  const products = new Map();
  indexHistoryProducts(products, [item([variant])]);
  for (const inventoryItemId of ["17", itemId]) {
    const row = Object.freeze({ inventoryItemId, sku: "", variantId: null });
    const product = products.get(historyProductKey(row));
    assert.equal(recoveredHistorySku(row, product), "CURRENT");
    assert.equal(product.productTitle, "Sample");
    assert.equal(product.option1, "Blue");
    assert.equal(row.sku, "");
  }
});

test("preserve saved SKU and intentionally blank SKU on resolved variants", () => {
  const products = new Map();
  indexHistoryProducts(products, [variant, item([variant])]);
  assert.equal(historyProductKey({ variantId, inventoryItemId: itemId }), variantId);
  assert.equal(products.get(variantId).productTitle, "Sample");
  assert.equal(recoveredHistorySku({ variantId, sku: "" }, products.get(variantId)), "");
  assert.equal(recoveredHistorySku({ sku: "AT-EVENT" }, products.get(itemId)), "");
});

test("invalid item references, deleted variants, failed lookups do not populate unrelated rows", () => {
  const products = new Map();
  indexHistoryProducts(products, [null, item([]), item([{ id: "gid://shopify/Location/31" }])]);
  assert.equal(products.size, 0);
  for (const inventoryItemId of [undefined, "", variantId, "item17"]) {
    assert.equal(historyProductKey({ inventoryItemId }), "");
    assert.equal(recoveredHistorySku({}, products.get(itemId)), "");
  }
});

test("deduplicate mixed IDs and keep known variants inside the existing lookup cap", () => {
  assert.deepEqual(historyProductKeys([{ inventoryItemId: "17" }, { variantId }, { inventoryItemId: itemId }]), [variantId, itemId]);
});

test("skip ambiguous or incomplete variant connections", () => {
  const products = new Map();
  indexHistoryProducts(products, [item([variant, { ...variant, id: variantId + "2" }]), item([variant], true)]);
  assert.equal(products.size, 0);
});

test("batch item connections separately with bounded query sizes and request count", () => {
  const inventoryRows = Array.from({length: 80}, (_, i) => ({ inventoryItemId: String(i + 1) }));
  const batches = historyProductBatches([...inventoryRows, { variantId }], 3);
  assert.deepEqual(batches.map(batch => batch.ids.length), [1, 25, 25]);
  assert.deepEqual(batches[0].ids, [variantId]);
  assert.doesNotMatch(batches[0].query, /variants\(first/);
  assert.match(batches[1].query, /variants\(first: 2\)/);
});

test("the same inventory selection matches numeric and GID rows without numeric coercion", () => {
  assert.deepEqual(historyInventoryFilterIds([itemId, "17"]), [itemId, "17"]);
  assert.deepEqual(historyInventoryFilterIds([" 91929292929292929292 "]), ["gid://shopify/InventoryItem/91929292929292929292", "91929292929292929292"]);
  assert.deepEqual(historyInventoryFilterIds(["legacy", variantId]), ["legacy", variantId]);
});
