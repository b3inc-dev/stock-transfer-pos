import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStocktakeId,
  lineIdentityKey,
  dedupeLinesByIdentity,
  appendUniqueLines,
  pendingSnapshotIds,
  hasPendingSnapshotIds,
  dedupeAdjustEntries,
  collectInventoryItemIdSet,
  toNormalizedIdSet,
} from "../extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeLineIdentity.js";

const gid = (n) => `gid://shopify/InventoryItem/${n}`;
const line = (n, extra = {}) => ({ id: `row-${n}-${Math.random()}`, inventoryItemId: gid(n), variantId: `gid://shopify/ProductVariant/${n}`, actualQuantity: 0, currentQuantity: 5, ...extra });

test("normalizeStocktakeId treats GID and numeric id as the same", () => {
  assert.equal(normalizeStocktakeId(gid(123)), "123");
  assert.equal(normalizeStocktakeId("123"), "123");
  assert.equal(normalizeStocktakeId(" "), "");
  assert.equal(normalizeStocktakeId(null), "");
});

test("lineIdentityKey prefers inventoryItemId, falls back to variantId, optional group scope", () => {
  assert.equal(lineIdentityKey({ inventoryItemId: gid(1), variantId: "v" }), "i:1");
  assert.equal(lineIdentityKey({ variantId: "gid://shopify/ProductVariant/9" }), "v:9");
  assert.equal(lineIdentityKey({}), "");
  assert.equal(lineIdentityKey({ inventoryItemId: "1", productGroupId: "gid://x/Group/g1" }, { scopeByGroup: true }), "g1|i:1");
});

test("dedupeLinesByIdentity keeps first row position/id and takes max actualQuantity (not sum)", () => {
  const a = line(1, { id: "a", actualQuantity: 2 });
  const b = line(2, { id: "b" });
  const aDup = line(1, { id: "a2", inventoryItemId: "1", actualQuantity: 3 });
  const { lines, mergedCount } = dedupeLinesByIdentity([a, b, aDup]);
  assert.equal(mergedCount, 1);
  assert.deepEqual(lines.map((l) => l.id), ["a", "b"]);
  assert.equal(lines[0].actualQuantity, 3);
});

test("dedupeLinesByIdentity returns the same array when there is nothing to merge", () => {
  const src = [line(1), line(2)];
  const { lines, mergedCount } = dedupeLinesByIdentity(src);
  assert.equal(mergedCount, 0);
  assert.equal(lines, src);
});

test("dedupeLinesByIdentity: non-extra wins over extra, loaded stock wins over loading", () => {
  const a = line(1, { isExtra: true, stockLoading: true, currentQuantity: 0 });
  const b = line(1, { isExtra: false, stockLoading: false, currentQuantity: 7 });
  const { lines } = dedupeLinesByIdentity([a, b]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].isExtra, false);
  assert.equal(lines[0].currentQuantity, 7);
  assert.equal(lines[0].stockLoading, false);
});

test("dedupeLinesByIdentity scopeByGroup keeps same item in different groups", () => {
  const src = [line(1, { productGroupId: "g1" }), line(1, { productGroupId: "g2" }), line(1, { productGroupId: "g1", actualQuantity: 4 })];
  const { lines, mergedCount } = dedupeLinesByIdentity(src, { scopeByGroup: true });
  assert.equal(mergedCount, 1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].actualQuantity, 4);
});

test("dedupeLinesByIdentity leaves rows without identity untouched", () => {
  const src = [{ id: "x" }, { id: "y" }];
  assert.equal(dedupeLinesByIdentity(src).lines.length, 2);
});

test("appendUniqueLines skips rows already present (incl. incoming duplicates)", () => {
  const prev = [line(1), line(2)];
  const incoming = [line(2), line(3), line(3), line(4)];
  const { lines, added, skippedCount } = appendUniqueLines(prev, incoming);
  assert.equal(lines.length, 4);
  assert.deepEqual(added.map((l) => normalizeStocktakeId(l.inventoryItemId)), ["3", "4"]);
  assert.equal(skippedCount, 2);
});

test("RCA scenario: snapshot 100 ids, 2 deleted → no overlap on load more, no stuck 要読込", () => {
  const snapshot = Array.from({ length: 100 }, (_, i) => gid(i + 1));
  const deleted = new Set(["3", "7"]);
  const loaded = snapshot.filter((id) => !deleted.has(normalizeStocktakeId(id))).map((id) => ({ inventoryItemId: id }));
  assert.equal(loaded.length, 98);
  const exclude = collectInventoryItemIdSet(loaded);
  // 旧方式: offset = lines.length(98) → slice(98) は既に表示済みの 99,100 を再取得していた
  assert.deepEqual(snapshot.slice(98).map(normalizeStocktakeId), ["99", "100"]);
  // 新方式: 未読込は削除済みの 2 件だけ
  assert.deepEqual(pendingSnapshotIds(snapshot, exclude).map(normalizeStocktakeId), ["3", "7"]);
  // 解決不能を消費済みにすると hasMore は false
  for (const n of deleted) exclude.add(n);
  assert.equal(hasPendingSnapshotIds({ g1: snapshot }, ["g1"], exclude), false);
});

test("pendingSnapshotIds de-duplicates snapshot ids and keeps original order/form", () => {
  const snapshot = [gid(1), gid(2), "1", gid(3), gid(2)];
  assert.deepEqual(pendingSnapshotIds(snapshot, new Set()), [gid(1), gid(2), gid(3)]);
  assert.deepEqual(pendingSnapshotIds(snapshot, toNormalizedIdSet(["2"])), [gid(1), gid(3)]);
});

test("hasPendingSnapshotIds: duplicate snapshot ids / extra rows do not force 要読込", () => {
  const byGroup = { "gid://shopify/Group/10": [gid(1), gid(1), gid(2)] };
  const loaded = [{ inventoryItemId: gid(1) }, { inventoryItemId: gid(2) }, { inventoryItemId: gid(99), isExtra: true }];
  // 旧方式: totalIds(3) > lines(3) は false だが、予定外が無い場合 3 > 2 で true になっていた
  assert.equal(hasPendingSnapshotIds(byGroup, ["10"], collectInventoryItemIdSet(loaded.slice(0, 2))), false);
  assert.equal(hasPendingSnapshotIds(byGroup, ["10"], collectInventoryItemIdSet(loaded)), false);
  assert.equal(hasPendingSnapshotIds(byGroup, ["10"], collectInventoryItemIdSet(loaded.slice(0, 1))), true);
  assert.equal(hasPendingSnapshotIds(null, ["10"], new Set()), false);
  assert.equal(hasPendingSnapshotIds(byGroup, ["other"], new Set()), false);
});

test("dedupeAdjustEntries sends one entry per inventoryItemId (max quantityAfter) and reports conflicts", () => {
  const entries = [
    { inventoryItemId: gid(1), quantityAfter: 3, quantityBefore: 5 },
    { inventoryItemId: gid(2), quantityAfter: 1, quantityBefore: 0 },
    { inventoryItemId: "1", quantityAfter: 4, quantityBefore: 5 },
    { inventoryItemId: gid(2), quantityAfter: 1, quantityBefore: 0 },
  ];
  const r = dedupeAdjustEntries(entries);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].quantityAfter, 4);
  assert.equal(r.entries[0].inventoryItemId, gid(1));
  assert.equal(r.duplicateCount, 2);
  assert.equal(r.conflictCount, 1);
});
