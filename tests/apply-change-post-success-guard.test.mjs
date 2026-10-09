/**
 * 差異あり確定: Shopify setQuantities 成功後に failed→#16 clear→再 set しないこと。
 * sticky applying TTL / statusLookupFailed→202 もカバー。
 * Run: node --experimental-strip-types --test tests/apply-change-post-success-guard.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPLYING_STALE_MS,
  decideOuterCatchAction,
  decideStaleApplyingAction,
  isDefiniteUnaappliedRejection,
} from "../app/utils/apply-change-outer-catch-guard.ts";

describe("decideOuterCatchAction — no failed after Shopify success", () => {
  it("preserves completed when DB already completed", () => {
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: null, existingStatus: "completed" }),
      { action: "preserve", ensureStatus: "completed" }
    );
  });

  it("preserves partial_failed sticky", () => {
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: null, existingStatus: "partial_failed" }),
      { action: "preserve", ensureStatus: "partial_failed" }
    );
  });

  it("heals applying → completed when inventoryApplied=full (PR#20 R1)", () => {
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: "full", existingStatus: "applying" }),
      { action: "preserve", ensureStatus: "completed" }
    );
  });

  it("heals pending → completed when inventoryApplied=full", () => {
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: "full", existingStatus: "pending" }),
      { action: "preserve", ensureStatus: "completed" }
    );
  });

  it("heals applying → partial_failed when inventoryApplied=partial", () => {
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: "partial", existingStatus: "applying" }),
      { action: "preserve", ensureStatus: "partial_failed" }
    );
  });

  it("marks failed only when never applied and still pending/applying", () => {
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: null, existingStatus: "applying" }),
      { action: "cas_mark_failed" }
    );
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: null, existingStatus: "pending" }),
      { action: "cas_mark_failed" }
    );
  });

  it("does not claim failed when status read failed but inventoryApplied set", () => {
    assert.deepEqual(
      decideOuterCatchAction({ inventoryApplied: "full", existingStatus: null }),
      { action: "preserve", ensureStatus: "completed" }
    );
  });

  it("preserves when applied lines exist even without inventoryApplied flag", () => {
    assert.deepEqual(
      decideOuterCatchAction({
        inventoryApplied: null,
        existingStatus: "applying",
        appliedLineCount: 2,
      }),
      { action: "preserve", ensureStatus: "completed" }
    );
  });

  it("returns in-flight when status lookup failed and no apply evidence", () => {
    assert.deepEqual(
      decideOuterCatchAction({
        inventoryApplied: null,
        existingStatus: null,
        statusLookupFailed: true,
      }),
      { action: "return_inflight" }
    );
  });
});

describe("decideStaleApplyingAction — sticky applying TTL", () => {
  it("keeps in-flight before TTL", () => {
    assert.deepEqual(
      decideStaleApplyingAction({
        ageMs: APPLYING_STALE_MS - 1,
        staleAfterMs: APPLYING_STALE_MS,
        appliedLineCount: 0,
        totalLineCount: 3,
      }),
      { action: "keep_inflight" }
    );
  });

  it("heals to completed when all lines applied after TTL", () => {
    assert.deepEqual(
      decideStaleApplyingAction({
        ageMs: APPLYING_STALE_MS + 1,
        staleAfterMs: APPLYING_STALE_MS,
        appliedLineCount: 3,
        totalLineCount: 3,
      }),
      { action: "heal", status: "completed" }
    );
  });

  it("heals to partial_failed when some lines applied after TTL", () => {
    assert.deepEqual(
      decideStaleApplyingAction({
        ageMs: APPLYING_STALE_MS + 1,
        staleAfterMs: APPLYING_STALE_MS,
        appliedLineCount: 1,
        totalLineCount: 3,
      }),
      { action: "heal", status: "partial_failed" }
    );
  });

  it("marks failed for retry when stale with no applied lines", () => {
    assert.deepEqual(
      decideStaleApplyingAction({
        ageMs: APPLYING_STALE_MS + 1,
        staleAfterMs: APPLYING_STALE_MS,
        appliedLineCount: 0,
        totalLineCount: 3,
      }),
      { action: "mark_failed_for_retry" }
    );
  });
});

describe("isDefiniteUnaappliedRejection — no heuristic false-negative re-set", () => {
  it("only userErrors are definite unapplied", () => {
    assert.equal(isDefiniteUnaappliedRejection({ hadUserErrors: true }), true);
    assert.equal(isDefiniteUnaappliedRejection({ hadUserErrors: false }), false);
    assert.equal(isDefiniteUnaappliedRejection({}), false);
    assert.equal(isDefiniteUnaappliedRejection(), false);
  });
});
