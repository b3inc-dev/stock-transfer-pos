/**
 * 管理画面 get_count_full の単件読取（インデックス → 末尾チャンク → 全件フォールバック）判定と、
 * 棚卸画面の読み取り専用 action の再検証抑止判定。
 * Run: node --experimental-strip-types --test tests/inventory-count-single-read.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findCountInChunkRaws,
  lookupCountChunkIndices,
  parseCountChunkIndex,
  tailChunkIndices,
} from "../app/utils/inventory-count-single-read.ts";
import {
  isInventoryCountFormAction,
  isInventoryCountReadOnlyAction,
  isInventoryCountReadOnlySubmission,
} from "../app/utils/inventory-count-revalidation.ts";

const normalize = (id) => String(id ?? "").trim().replace(/^gid:\/\/shopify\/\w+\//, "");
const merge = (parts) => {
  const sorted = [...parts].sort((a, b) => a.partIndex - b.partIndex);
  const groupItems = {};
  for (const p of sorted) for (const [k, arr] of Object.entries(p.groupItems ?? {})) (groupItems[k] ??= []).push(...arr);
  return { ...sorted[0].countMeta, groupItems };
};
const fd = (obj) => ({ get: (k) => (k in obj ? obj[k] : null) });

describe("lookupCountChunkIndices", () => {
  it("returns sorted unique indices within totalChunks", () => {
    const index = parseCountChunkIndex(JSON.stringify({ ic_1: [3, 1, 3] }));
    assert.deepEqual(lookupCountChunkIndices(index, "ic_1", 5, normalize), [1, 3]);
  });
  it("rejects indices beyond totalChunks (stale leftover chunk keys)", () => {
    const index = parseCountChunkIndex(JSON.stringify({ ic_1: [1, 7] }));
    assert.equal(lookupCountChunkIndices(index, "ic_1", 5, normalize), null);
  });
  it("returns null for missing id / invalid index", () => {
    assert.equal(lookupCountChunkIndices(parseCountChunkIndex("{}"), "ic_1", 5, normalize), null);
    assert.equal(lookupCountChunkIndices(parseCountChunkIndex("not json"), "ic_1", 5, normalize), null);
    assert.equal(lookupCountChunkIndices(parseCountChunkIndex("[1,2]"), "ic_1", 5, normalize), null);
  });
  it("accepts a scalar chunk number", () => {
    assert.deepEqual(lookupCountChunkIndices({ ic_1: 2 }, "ic_1", 5, normalize), [2]);
  });
});

describe("findCountInChunkRaws", () => {
  it("returns a whole count object", () => {
    const raw = JSON.stringify([{ id: "ic_0" }, { id: "ic_1", status: "completed", groupItems: { g: [{ q: 1 }] } }]);
    const r = findCountInChunkRaws([{ index: 2, raw }], "ic_1", normalize, merge);
    assert.equal(r.status, "found");
    assert.equal(r.count.status, "completed");
  });
  it("prefers whole objects over parts, like the full read", () => {
    const c1 = JSON.stringify([{ _part: true, countId: "ic_1", partIndex: 0, totalParts: 1, countMeta: { id: "ic_1", status: "p" }, groupItems: {} }]);
    const c2 = JSON.stringify([{ id: "ic_1", status: "whole" }]);
    const r = findCountInChunkRaws([{ index: 1, raw: c1 }, { index: 2, raw: c2 }], "ic_1", normalize, merge);
    assert.equal(r.count.status, "whole");
  });
  it("merges complete parts across chunks", () => {
    const p0 = { _part: true, countId: "ic_1", partIndex: 0, totalParts: 2, countMeta: { id: "ic_1" }, groupItems: { g: [1] } };
    const p1 = { _part: true, countId: "ic_1", partIndex: 1, totalParts: 2, groupItems: { g: [2] } };
    const r = findCountInChunkRaws(
      [{ index: 4, raw: JSON.stringify([p1]) }, { index: 3, raw: JSON.stringify([p0]) }],
      "ic_1",
      normalize,
      merge
    );
    assert.equal(r.status, "found");
    assert.deepEqual(r.count.groupItems.g, [1, 2]);
  });
  it("reports incomplete when a part is missing (must fall back to full read)", () => {
    const p0 = { _part: true, countId: "ic_1", partIndex: 0, totalParts: 2, countMeta: { id: "ic_1" }, groupItems: {} };
    const r = findCountInChunkRaws([{ index: 0, raw: JSON.stringify([p0]) }], "ic_1", normalize, merge);
    assert.equal(r.status, "incomplete");
  });
  it("reports incomplete on broken chunk JSON", () => {
    assert.equal(findCountInChunkRaws([{ index: 0, raw: "{" }], "ic_1", normalize, merge).status, "incomplete");
  });
  it("reports not_found when absent", () => {
    const r = findCountInChunkRaws([{ index: 0, raw: JSON.stringify([{ id: "ic_2" }]) }], "ic_1", normalize, merge);
    assert.equal(r.status, "not_found");
  });
});

describe("tailChunkIndices", () => {
  it("returns last N chunks excluding already-read ones", () => {
    assert.deepEqual(tailChunkIndices(10, 2), [8, 9]);
    assert.deepEqual(tailChunkIndices(10, 2, [9]), [7, 8]);
    assert.deepEqual(tailChunkIndices(1, 2), [0]);
  });
});

describe("inventory-count revalidation", () => {
  it("treats read-only POST actions as non-revalidating", () => {
    assert.equal(isInventoryCountReadOnlyAction("POST", fd({ action: "get_count_full" })), true);
    assert.equal(isInventoryCountReadOnlyAction("post", fd({ action: "get_incomplete_group_products" })), true);
    assert.equal(isInventoryCountReadOnlyAction("POST", fd({ actionType: "searchVariantsForInventoryCount" })), true);
  });
  it("keeps revalidation for write actions and non-POST", () => {
    for (const a of [
      "create_inventory_count",
      "confirm_stocktake_group",
      "confirm_stocktake_all",
      "cancel_stocktake",
      "save_product_group",
      "pos_metafield_retry",
      "metafield_repair",
    ]) {
      assert.equal(isInventoryCountReadOnlyAction("POST", fd({ action: a })), false, a);
    }
    assert.equal(isInventoryCountReadOnlyAction("GET", fd({ action: "get_count_full" })), false);
    assert.equal(isInventoryCountReadOnlyAction(undefined, undefined), false);
  });
  it("matches only the inventory-count route for the layout loader", () => {
    assert.equal(isInventoryCountFormAction("/app/inventory-count?shop=x&host=y"), true);
    assert.equal(isInventoryCountFormAction("/app/inventory-count.data"), true);
    assert.equal(isInventoryCountFormAction("/app/inventory-count-other"), false);
    assert.equal(isInventoryCountFormAction("/app/loss"), false);
    assert.equal(
      isInventoryCountReadOnlySubmission({ formMethod: "POST", formAction: "/app/loss", formData: fd({ action: "get_count_full" }) }),
      false
    );
    assert.equal(
      isInventoryCountReadOnlySubmission({
        formMethod: "POST",
        formAction: "/app/inventory-count",
        formData: fd({ action: "get_count_full" }),
      }),
      true
    );
  });
});
