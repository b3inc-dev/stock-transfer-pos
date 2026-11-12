/**
 * 確定ボタンを再度押したとき、履歴未完了なら同じ操作IDを使い、在庫を二重に動かさない。
 * Run: node --test tests/confirm-operation-retry.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appliedOperationFromDraft,
  beginConfirmOperation,
  clearLocationDraft,
  operationToKeepAfterError,
  planDraftRestore,
  resolveConfirmLines,
  saveAppliedOperation,
  saveScreenDraft,
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

describe("screen restore does not attach another location's applied operation", () => {
  const screens = [
    { activity: "purchase_entry", key: "stock_transfer_pos_purchase_draft_v1" },
    { activity: "loss_entry", key: "stock_transfer_pos_loss_draft_v1" },
    { activity: "adjustment", key: "stock_transfer_pos_adjustment_draft_v1" },
  ];

  function memoryStorage(initial) {
    return {
      data: { ...initial },
      async get(k) { return this.data[k] ?? null; },
      async set(k, v) { this.data[k] = v; },
    };
  }

  function openProductScreen(saved, currentLocationId) {
    const pendingRef = { current: null };
    const plan = planDraftRestore(saved, currentLocationId);
    if (!plan.restore) return { pendingRef, lines: [], restored: false };
    if (plan.operation) pendingRef.current = plan.operation;
    return { pendingRef, lines: plan.lines, restored: true };
  }

  function confirmAt(screen, currentLocationId, currentLines) {
    let minted = 0;
    const begun = beginConfirmOperation(screen.pendingRef.current, () => {
      minted += 1;
      return { entryId: `new_${minted}`, appEventId: `evt_new_${minted}` };
    });
    const sourceLines = resolveConfirmLines(begun.operation, currentLines);
    return {
      minted,
      reused: begun.reused,
      appEventId: begun.operation.appEventId,
      sourceLines,
      savedLocationId: currentLocationId,
    };
  }

  for (const { activity, key } of screens) {
    it(`${activity} ignores location B and repairs only back at location A`, async () => {
      const originalLines = [{ id: "a", inventoryItemId: "101", qty: 1, sku: "A" }];
      const storage = memoryStorage();
      await saveAppliedOperation(storage, key, {
        entryId: `${activity}_1`,
        appEventId: `evt_${activity}_1`,
        locationId: "gid://shopify/Location/A",
        lines: originalLines,
      });
      const savedAtA = await storage.get(key);
      savedAtA.conds = { locationId: "gid://shopify/Location/A" };

      const atB = openProductScreen(savedAtA, "gid://shopify/Location/B");
      assert.equal(atB.restored, false);
      assert.equal(atB.pendingRef.current, null);
      const bLines = [{ id: "b", inventoryItemId: "202", qty: 3, sku: "B" }];
      const confirmB = confirmAt(atB, "gid://shopify/Location/B", bLines);
      assert.equal(confirmB.reused, false);
      assert.equal(confirmB.minted, 1);
      assert.equal(confirmB.savedLocationId, "gid://shopify/Location/B");
      assert.equal(confirmB.sourceLines[0].inventoryItemId, "202");
      assert.notEqual(confirmB.appEventId, `evt_${activity}_1`);

      await saveScreenDraft(storage, key, {
        conds: { locationId: "gid://shopify/Location/B" },
        lines: bLines,
      }, null);

      const atA = openProductScreen(await storage.get(key), "gid://shopify/Location/A");
      assert.equal(atA.restored, true);
      assert.equal(atA.pendingRef.current.appEventId, `evt_${activity}_1`);
      const confirmA = confirmAt(atA, "gid://shopify/Location/A", bLines);
      assert.equal(confirmA.reused, true);
      assert.equal(confirmA.minted, 0);
      assert.equal(confirmA.appEventId, `evt_${activity}_1`);
      assert.equal(confirmA.savedLocationId, "gid://shopify/Location/A");
      assert.equal(confirmA.sourceLines[0].inventoryItemId, "101");
      assert.equal(confirmA.sourceLines[0].qty, 1);
    });
  }
});

describe("screen save and delete keep the other location's repair", () => {
  const screens = [
    {
      activity: "purchase_entry",
      key: "stock_transfer_pos_purchase_draft_v1",
      file: "extensions/stock-transfer-purchase/src/screens/purchase/PurchaseProductList.jsx",
      draftConst: "PURCHASE_DRAFT_KEY",
    },
    {
      activity: "loss_entry",
      key: "stock_transfer_pos_loss_draft_v1",
      file: "extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx",
      draftConst: "LOSS_DRAFT_KEY",
    },
    {
      activity: "adjustment",
      key: "stock_transfer_pos_adjustment_draft_v1",
      file: "extensions/stock-transfer-adjustment/src/screens/loss/AdjustmentProductList.jsx",
      draftConst: "ADJUSTMENT_DRAFT_KEY",
    },
  ];

  function memoryStorage() {
    return {
      data: {},
      async get(k) { return this.data[k] ?? null; },
      async set(k, v) { this.data[k] = v; },
      async delete(k) { delete this.data[k]; },
    };
  }

  function reopen(storage, key, locationId) {
    return planDraftRestore(storage.data[key], locationId);
  }

  function confirmRepair(plan, editedLines) {
    let minted = 0;
    const begun = beginConfirmOperation(plan.operation, () => {
      minted += 1;
      return { entryId: `new_${minted}`, appEventId: `evt_new_${minted}` };
    });
    return {
      minted,
      reused: begun.reused,
      appEventId: begun.operation.appEventId,
      lines: resolveConfirmLines(begun.operation, editedLines),
    };
  }

  for (const screen of screens) {
    it(`${screen.activity} keeps location A after B success, reset, and history failure`, async () => {
      const src = readFileSync(new URL(`../${screen.file}`, import.meta.url), "utf8");
      assert.match(src, /clearLocationDraft\(/);
      assert.doesNotMatch(src, new RegExp(`storage\\.delete\\(\\s*${screen.draftConst}\\s*\\)`));

      const aLines = [{ id: "a", inventoryItemId: "101", qty: 1, sku: "A" }];
      const bLines = [{ id: "b", inventoryItemId: "202", qty: 4, sku: "B" }];
      const storage = memoryStorage();
      const locationA = "gid://shopify/Location/A";
      const locationB = "gid://shopify/Location/B";

      await saveAppliedOperation(storage, screen.key, {
        entryId: `${screen.activity}_a`,
        appEventId: `evt_${screen.activity}_a`,
        locationId: locationA,
        lines: aLines,
      });
      await saveScreenDraft(storage, screen.key, { conds: { locationId: locationB }, lines: bLines }, null);

      await clearLocationDraft(storage, screen.key, locationB);
      let atA = reopen(storage, screen.key, locationA);
      let repair = confirmRepair(atA, bLines);
      assert.equal(repair.reused, true);
      assert.equal(repair.minted, 0);
      assert.equal(repair.appEventId, `evt_${screen.activity}_a`);
      assert.equal(repair.lines[0].inventoryItemId, "101");
      assert.equal(repair.lines[0].qty, 1);

      await clearLocationDraft(storage, screen.key, locationB);
      atA = reopen(storage, screen.key, locationA);
      assert.equal(atA.operation.appEventId, `evt_${screen.activity}_a`);

      const failed = operationToKeepAfterError(
        { entryId: `${screen.activity}_b`, appEventId: `evt_${screen.activity}_b`, locationId: locationB },
        Object.assign(new Error("history"), { code: "history_incomplete", inventoryApplied: true }),
        null,
        bLines
      );
      await saveAppliedOperation(storage, screen.key, failed);
      atA = reopen(storage, screen.key, locationA);
      const atB = reopen(storage, screen.key, locationB);
      assert.equal(atA.operation.appEventId, `evt_${screen.activity}_a`);
      assert.equal(atB.operation.appEventId, `evt_${screen.activity}_b`);
      assert.notEqual(atA.operation.appEventId, atB.operation.appEventId);
      repair = confirmRepair(atA, bLines);
      assert.equal(repair.reused, true);
      assert.equal(repair.minted, 0);
    });
  }

  it("reads a legacy single appliedOperation draft at its saved location", () => {
    const legacy = {
      conds: { locationId: "gid://shopify/Location/A" },
      lines: [{ id: "a", inventoryItemId: "101", qty: 1 }],
      appliedOperation: {
        entryId: "legacy_1",
        appEventId: "evt_legacy_1",
        lines: [{ id: "a", inventoryItemId: "101", qty: 1 }],
      },
    };
    const atA = planDraftRestore(legacy, "gid://shopify/Location/A");
    const atB = planDraftRestore(legacy, "gid://shopify/Location/B");
    assert.equal(atA.restore, true);
    assert.equal(atA.operation.appEventId, "evt_legacy_1");
    assert.equal(atB.restore, false);
    assert.equal(atB.operation, null);
  });
});

describe("draft writes on one key do not overlap", () => {
  const screens = [
    { activity: "purchase_entry", key: "stock_transfer_pos_purchase_draft_v1" },
    { activity: "loss_entry", key: "stock_transfer_pos_loss_draft_v1" },
    { activity: "adjustment", key: "stock_transfer_pos_adjustment_draft_v1" },
  ];

  function gatingStorage(initial) {
    const box = { value: structuredClone(initial) };
    let firstGet = true;
    let releaseFirstGet = () => {};
    const firstGetStarted = new Promise((resolve) => {
      releaseFirstGet = resolve;
    });
    let releaseFirstGetDone = () => {};
    const firstGetReached = new Promise((resolve) => {
      releaseFirstGetDone = resolve;
    });
    return {
      box,
      releaseFirstGet,
      firstGetReached,
      async get() {
        if (firstGet) {
          firstGet = false;
          releaseFirstGetDone();
          await firstGetStarted;
        }
        return structuredClone(box.value);
      },
      async set(_key, value) {
        box.value = structuredClone(value);
      },
      async delete() {
        box.value = null;
      },
    };
  }

  for (const screen of screens) {
    it(`${screen.activity} keeps the repair when autosave read is stale`, async () => {
      const locationA = "gid://shopify/Location/A";
      const locationB = "gid://shopify/Location/B";
      const aLines = [{ id: "a", inventoryItemId: "101", qty: 1, sku: "A" }];
      const bLines = [{ id: "b", inventoryItemId: "202", qty: 4, sku: "B" }];
      const storage = gatingStorage({
        conds: { locationId: locationA },
        lines: aLines,
        appliedOperationsByLocation: {
          [locationA]: {
            entryId: `${screen.activity}_a`,
            appEventId: `evt_${screen.activity}_a`,
            locationId: locationA,
            lines: aLines,
          },
        },
      });

      const autosave = saveScreenDraft(storage, screen.key, {
        conds: { locationId: locationB },
        lines: bLines,
      }, null);
      await storage.firstGetReached;
      const saved = saveAppliedOperation(storage, screen.key, {
        entryId: `${screen.activity}_b`,
        appEventId: `evt_${screen.activity}_b`,
        locationId: locationB,
        lines: bLines,
      });
      storage.releaseFirstGet();
      await Promise.all([autosave, saved]);

      const reopenedB = planDraftRestore(storage.box.value, locationB);
      const reopenedA = planDraftRestore(storage.box.value, locationA);
      assert.equal(reopenedB.operation?.appEventId, `evt_${screen.activity}_b`);
      assert.equal(reopenedA.operation?.appEventId, `evt_${screen.activity}_a`);
      let minted = 0;
      const again = beginConfirmOperation(reopenedB.operation, () => {
        minted += 1;
        return { entryId: "new", appEventId: "evt_new" };
      });
      assert.equal(again.reused, true);
      assert.equal(minted, 0);
      assert.equal(again.operation.appEventId, `evt_${screen.activity}_b`);
      assert.equal(resolveConfirmLines(again.operation, aLines)[0].inventoryItemId, "202");
    });
  }
});
