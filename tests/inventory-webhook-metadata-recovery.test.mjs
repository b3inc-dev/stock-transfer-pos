import test from "node:test";
import assert from "node:assert/strict";
import { findOrderLinkedReplay, repairInventoryLogMetadata } from "../app/utils/repairInventoryLogMetadata.js";

const missing = { id: "one", shop: "fixture", locationName: "22", sku: "", variantId: null, delta: -2, quantityAfter: 8 };
const recovered = { locationIdRaw: "22", locationName: "North", sku: "TEST", variantId: "variant-33" };

function mockLog(row) {
  return { updateMany: async ({ where, data }) => {
    if (Object.entries(where).every(([key, value]) => row[key] === value)) Object.assign(row, data);
  } };
}

test("同じ通知の再送で回復した表示項目だけが埋まる", async () => {
  const row = { ...missing };
  const log = mockLog(row);
  await repairInventoryLogMetadata(log, { ...row }, row.shop, { ...recovered, variantId: null, sku: "" });
  assert.deepEqual(row, { ...missing, locationName: "North" });
  await repairInventoryLogMetadata(log, { ...row }, row.shop, recovered);
  assert.deepEqual(row, { ...missing, locationName: "North", sku: "TEST", variantId: "variant-33" });
});

test("並行処理で先に補った別の情報を古い読み取り結果で置き換えない", async () => {
  const row = { ...missing, locationName: "West", variantId: "another" };
  await repairInventoryLogMetadata(mockLog(row), { ...missing }, row.shop, recovered);
  assert.deepEqual(row, { ...missing, locationName: "West", variantId: "another" });
});

for (const activity of ["order_sales", "refund"]) {
  test(activity + " の専用キーは店舗・商品・拠点・時刻・数量と元注文で照合する", async () => {
    const event = { shop: "fixture", inventoryItemId: "11", locationId: "22", quantityAfter: 8, timestamp: new Date(0) };
    const row = { ...missing, ...event, sourceId: "order_44", activity,
      idempotencyKey: "fixture_" + activity + "_11_22_order_44_" + event.timestamp.toISOString() };
    let matches = [row];
    const log = { findMany: async ({ where, take }) => {
      const { OR, ...identity } = where;
      assert.deepEqual(identity, event);
      assert.equal(take, 2);
      const filter = OR.find(term => term.activity === activity);
      assert.equal(row.idempotencyKey.startsWith(filter.idempotencyKey.startsWith), true);
      assert.equal(row.idempotencyKey.endsWith(filter.idempotencyKey.endsWith), true);
      return matches;
    } };
    assert.equal(await findOrderLinkedReplay(log, event), row);
    matches = [row, row];
    assert.equal(await findOrderLinkedReplay(log, event), null);
    matches = [{ ...row, sourceId: "order_45" }];
    assert.equal(await findOrderLinkedReplay(log, event), null);
  });
}
