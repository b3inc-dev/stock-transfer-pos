import assert from "node:assert/strict";
import { test } from "node:test";
import { historyProductKey, historyProductKeys, indexHistoryProducts, recoveredHistorySku } from "../app/utils/change-history-product.ts";

const itemId = "gid://shopify/InventoryItem/17";
const variantId = "gid://shopify/ProductVariant/31";
const variant = { id: variantId, sku: "CURRENT", product: { title: "Sample" }, selectedOptions: [{ value: "Blue" }] };

test("a missing variant uses the same inventory item in either stored ID format", () => {
  const products = new Map();
  indexHistoryProducts(products, [{ id: itemId, variant }]);
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
  indexHistoryProducts(products, [variant, { id: itemId, variant }]);
  assert.equal(historyProductKey({ variantId, inventoryItemId: itemId }), variantId);
  assert.equal(products.get(variantId).productTitle, "Sample");
  assert.equal(recoveredHistorySku({ variantId, sku: "" }, products.get(variantId)), "");
  assert.equal(recoveredHistorySku({ sku: "AT-EVENT" }, products.get(itemId)), "");
});

test("invalid item references, deleted variants, failed lookups do not populate unrelated rows", () => {
  const products = new Map();
  indexHistoryProducts(products, [null, { id: itemId, variant: null }, { id: itemId, variant: { id: "gid://shopify/Location/31" } }]);
  assert.equal(products.size, 0);
  for (const inventoryItemId of [undefined, "", variantId, "item17"]) {
    assert.equal(historyProductKey({ inventoryItemId }), "");
    assert.equal(recoveredHistorySku({}, products.get(itemId)), "");
  }
});

test("deduplicate mixed IDs and keep known variants inside the existing lookup cap", () => {
  assert.deepEqual(historyProductKeys([{ inventoryItemId: "17" }, { variantId }, { inventoryItemId: itemId }]), [variantId, itemId]);
});
