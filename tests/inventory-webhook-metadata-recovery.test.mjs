import test from "node:test";
import assert from "node:assert/strict";
import { repairInventoryLogMetadata } from "../app/utils/repairInventoryLogMetadata.js";

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
