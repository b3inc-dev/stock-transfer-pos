/**
 * POS Lite 移行の受入試験を、既存の在庫検証（差分受領・appEventId・Webhookは履歴のみ）へ足す。
 * Run: node --test tests/pos-lite-inventory-acceptance.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INVENTORY_OWNERS,
  inboundPlannedReceiveQuantity,
  inboundCappedReceive,
  lossConfirmFingerprint,
  decideLossConfirmIdentity,
  lossPendingDisposition,
  lossResumeFromPending,
  readLossPendingForLocation,
  writeLossPendingForLocation,
  clearLossPendingForLocation,
  planOnHandWrites,
} from "../extensions/common/posLiteInventoryPlan.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function row(overrides) {
  return {
    shipmentLineItemId: "gid://shopify/InventoryShipmentLineItem/1",
    inventoryItemId: "gid://shopify/InventoryItem/1",
    plannedQty: 10,
    receiveQty: 0,
    alreadyAcceptedQty: 0,
    alreadyOverQty: 0,
    alreadyRejectedQty: 0,
    ...overrides,
  };
}

describe("責任分界: 物理移管と販売注文の倉庫引当", () => {
  it("物理移管は手持ちを動かし、販売注文の引当はアプリが手持ちを動かさない", () => {
    assert.equal(INVENTORY_OWNERS.physical_transfer.id, "physical_transfer");
    assert.equal(INVENTORY_OWNERS.sales_order_allocation.id, "sales_order_allocation");
    assert.match(INVENTORY_OWNERS.sales_order_allocation.mechanism, /手持ちは動かさない/);
  });

  it("受取に伴う店舗間移管は物理移管の1回だけで、注文の引当を重ねて減算しない", () => {
    const physical = planOnHandWrites("pickup_interstore_transfer");
    const allocation = planOnHandWrites("sales_order_allocation");
    assert.equal(physical.length, 1);
    assert.equal(physical[0].owner, "physical_transfer");
    assert.equal(allocation.length, 0);
    assert.equal(physical.length + allocation.length, 1);
  });

  it("配送の出荷元変更は手持ちの書き込みを持たない", () => {
    assert.deepEqual(planOnHandWrites("fulfillment_origin_change"), []);
  });
});

describe("出庫・部分受領・残受領は手持ちを一度だけ", () => {
  it("出庫作成は移管1回で、追加の在庫調整を計画しない", () => {
    const writes = planOnHandWrites("outbound_create");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].op, "transfer_and_shipment");
  });

  it("予定10を4受領し、同じ4の再試行のあと残り6を受領すると合計10", () => {
    const first = inboundPlannedReceiveQuantity(row({ receiveQty: 4, alreadyAcceptedQty: 0 }));
    const retry = inboundPlannedReceiveQuantity(row({ receiveQty: 4, alreadyAcceptedQty: 4 }));
    const rest = inboundPlannedReceiveQuantity(row({ receiveQty: 10, alreadyAcceptedQty: 4 }));
    assert.equal(first, 4);
    assert.equal(retry, 0);
    assert.equal(rest, 6);
    assert.equal(first + retry + rest, 10);
    assert.equal(planOnHandWrites("partial_receive", { row: row({ receiveQty: 4 }) }).length, 1);
    assert.deepEqual(planOnHandWrites("partial_receive", { row: row({ receiveQty: 4, alreadyAcceptedQty: 4 }) }), []);
    assert.equal(planOnHandWrites("remaining_receive", { row: row({ receiveQty: 10, alreadyAcceptedQty: 4 }) })[0].quantity, 6);
  });

  it("予定を超える分は receive に再載せず、超過分だけを分ける", () => {
    const capped = inboundCappedReceive(row({ plannedQty: 10, receiveQty: 12, alreadyAcceptedQty: 0 }));
    assert.equal(capped.quantity, 10);
    assert.equal(capped.overflow, 2);
    assert.equal(capped.quantity + capped.overflow, 12);
  });
});

describe("棚卸・ロス・通信再試行・店舗切替", () => {
  it("棚卸とロスは apply-change を1回だけ計画する", () => {
    const stocktake = planOnHandWrites("stocktake_confirm", { appEventId: "evt_inventory_count_1" });
    const loss = planOnHandWrites("loss_confirm", { appEventId: "evt_loss_entry_1" });
    assert.equal(stocktake.length, 1);
    assert.equal(loss.length, 1);
    assert.equal(stocktake[0].op, "apply-change");
  });

  it("適用済みの通信再試行は追加の手持ち更新を出さない", () => {
    assert.deepEqual(planOnHandWrites("communication_retry", { alreadyApplied: true, appEventId: "evt_1" }), []);
    assert.equal(planOnHandWrites("communication_retry", { alreadyApplied: false, appEventId: "evt_1" }).length, 1);
  });

  it("店舗切替は在庫を動かさない。別店舗の未確認ロスは再利用しない", () => {
    assert.deepEqual(planOnHandWrites("location_switch"), []);
    const fingerprintA = lossConfirmFingerprint({
      locationId: "gid://shopify/Location/1",
      lines: [{ inventoryItemId: "gid://shopify/InventoryItem/9", qty: 2 }],
      reason: "破損",
      date: "2026-11-11",
    });
    let store = writeLossPendingForLocation({}, {
      locationId: "gid://shopify/Location/1",
      lossEntryId: "loss_a",
      appEventId: "evt_loss_entry_loss_a",
      fingerprint: fingerprintA,
    });
    const other = decideLossConfirmIdentity({
      pending: readLossPendingForLocation(store, "gid://shopify/Location/2"),
      fingerprint: lossConfirmFingerprint({
        locationId: "gid://shopify/Location/2",
        lines: [{ inventoryItemId: "gid://shopify/InventoryItem/9", qty: 2 }],
      }),
      locationId: "gid://shopify/Location/2",
      createId: () => "loss_b",
    });
    assert.equal(other.action, "create");
    assert.equal(other.lossEntryId, "loss_b");
    assert.equal(readLossPendingForLocation(store, "gid://shopify/Location/1").lossEntryId, "loss_a");
  });

  it("同じロス内容の再試行は同じID、内容を変えた再確定は止める", () => {
    const lines = [{ inventoryItemId: "gid://shopify/InventoryItem/9", qty: 2 }];
    const fingerprint = lossConfirmFingerprint({
      locationId: "gid://shopify/Location/1",
      lines,
      reason: "破損",
      date: "2026-11-11",
    });
    const created = decideLossConfirmIdentity({
      pending: null,
      fingerprint,
      locationId: "gid://shopify/Location/1",
      createId: () => "loss_once",
    });
    assert.equal(created.action, "create");
    const again = decideLossConfirmIdentity({
      pending: created,
      fingerprint,
      locationId: "gid://shopify/Location/1",
      createId: () => "loss_should_not_be_used",
    });
    assert.equal(again.action, "reuse");
    assert.equal(again.lossEntryId, "loss_once");
    assert.equal(again.appEventId, created.appEventId);
    const changed = decideLossConfirmIdentity({
      pending: created,
      fingerprint: lossConfirmFingerprint({
        locationId: "gid://shopify/Location/1",
        lines: [{ inventoryItemId: "gid://shopify/InventoryItem/9", qty: 3 }],
        reason: "破損",
        date: "2026-11-11",
      }),
      locationId: "gid://shopify/Location/1",
      createId: () => "loss_new",
    });
    assert.equal(changed.action, "block");
    assert.equal(changed.lossEntryId, "loss_once");
    const cleared = clearLossPendingForLocation(
      writeLossPendingForLocation({}, created),
      "gid://shopify/Location/1"
    );
    assert.equal(readLossPendingForLocation(cleared, "gid://shopify/Location/1"), null);
  });

  it("在庫未適用が確定した失敗は pending を外し、内容を直した再確定を許す", () => {
    const failed = lossPendingDisposition({ code: "APPLY_UNAPPLIED", status: "failed", unapplied: true });
    const uncertain = lossPendingDisposition({ code: "APPLY_UNCERTAIN" });
    const pending = lossPendingDisposition({ code: "APPLY_PENDING" });
    const partial = lossPendingDisposition({ code: "APPLY_PARTIAL", partiallyApplied: true });
    const unknown = lossPendingDisposition(new Error("Load failed"));
    assert.equal(failed, "clear");
    assert.equal(uncertain, "keep");
    assert.equal(pending, "keep");
    assert.equal(partial, "keep");
    assert.equal(unknown, "keep");

    const fingerprint = lossConfirmFingerprint({
      locationId: "gid://shopify/Location/1",
      lines: [{ inventoryItemId: "gid://shopify/InventoryItem/9", qty: 2 }],
      reason: "破損",
      date: "2026-11-11",
    });
    const stored = writeLossPendingForLocation({}, {
      locationId: "gid://shopify/Location/1",
      lossEntryId: "loss_failed",
      appEventId: "evt_loss_entry_loss_failed",
      fingerprint,
      lines: [{ inventoryItemId: "gid://shopify/InventoryItem/9", qty: 2 }],
      conds: { locationId: "gid://shopify/Location/1", reason: "破損", date: "2026-11-11" },
    });
    const cleared = clearLossPendingForLocation(stored, "gid://shopify/Location/1");
    const next = decideLossConfirmIdentity({
      pending: readLossPendingForLocation(cleared, "gid://shopify/Location/1"),
      fingerprint: lossConfirmFingerprint({
        locationId: "gid://shopify/Location/1",
        lines: [{ inventoryItemId: "gid://shopify/InventoryItem/8", qty: 1 }],
        reason: "破損",
        date: "2026-11-11",
      }),
      locationId: "gid://shopify/Location/1",
      createId: () => "loss_edited",
    });
    assert.equal(next.action, "create");
    assert.equal(next.lossEntryId, "loss_edited");
  });

  it("未確認ロスは店舗別に明細と条件を復元でき、同じ指紋になる", () => {
    const lines = [{ id: "row-1", inventoryItemId: "gid://shopify/InventoryItem/9", qty: 2, sku: "A" }];
    const conds = {
      locationId: "gid://shopify/Location/1",
      locationName: "店舗A",
      date: "2026-11-11",
      reason: "破損",
      staffName: "担当",
    };
    const fingerprint = lossConfirmFingerprint({ locationId: conds.locationId, lines, reason: conds.reason, date: conds.date });
    let store = writeLossPendingForLocation({}, {
      locationId: conds.locationId,
      lossEntryId: "loss_a",
      appEventId: "evt_loss_entry_loss_a",
      fingerprint,
      lines,
      conds,
    });
    store = writeLossPendingForLocation(store, {
      locationId: "gid://shopify/Location/2",
      lossEntryId: "loss_b",
      appEventId: "evt_loss_entry_loss_b",
      fingerprint: "other",
      lines: [{ inventoryItemId: "gid://shopify/InventoryItem/3", qty: 1 }],
      conds: { locationId: "gid://shopify/Location/2", reason: "紛失", date: "2026-11-12" },
    });
    const resume = lossResumeFromPending(readLossPendingForLocation(store, "gid://shopify/Location/1"));
    assert.equal(resume.lines[0].inventoryItemId, "gid://shopify/InventoryItem/9");
    assert.equal(resume.lines[0].qty, 2);
    assert.equal(resume.conds.reason, "破損");
    assert.equal(resume.conds.date, "2026-11-11");
    assert.equal(
      lossConfirmFingerprint({
        locationId: resume.conds.locationId,
        lines: resume.lines,
        reason: resume.conds.reason,
        date: resume.conds.date,
      }),
      fingerprint
    );
    assert.equal(readLossPendingForLocation(store, "gid://shopify/Location/2").lossEntryId, "loss_b");
  });
});

describe("注文Webhookは手持ち在庫を更新しない", () => {
  const forbidden = [
    "inventoryAdjustQuantities",
    "inventorySetQuantities",
    "inventoryTransferCreate",
    "inventoryShipmentReceive",
    "fulfillmentOrderMove",
  ];
  for (const file of [
    "app/routes/webhooks.orders.updated.tsx",
    "app/routes/webhooks.inventory_levels.update.tsx",
    "app/routes/webhooks.refunds.create.tsx",
  ]) {
    it(`${file} に在庫mutationが無い`, () => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      for (const name of forbidden) {
        assert.equal(source.includes(name), false, `${file} contains ${name}`);
      }
    });
  }
});

describe("本番経路が受入判定を使う", () => {
  it("入庫の予定差分は共通関数を通る", () => {
    const source = fs.readFileSync(
      path.join(root, "extensions/stock-transfer-inbound/src/screens/InboundListScreen.jsx"),
      "utf8"
    );
    assert.equal(source.includes("inboundPlannedReceiveQuantity"), true);
    assert.equal(source.includes("inboundCappedReceive"), true);
  });

  it("ロス確定は保存済みIDと同一IDの再照会を使う", () => {
    const source = fs.readFileSync(
      path.join(root, "extensions/stock-transfer-loss/src/screens/loss/LossProductList.jsx"),
      "utf8"
    );
    assert.equal(source.includes("decideLossConfirmIdentity"), true);
    assert.equal(source.includes("recoverUncertain: true"), true);
    assert.equal(source.includes("lossPendingDisposition"), true);
    assert.equal(source.includes("lossResumeFromPending"), true);
    assert.equal(source.includes("snapshotLossLines"), true);
  });
});
