/**
 * backupPersisted 解釈 + savedCount（dual-write）純粋ロジック
 * Run: node --experimental-strip-types --test tests/stocktake-pending-complete.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  interpretMetafieldsSetWriteResult,
  mergePendingCompleteIntoCounts,
} from "../app/utils/stocktake-pending-complete-merge.ts";

describe("interpretMetafieldsSetWriteResult (backupPersisted)", () => {
  it("returns ok:true when metafieldsSet has no errors", () => {
    const r = interpretMetafieldsSetWriteResult({
      httpOk: true,
      httpStatus: 200,
      json: { data: { metafieldsSet: { userErrors: [] } } },
    });
    assert.equal(r.ok, true);
  });

  it("returns ok:false on HTTP failure", () => {
    const r = interpretMetafieldsSetWriteResult({
      httpOk: false,
      httpStatus: 503,
      json: {},
    });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /HTTP 503/);
  });

  it("returns ok:false on GraphQL userErrors", () => {
    const r = interpretMetafieldsSetWriteResult({
      httpOk: true,
      httpStatus: 200,
      json: { data: { metafieldsSet: { userErrors: [{ message: "denied" }] } } },
    });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /denied/);
  });
});

describe("mergePendingCompleteIntoCounts savedCount", () => {
  it("returns savedCount with completed status for dual-write without re-read", () => {
    const r = mergePendingCompleteIntoCounts({
      inventoryCounts: [
        {
          id: "c1",
          productGroupIds: ["g1"],
          groupItems: {},
          status: "in_progress",
        },
      ],
      countId: "c1",
      completedGroups: [
        {
          groupId: "g1",
          items: [{ inventoryItemId: "i1", currentQuantity: 1, actualQuantity: 1 }],
        },
      ],
      nowIso: "2026-10-09T12:00:00.000Z",
    });

    assert.equal(r.status, "completed");
    assert.equal(r.completedAt, "2026-10-09T12:00:00.000Z");
    assert.ok(r.savedCount, "savedCount must be present for dual-write");
    assert.equal(r.savedCount.id, "c1");
    assert.equal(r.savedCount.status, "completed");
    assert.equal(r.savedCount.completedAt, "2026-10-09T12:00:00.000Z");
    assert.equal(r.savedCount.groupItems.g1.length, 1);
    assert.equal(r.updatedCounts[0], r.savedCount);
  });

  it("stays in_progress and still returns savedCount when another group empty", () => {
    const r = mergePendingCompleteIntoCounts({
      inventoryCounts: [
        {
          id: "c1",
          productGroupIds: ["g1", "g2"],
          groupItems: {},
          status: "in_progress",
        },
      ],
      countId: "c1",
      completedGroups: [
        {
          groupId: "g1",
          items: [{ inventoryItemId: "i1", currentQuantity: 2, actualQuantity: 2 }],
        },
      ],
    });

    assert.equal(r.status, "in_progress");
    assert.equal(r.completedAt, undefined);
    assert.ok(r.savedCount);
    assert.equal(r.savedCount.status, "in_progress");
  });
});
