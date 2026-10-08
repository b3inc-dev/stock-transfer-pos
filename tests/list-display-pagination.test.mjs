import test from "node:test";
import assert from "node:assert/strict";
import {
  LIST_ITEMS_PER_PAGE,
  getListPageSlice,
} from "../extensions/common/listDisplayPagination.js";

test("LIST_ITEMS_PER_PAGE is 50", () => {
  assert.equal(LIST_ITEMS_PER_PAGE, 50);
});

test("getListPageSlice paginates and clamps page", () => {
  const items = Array.from({ length: 120 }, (_, i) => i + 1);
  const p1 = getListPageSlice(items, 1);
  assert.equal(p1.total, 120);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.currentPage, 1);
  assert.equal(p1.showPagination, true);
  assert.deepEqual(p1.displayed, items.slice(0, 50));
  assert.equal(p1.rangeStart, 1);
  assert.equal(p1.rangeEnd, 50);

  const p3 = getListPageSlice(items, 3);
  assert.equal(p3.currentPage, 3);
  assert.deepEqual(p3.displayed, items.slice(100, 120));
  assert.equal(p3.rangeStart, 101);
  assert.equal(p3.rangeEnd, 120);

  const overflow = getListPageSlice(items, 99);
  assert.equal(overflow.currentPage, 3);

  const empty = getListPageSlice([], 1);
  assert.equal(empty.showPagination, false);
  assert.equal(empty.rangeStart, 0);
  assert.equal(empty.rangeEnd, 0);
});
