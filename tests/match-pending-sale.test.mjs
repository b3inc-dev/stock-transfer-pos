import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPendingSale } from "../app/utils/match-pending-sale.ts";

const order = { orderId: "example", quantity: 2 };
const other = { orderId: "other", quantity: 3 };

test("selects the unique pending sale that explains the decrease", () => {
  assert.equal(matchPendingSale([other, order], -2), order);
});

test("keeps positive, zero, unknown, or mismatched movements separate from sales", () => {
  for (const delta of [1, 0, null, -1, -4]) {
    assert.equal(matchPendingSale([order, other], delta), null);
  }
});

test("does not pick an order by list order when candidates have the same quantity", () => {
  const sameQuantity = { orderId: "second", quantity: 2 };
  assert.equal(matchPendingSale([order, sameQuantity], -2), null);
  assert.equal(matchPendingSale([sameQuantity, order], -2), null);
  assert.equal(matchPendingSale([], -2), null);
});
