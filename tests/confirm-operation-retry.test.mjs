/**
 * 確定ボタンを再度押したとき、履歴未完了なら同じ操作IDを使い、在庫を二重に動かさない。
 * Run: node --test tests/confirm-operation-retry.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appliedOperationFromDraft,
  beginConfirmOperation,
  operationToKeepAfterError,
  resolveConfirmLines,
  saveAppliedOperation,
} from "../extensions/common/confirmOperationRetry.js";
import { applyInventoryChangeToApi } from "../extensions/common/applyInventoryChange.js";

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

describe("history_incomplete then 503 keeps the applied id inside one confirm", () => {
  it("history_incomplete → 503 → 503 still marks inventory applied for the next press", async () => {
    const responses = [
      { status: 200, body: { ok: true, status: "completed", historyIncomplete: true, errorCode: "history_incomplete" } },
      { status: 503, body: { ok: false, error: "unavailable" } },
      { status: 503, body: { ok: false, error: "unavailable" } },
    ];
    const sent = [];
    globalThis.shopify = { session: { getSessionToken: async () => "tok" } };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.appEventId);
      const next = responses[sent.length - 1];
      return { ok: next.status >= 200 && next.status < 300, status: next.status, statusText: "", json: async () => next.body };
    };
    const operation = { entryId: "loss_1", appEventId: "evt_loss_1" };
    const frozen = [{ id: "line-1", inventoryItemId: "101", qty: 1, sku: "A" }];
    let pending = null;
    await assert.rejects(
      () => applyInventoryChangeToApi({
        appEventId: operation.appEventId,
        activity: "loss_entry",
        locationId: "gid://shopify/Location/1",
        entries: [{ inventoryItemId: "101", delta: -1 }],
        retryDelayMs: 0,
      }),
      (error) => {
        pending = operationToKeepAfterError(operation, error, null, frozen);
        return error.inventoryApplied === true;
      }
    );
    assert.deepEqual(sent, ["evt_loss_1", "evt_loss_1", "evt_loss_1"]);
    assert.equal(pending.appEventId, "evt_loss_1");
    const again = beginConfirmOperation(pending, () => {
      throw new Error("must not mint");
    });
    assert.equal(again.reused, true);
    assert.equal(again.operation.appEventId, "evt_loss_1");
  });
});

describe("loss, purchase, and adjustment keep the applied draft across remount", () => {
  const cases = [
    { activity: "loss_entry", key: "stock_transfer_pos_loss_draft_v1" },
    { activity: "purchase_entry", key: "stock_transfer_pos_purchase_draft_v1" },
    { activity: "adjustment", key: "stock_transfer_pos_adjustment_draft_v1" },
  ];

  for (const { activity, key } of cases) {
    it(`${activity} restores the operation id and ignores edited lines`, async () => {
      const storage = {
        data: {},
        async get(k) { return this.data[k] ?? null; },
        async set(k, v) { this.data[k] = v; },
      };
      const frozen = [{ id: "line-1", inventoryItemId: "101", qty: activity === "adjustment" ? 4 : 1, sku: "A", currentQuantity: 5 }];
      const operation = { entryId: `${activity}_1`, appEventId: `evt_${activity}_1`, lines: frozen };
      await saveAppliedOperation(storage, key, operation);

      const remounted = appliedOperationFromDraft(await storage.get(key));
      const begun = beginConfirmOperation(remounted, () => {
        throw new Error("must not mint");
      });
      const edited = [
        { id: "line-1", inventoryItemId: "101", qty: 2, sku: "A" },
        { id: "line-2", inventoryItemId: "999", qty: 3, sku: "B" },
      ];
      const used = resolveConfirmLines(begun.operation, edited);
      assert.equal(begun.reused, true);
      assert.equal(begun.operation.appEventId, `evt_${activity}_1`);
      assert.equal(used.length, 1);
      assert.equal(used[0].inventoryItemId, "101");
      assert.equal(used[0].qty, frozen[0].qty);
    });
  }
});
