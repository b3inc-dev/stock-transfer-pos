/**
 * 確定ボタンを再度押したとき、履歴未完了なら同じ操作IDを使い、在庫を二重に動かさない。
 * Run: node --test tests/confirm-operation-retry.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beginConfirmOperation,
  operationToKeepAfterError,
} from "../extensions/common/confirmOperationRetry.js";

function pressConfirm(state, mint) {
  const begun = beginConfirmOperation(state.pending, mint);
  state.last = begun.operation;
  return begun;
}

function historyError() {
  return Object.assign(new Error("history"), { code: "history_incomplete", inventoryApplied: true });
}

/**
 * 確定ボタンの連続押下。新しい appEventId の初回だけ在庫を動かし、同じ ID は履歴修復にする。
 */
function pressSequence(outcomes) {
  let pending = null;
  let minted = 0;
  const stockMutations = [];
  const sentIds = [];
  for (const outcome of outcomes) {
    const begun = beginConfirmOperation(pending, () => {
      minted += 1;
      return { entryId: `loss_${minted}`, appEventId: `evt_${minted}` };
    });
    sentIds.push(begun.operation.appEventId);
    if (!stockMutations.includes(begun.operation.appEventId)) {
      stockMutations.push(begun.operation.appEventId);
    }
    if (outcome === "ok") {
      pending = null;
    } else if (outcome === "history_incomplete") {
      pending = operationToKeepAfterError(begun.operation, historyError(), pending);
    } else {
      pending = operationToKeepAfterError(begun.operation, new Error(outcome), pending);
    }
  }
  return { pending, minted, stockMutations, sentIds };
}

describe("confirm button retry after history_incomplete", () => {
  it("reuses the applied operation id on the next press and mints a new one only after success", () => {
    const state = { pending: null, last: null };
    let minted = 0;
    const mint = () => {
      minted += 1;
      return { entryId: `loss_${minted}`, appEventId: `evt_loss_${minted}` };
    };

    const first = pressConfirm(state, mint);
    assert.equal(first.reused, false);
    assert.equal(first.operation.appEventId, "evt_loss_1");
    state.pending = operationToKeepAfterError(
      first.operation,
      Object.assign(new Error("history"), { code: "history_incomplete", inventoryApplied: true })
    );

    const second = pressConfirm(state, mint);
    assert.equal(second.reused, true);
    assert.equal(second.operation.entryId, first.operation.entryId);
    assert.equal(second.operation.appEventId, first.operation.appEventId);
    assert.equal(minted, 1);

    state.pending = null;
    const third = pressConfirm(state, mint);
    assert.equal(third.reused, false);
    assert.equal(third.operation.appEventId, "evt_loss_2");
    assert.equal(minted, 2);
  });

  it("mints a new id when the previous failure did not apply inventory", () => {
    const state = { pending: null };
    let minted = 0;
    const mint = () => {
      minted += 1;
      return { entryId: `purchase_${minted}`, appEventId: `evt_purchase_${minted}` };
    };
    const first = pressConfirm(state, mint);
    state.pending = operationToKeepAfterError(first.operation, new Error("validation"));
    assert.equal(state.pending, null);
    const second = pressConfirm(state, mint);
    assert.equal(second.reused, false);
    assert.notEqual(second.operation.appEventId, first.operation.appEventId);
    assert.equal(minted, 2);
  });

  it("second confirm reuses the applied id, so stock moves once", () => {
    const fixed = pressSequence(["history_incomplete", "ok"]);
    assert.deepEqual(fixed.sentIds, ["evt_1", "evt_1"]);
    assert.deepEqual(fixed.stockMutations, ["evt_1"]);
    assert.equal(fixed.minted, 1);
    assert.equal(fixed.pending, null);

    const mintedEveryPress = ["evt_1", "evt_2"];
    assert.notDeepEqual(fixed.sentIds, mintedEveryPress);
  });

  it("keeps the applied id when a later press fails for another reason", () => {
    const run = pressSequence(["history_incomplete", "local_save_failed", "ok"]);
    assert.deepEqual(run.sentIds, ["evt_1", "evt_1", "evt_1"]);
    assert.deepEqual(run.stockMutations, ["evt_1"]);
    assert.equal(run.pending, null);
  });
});
