/**
 * resolveStocktakeCompleteStatus — zero-delta / COMPLETE_RETRY status write
 * Run: node --experimental-strip-types --test tests/stocktake-complete-status.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStocktakeCompleteStatus } from "../app/utils/stocktake-complete-status.ts";

describe("resolveStocktakeCompleteStatus", () => {
  it("marks completed when single group has items and productGroupIds present", () => {
    const r = resolveStocktakeCompleteStatus({
      productGroupIds: ["gid://shopify/Metaobject/1"],
      groupItemsMap: {
        "gid://shopify/Metaobject/1": [{ inventoryItemId: "i1", currentQuantity: 1, actualQuantity: 1 }],
      },
      completedGroupIds: ["gid://shopify/Metaobject/1"],
    });
    assert.equal(r.status, "completed");
    assert.equal(r.allDone, true);
  });

  it("marks completed when productGroupIds missing (zero-delta single-group bug)", () => {
    const r = resolveStocktakeCompleteStatus({
      productGroupIds: [],
      productGroupId: null,
      groupItemsMap: {
        "gid://shopify/Metaobject/9": [{ inventoryItemId: "i1", currentQuantity: 0, actualQuantity: 0 }],
      },
      completedGroupIds: ["gid://shopify/Metaobject/9"],
    });
    assert.equal(r.status, "completed");
    assert.equal(r.groupIdsForCheck.length, 1);
  });

  it("treats cancelled groups as done", () => {
    const r = resolveStocktakeCompleteStatus({
      productGroupIds: ["g1", "g2"],
      cancelledGroupIds: ["g2"],
      groupItemsMap: {
        g1: [{ inventoryItemId: "i1", currentQuantity: 2, actualQuantity: 2 }],
      },
      completedGroupIds: ["g1"],
    });
    assert.equal(r.status, "completed");
  });

  it("stays in_progress when another group still empty", () => {
    const r = resolveStocktakeCompleteStatus({
      productGroupIds: ["g1", "g2"],
      groupItemsMap: {
        g1: [{ inventoryItemId: "i1", currentQuantity: 1, actualQuantity: 1 }],
      },
      completedGroupIds: ["g1"],
    });
    assert.equal(r.status, "in_progress");
  });

  it("matches GID vs numeric id via normalize", () => {
    const r = resolveStocktakeCompleteStatus({
      productGroupIds: ["gid://shopify/Metaobject/42"],
      groupItemsMap: {
        "42": [{ inventoryItemId: "i1", currentQuantity: 5, actualQuantity: 5 }],
      },
      completedGroupIds: ["42"],
    });
    assert.equal(r.status, "completed");
  });
});
