/**
 * POS mergeExistingNonBlank 相当の status ダウングレード防止を単体検証。
 * stocktakeApi.js は POS graphql 依存のため、Admin と同型の純関数ロジックをここに複製して契約を固定する。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

function mergeExistingNonBlank(counts, existing) {
  if (!Array.isArray(counts) || counts.length === 0) return counts;
  if (!Array.isArray(existing) || existing.length === 0) return counts;
  const existingById = new Map();
  for (const e of existing) {
    const id = e?.id ?? e?.countId;
    if (id) existingById.set(String(id), e);
  }
  return counts.map((c) => {
    const id = c?.id ?? c?.countId;
    if (!id) return c;
    const ex = existingById.get(String(id));
    if (!ex || typeof ex !== "object") return c;
    const out = { ...c };
    const hasGroupItems = out.groupItems && typeof out.groupItems === "object" && Object.keys(out.groupItems).length > 0;
    const exHasGroupItems = ex.groupItems && typeof ex.groupItems === "object" && Object.keys(ex.groupItems).length > 0;
    if (!hasGroupItems && exHasGroupItems) {
      out.groupItems = ex.groupItems;
    } else if (hasGroupItems && exHasGroupItems) {
      out.groupItems = { ...ex.groupItems, ...out.groupItems };
    }
    if (!out.status) {
      if (ex.status) out.status = ex.status;
      if (ex.completedAt) out.completedAt = ex.completedAt;
    } else if ((ex.status === "completed" || ex.status === "cancelled") && !out.completedAt && ex.completedAt) {
      out.completedAt = ex.completedAt;
    }
    if (ex.status === "completed" || ex.status === "cancelled") {
      if (out.status !== "completed" && out.status !== "cancelled") {
        out.status = ex.status;
        out.completedAt = ex.completedAt ?? out.completedAt;
      }
    }
    return out;
  });
}

describe("mergeExistingNonBlank status downgrade guard", () => {
  it("keeps existing completed when payload is in_progress", () => {
    const existing = [
      {
        id: "x",
        status: "completed",
        completedAt: "2026-10-01T00:00:00.000Z",
        groupItems: { g1: [{ inventoryItemId: "1" }] },
      },
    ];
    const payload = [
      {
        id: "x",
        status: "in_progress",
        groupItems: { g1: [{ inventoryItemId: "1" }] },
      },
    ];
    const merged = mergeExistingNonBlank(payload, existing);
    assert.equal(merged[0].status, "completed");
    assert.equal(merged[0].completedAt, "2026-10-01T00:00:00.000Z");
  });

  it("keeps existing cancelled when payload is draft", () => {
    const existing = [{ id: "y", status: "cancelled", completedAt: undefined }];
    const payload = [{ id: "y", status: "draft" }];
    const merged = mergeExistingNonBlank(payload, existing);
    assert.equal(merged[0].status, "cancelled");
  });

  it("preserves sibling groupItems when payload only has one group", () => {
    const existing = [
      {
        id: "z",
        status: "in_progress",
        groupItems: {
          g1: [{ inventoryItemId: "1" }],
          g2: [{ inventoryItemId: "2" }],
        },
      },
    ];
    const payload = [
      {
        id: "z",
        status: "in_progress",
        groupItems: { g1: [{ inventoryItemId: "1", actualQuantity: 9 }] },
      },
    ];
    const merged = mergeExistingNonBlank(payload, existing);
    assert.equal(merged[0].groupItems.g2[0].inventoryItemId, "2");
    assert.equal(merged[0].groupItems.g1[0].actualQuantity, 9);
  });
});
