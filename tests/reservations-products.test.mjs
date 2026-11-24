import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVariantSearchQuery } from "../extensions/common/variantSearch.js";
import { addReservationProduct, exactScanProduct, createReservationScanQueue } from "../extensions/stock-transfer-reservation/src/productList.js";
const product = { id: "gid://shopify/ProductVariant/1", eligible: true, displayName: "Tシャツ / 青", productTitle: "Tシャツ", variantTitle: "青", barcode: "1234567890123", sku: "SKU-1", available: 4, imageUrl: "https://example.invalid/image.png" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test("shared loss search handles one-character names, SKU and JAN identically", () => {
  assert.equal(buildVariantSearchQuery("青"), "青"); assert.equal(buildVariantSearchQuery("T"), "sku:T OR T");
  assert.equal(buildVariantSearchQuery("SKU-1"), "sku:SKU-1 OR SKU-1");
  assert.equal(buildVariantSearchQuery("1234567890123"), "barcode:1234567890123 OR 1234567890123");
  assert.equal(buildVariantSearchQuery("  "), "");
});
test("repeated addition increments one variant and preserves product display metadata", () => {
  const first = addReservationProduct({ id: "draft", name: "Guest", lines: [] }, product, 2);
  const second = addReservationProduct(first, product);
  assert.equal(second.lines.length, 1); assert.equal(second.lines[0].quantity, 3); assert.equal(first.lines[0].quantity, 2);
  assert.equal(second.lines[0].sku, product.sku); assert.equal(second.lines[0].imageUrl, product.imageUrl); assert.equal(second.lines[0].available, 4); assert.equal(second.name, "Guest");
});
test("invalid quantities, too many variants and unavailable products cannot alter the draft", () => {
  const draft = { lines: [{ variantId: product.id, quantity: 9999 }] };
  assert.throws(() => addReservationProduct(draft, product), /9999/); assert.equal(draft.lines[0].quantity, 9999);
  for (const value of [0, -1, 1.5, NaN]) assert.throws(() => addReservationProduct({ lines: [] }, product, value), /数量/);
  assert.throws(() => addReservationProduct({ lines: [] }, { ...product, eligible: false }), /在庫追跡/);
  assert.throws(() => addReservationProduct({ lines: Array.from({ length: 250 }, (_, i) => ({ variantId: `other-${i}`, quantity: 1 })) }, product), /250/);
});
test("scans choose exact barcode before SKU and never guess ambiguous or partial matches", () => {
  assert.equal(exactScanProduct(product.barcode, [{ ...product, id: "sku", sku: product.barcode, barcode: "other" }, product]).id, product.id);
  assert.throws(() => exactScanProduct(product.barcode, [product, { ...product, id: "other" }]), /複数/);
  assert.throws(() => exactScanProduct("123", [product]), /見つかりません/);
  assert.throws(() => exactScanProduct(product.barcode, [product], { hasNextPage: true }), /候補が多い/);
});
test("camera and hardware bursts serialize without losing quantities; duplicate 350ms events are suppressed", async () => {
  let time = 1000, draft = { lines: [] }; const pending = [], failures = [];
  const queue = createReservationScanQueue({ now: () => time, resolve: () => new Promise(resolve => pending.push(resolve)), commit: value => { draft = addReservationProduct(draft, value); }, onError: error => failures.push(error) });
  queue.enqueue(product.barcode); time += 100; queue.enqueue(product.barcode); time += 400; queue.enqueue(product.barcode);
  assert.equal(pending.length, 1); pending.shift()(product); await tick(); assert.equal(pending.length, 1); pending.shift()(product); await tick();
  assert.equal(draft.lines.length, 1); assert.equal(draft.lines[0].quantity, 2); assert.equal(failures.length, 0); queue.stop();
});
test("leaving product screen cancels queued and in-flight additions", async () => {
  let resolve, commits = 0;
  const queue = createReservationScanQueue({ resolve: () => new Promise(done => { resolve = done; }), commit: () => { commits++; }, onError: () => {} });
  queue.enqueue("first"); queue.enqueue("second"); queue.stop(); resolve(product); await tick(); assert.equal(commits, 0);
});
