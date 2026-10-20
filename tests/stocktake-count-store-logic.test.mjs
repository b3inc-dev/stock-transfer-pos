/**
 * 棚卸 1 件ずつ保存（db_v2）の純粋ロジック
 * Run: node --experimental-strip-types --test tests/stocktake-count-store-logic.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleCount,
  compareCountSets,
  countsEqual,
  diffChangedCounts,
  maxCountNameNumber,
  nextCountName,
  normalizeStocktakeId,
  parseStorageMode,
  reconcileLegacyIntoDb,
  resolveEffectiveMode,
  sortListNewestFirst,
  splitCount,
  toListEntry,
} from "../app/utils/stocktake-count-store-logic.ts";

const baseCount = () => ({
  id: "gid://app/InventoryCount/1",
  countName: "#C0001",
  locationId: "gid://shopify/Location/10",
  locationName: "本店",
  status: "in_progress",
  createdAt: "2026-10-01T00:00:00.000Z",
  productGroupIds: ["g1", "g2"],
  productGroupNames: ["A", "B"],
  groupItems: {
    g1: [{ inventoryItemId: "i1", currentQuantity: 3, actualQuantity: 2 }],
  },
});

describe("parseStorageMode / resolveEffectiveMode", () => {
  it("parses known modes and rejects others", () => {
    assert.equal(parseStorageMode(" DB "), "db");
    assert.equal(parseStorageMode("dual"), "dual");
    assert.equal(parseStorageMode("legacy"), "legacy");
    assert.equal(parseStorageMode("x"), null);
    assert.equal(parseStorageMode(undefined), null);
  });

  it("defaults to legacy when nothing is set", () => {
    assert.equal(resolveEffectiveMode({ envMode: undefined, override: null, backfilled: false }), "legacy");
    assert.equal(resolveEffectiveMode({ envMode: "garbage", override: null, backfilled: true }), "legacy");
  });

  it("per-shop override wins over env", () => {
    assert.equal(resolveEffectiveMode({ envMode: "dual", override: "legacy", backfilled: true }), "legacy");
    assert.equal(resolveEffectiveMode({ envMode: "legacy", override: "dual", backfilled: false }), "dual");
  });

  it("db is downgraded to dual until backfill is done", () => {
    assert.equal(resolveEffectiveMode({ envMode: "db", override: null, backfilled: false }), "dual");
    assert.equal(resolveEffectiveMode({ envMode: "legacy", override: "db", backfilled: false }), "dual");
    assert.equal(resolveEffectiveMode({ envMode: "legacy", override: "db", backfilled: true }), "db");
  });
});

describe("splitCount / assembleCount", () => {
  it("round-trips a count with group results", () => {
    const c = baseCount();
    const s = splitCount(c);
    assert.equal(s.countId, c.id);
    assert.equal("groupItems" in s.header, false);
    assert.equal(s.groups.length, 1);
    assert.equal(s.groups[0].groupKey, "g1");
    assert.ok(countsEqual(assembleCount(s.header, s.groups), c));
  });

  it("does not add groupItems when there are no group results", () => {
    const noGroups = baseCount();
    delete noGroups.groupItems;
    const s = splitCount(noGroups);
    assert.equal(s.groups.length, 0);
    assert.equal("groupItems" in assembleCount(s.header, s.groups), false);
  });

  it("dedupes group ids that normalize to the same key", () => {
    const c = { ...baseCount(), groupItems: { "gid://x/G/5": [1], "5": [2] } };
    const s = splitCount(c);
    assert.equal(s.groups.length, 1);
    assert.equal(s.groups[0].groupKey, "5");
  });

  it("list entry carries only light fields", () => {
    const e = toListEntry({ ...baseCount(), completedAt: "2026-10-02T00:00:00.000Z" });
    assert.equal("groupItems" in e, false);
    assert.deepEqual(e.productGroupIds, ["g1", "g2"]);
    assert.equal(e.completedAt, "2026-10-02T00:00:00.000Z");
    assert.deepEqual(toListEntry({ id: "x", productGroupId: "g9" }).productGroupIds, ["g9"]);
  });
});

describe("reconcileLegacyIntoDb (conservative ingest of old POS writes)", () => {
  it("inserts a count that only exists in the metafield", () => {
    const lg = baseCount();
    const r = reconcileLegacyIntoDb(null, lg);
    assert.equal(r.changed, true);
    assert.ok(countsEqual(r.next, lg));
  });

  it("raises draft -> in_progress (old POS start)", () => {
    const r = reconcileLegacyIntoDb({ ...baseCount(), status: "draft" }, { ...baseCount(), status: "in_progress" });
    assert.equal(r.next.status, "in_progress");
    assert.equal(r.changed, true);
  });

  it("never downgrades a completed count", () => {
    const db = { ...baseCount(), status: "completed", completedAt: "2026-10-03T00:00:00.000Z" };
    const r = reconcileLegacyIntoDb(db, { ...baseCount(), status: "in_progress" });
    assert.equal(r.next.status, "completed");
    assert.equal(r.changed, false);
  });

  it("never revives a cancelled count", () => {
    const r = reconcileLegacyIntoDb({ ...baseCount(), status: "cancelled" }, { ...baseCount(), status: "completed" });
    assert.equal(r.next.status, "cancelled");
  });

  it("does not overwrite DB group results with metafield results", () => {
    const lg = {
      ...baseCount(),
      groupItems: {
        g1: [{ inventoryItemId: "i1", currentQuantity: 3, actualQuantity: 99 }],
        g2: [{ inventoryItemId: "i2", currentQuantity: 1, actualQuantity: 1 }],
      },
    };
    const r = reconcileLegacyIntoDb(baseCount(), lg);
    assert.equal(r.next.groupItems.g1[0].actualQuantity, 2);
    assert.equal(r.next.groupItems.g2[0].inventoryItemId, "i2");
    assert.equal(r.changed, true);
  });

  it("fills blank fields only and unions cancelled groups", () => {
    const db = { ...baseCount(), countName: "", cancelledGroupIds: ["g1"] };
    const lg = { ...baseCount(), countName: "#C0007", locationName: "別名", cancelledGroupIds: ["gid://x/g2", "g1"] };
    const r = reconcileLegacyIntoDb(db, lg);
    assert.equal(r.next.countName, "#C0007");
    assert.equal(r.next.locationName, "本店");
    assert.deepEqual(r.next.cancelledGroupIds, ["g1", "gid://x/g2"]);
  });

  it("reports no change when the metafield matches", () => {
    assert.equal(reconcileLegacyIntoDb(baseCount(), baseCount()).changed, false);
  });

  it("sets completedAt when old server completed the count", () => {
    const r = reconcileLegacyIntoDb(baseCount(), {
      ...baseCount(),
      status: "completed",
      completedAt: "2026-10-04T00:00:00.000Z",
    });
    assert.equal(r.next.status, "completed");
    assert.equal(r.next.completedAt, "2026-10-04T00:00:00.000Z");
  });
});

describe("diffChangedCounts", () => {
  it("returns only new or changed counts and ignores key order", () => {
    const a = baseCount();
    const b = { ...baseCount(), id: "gid://app/InventoryCount/2", countName: "#C0002" };
    const aReordered = JSON.parse(JSON.stringify({ status: a.status, ...a }));
    const c = { ...baseCount(), id: "3" };
    const changedB = { ...b, status: "completed" };
    const out = diffChangedCounts([a, b], [aReordered, changedB, c]);
    assert.deepEqual(
      out.map((x) => x.id),
      ["gid://app/InventoryCount/2", "3"]
    );
  });

  it("does not report removed counts", () => {
    assert.deepEqual(diffChangedCounts([baseCount()], []), []);
  });
});

describe("count names", () => {
  it("uses the larger of DB max + 1 and the legacy next number", () => {
    assert.equal(nextCountName(["#C0001", "#C0012", null, "x"], null), "#C0013");
    assert.equal(nextCountName(["#C0001"], 40), "#C0040");
    assert.equal(nextCountName([], null), "#C0001");
    assert.equal(nextCountName(["#C9999"], null), "#C10000");
  });

  it("maxCountNameNumber ignores malformed names", () => {
    assert.equal(maxCountNameNumber(["#C0003", "C0009", "#c0005", undefined]), 5);
  });
});

describe("sortListNewestFirst / normalizeStocktakeId", () => {
  it("sorts by createdAt descending without mutating input", () => {
    const input = [
      { id: "a", createdAt: "2026-10-01T00:00:00Z" },
      { id: "b", createdAt: "2026-10-03T00:00:00Z" },
      { id: "c", createdAt: "2026-10-02T00:00:00Z" },
    ];
    assert.deepEqual(
      sortListNewestFirst(input).map((x) => x.id),
      ["b", "c", "a"]
    );
    assert.equal(input[0].id, "a");
  });

  it("normalizes gids to the trailing segment", () => {
    assert.equal(normalizeStocktakeId("gid://app/InventoryCount/42"), "42");
    assert.equal(normalizeStocktakeId(" 42 "), "42");
    assert.equal(normalizeStocktakeId(null), "");
  });
});

describe("compareCountSets (verify)", () => {
  it("classifies missing and differing counts", () => {
    const a = baseCount();
    const b = { ...baseCount(), id: "2" };
    const c = { ...baseCount(), id: "3" };
    const legacyA = { ...a, groupItems: { "gid://x/g1": a.groupItems.g1 }, _legacyOnly: true };
    const r = compareCountSets([a, b], [legacyA, { ...b, status: "completed" }, c]);
    assert.equal(r.same, 1);
    assert.deepEqual(r.different, ["2"]);
    assert.deepEqual(r.onlyInLegacy, ["3"]);
    assert.deepEqual(r.onlyInDb, []);
  });
});
