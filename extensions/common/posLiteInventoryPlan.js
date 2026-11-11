/**
 * POS Lite での在庫更新の責任分界と、1操作につき手持ち在庫を一度だけ動かす判定。
 * 販売注文の引当（committed）は Shopify の注文が持ち、このモジュールは手持ち（on-hand）の書き込みだけを数える。
 */
import { buildStableAppEventId } from "./buildStableAppEventId.js";

export const LOSS_PENDING_CONFIRM_KEY = "stock_transfer_pos_loss_pending_confirm_v1";

/** 手持ち在庫を動かす主体。販売注文の引当はここには含めない。 */
export const INVENTORY_OWNERS = {
  physical_transfer: {
    id: "physical_transfer",
    holds: "店舗間の手持ち在庫の移動",
    mechanism: "InventoryTransfer / InventoryShipment",
  },
  sales_order_allocation: {
    id: "sales_order_allocation",
    holds: "販売注文の倉庫引当（committed）と出荷元の割り当て",
    mechanism: "Shopifyの注文・フルフィルメント。アプリは履歴の記録だけを行い、手持ちは動かさない",
  },
};

/**
 * 予定数量の受領差分。既受領・予定超過分は送らない。
 * 部分受領のあと、同じ数量の再試行は 0。残受領は未受領分だけ。
 */
export function inboundPlannedReceiveQuantity(row) {
  const targetAccepted = Math.max(0, Math.floor(Number(row?.receiveQty || 0)));
  const alreadyAccepted = Math.max(0, Math.floor(Number(row?.alreadyAcceptedQty || 0)));
  const alreadyOver = Math.max(0, Math.floor(Number(row?.overAcceptedQty || 0)));
  const alreadyTotal = alreadyAccepted + alreadyOver;
  return Math.max(0, targetAccepted - alreadyTotal);
}

/**
 * 受領APIが数量超過を返したときの上限。予定内は receive、超過分だけ overflow。
 * 同じ数量を receive と overflow の両方には載せない。
 */
export function inboundCappedReceive(row) {
  const shipmentLineItemId = String(row?.shipmentLineItemId || "").trim();
  const inventoryItemId = String(row?.inventoryItemId || "").trim();
  const planned = Math.max(0, Math.floor(Number(row?.plannedQty || 0)));
  const alreadyRejected = Math.max(0, Math.floor(Number(row?.alreadyRejectedQty || 0)));
  const alreadyAccepted = Math.max(0, Math.floor(Number(row?.alreadyAcceptedQty || 0)));
  const wantDelta = inboundPlannedReceiveQuantity(row);
  const remainingReceivable = Math.max(0, planned - alreadyRejected - alreadyAccepted);
  const quantity = Math.min(remainingReceivable, wantDelta);
  const overflow = Math.max(0, wantDelta - quantity);
  return { shipmentLineItemId, inventoryItemId, quantity, overflow };
}

export function lossConfirmFingerprint({ locationId, lines, reason = "", date = "" }) {
  const loc = String(locationId || "").trim();
  const body = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      id: String(line?.inventoryItemId || "").trim(),
      qty: Math.abs(Number(line?.qty ?? line?.quantity ?? 0)),
    }))
    .filter((line) => line.id && line.qty > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((line) => `${line.id}:${line.qty}`)
    .join(",");
  return `${loc}|${String(date || "").trim()}|${String(reason || "").trim()}|${body}`;
}

function lossIdentity(lossEntryId, fingerprint, locationId) {
  const id = String(lossEntryId || "").trim();
  return {
    lossEntryId: id,
    appEventId: buildStableAppEventId("loss_entry", id),
    fingerprint,
    locationId: String(locationId || "").trim(),
  };
}

/**
 * 同じ店舗・同じ内容のロス再確定は保存済みIDを再利用する。
 * 結果が未確認のあいだに数量・日付・理由が変わった再確定は止める。
 * 別店舗の未確認は、その店舗の確定には使わない。
 */
export function decideLossConfirmIdentity({ pending, fingerprint, locationId, createId }) {
  const loc = String(locationId || "").trim();
  const pendingLoc = String(pending?.locationId || "").trim();
  const pendingId = String(pending?.lossEntryId || "").trim();
  const samePlace = Boolean(pendingId) && pendingLoc === loc && pendingLoc !== "";
  if (!samePlace) {
    return { action: "create", ...lossIdentity(createId(), fingerprint, loc) };
  }
  const identity = lossIdentity(pendingId, pending.fingerprint || fingerprint, loc);
  if (String(pending.fingerprint || "") !== String(fingerprint || "")) {
    return { action: "block", reason: "content_changed_while_unknown", ...identity };
  }
  return { action: "reuse", ...identity, fingerprint };
}

export function readLossPendingForLocation(store, locationId) {
  const loc = String(locationId || "").trim();
  if (!loc || !store || typeof store !== "object") return null;
  const entry = store[loc];
  if (!entry || typeof entry !== "object") return null;
  if (!String(entry.lossEntryId || "").trim()) return null;
  return entry;
}

export function snapshotLossLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      id: String(line?.id || ""),
      qty: Math.abs(Number(line?.qty ?? line?.quantity ?? 0)),
      variantId: line?.variantId ?? null,
      inventoryItemId: String(line?.inventoryItemId || "").trim(),
      sku: String(line?.sku || ""),
      barcode: String(line?.barcode || ""),
      productTitle: String(line?.productTitle || ""),
      variantTitle: String(line?.variantTitle || ""),
      imageUrl: String(line?.imageUrl || ""),
    }))
    .filter((line) => line.inventoryItemId && line.qty > 0);
}

export function snapshotLossConds(conds) {
  return {
    locationId: String(conds?.locationId || "").trim(),
    locationName: String(conds?.locationName || ""),
    date: String(conds?.date || ""),
    reason: String(conds?.reason || ""),
    staffMemberId: conds?.staffMemberId ?? null,
    staffName: conds?.staffName ?? null,
  };
}

export function lossResumeFromPending(pending) {
  const lines = snapshotLossLines(pending?.lines);
  if (lines.length === 0) return null;
  const conds = snapshotLossConds(pending?.conds || { locationId: pending?.locationId });
  return { lines, conds };
}

/**
 * 在庫未適用が応答で確定した失敗だけ pending を外す。
 * 応答不明・処理中・一部適用は残し、内容を変えた再確定を止めたままにする。
 */
export function lossPendingDisposition(error) {
  const code = String(error?.code || "");
  if (code === "APPLY_PARTIAL" || code === "APPLY_PENDING" || code === "APPLY_UNCERTAIN") return "keep";
  if (error?.partiallyApplied === true) return "keep";
  if (code === "APPLY_UNAPPLIED" || error?.unapplied === true) return "clear";
  if (error?.status === "failed") return "clear";
  return "keep";
}

export function writeLossPendingForLocation(store, entry) {
  const loc = String(entry?.locationId || "").trim();
  const next = { ...(store && typeof store === "object" ? store : {}) };
  if (!loc) return next;
  next[loc] = {
    lossEntryId: String(entry.lossEntryId || "").trim(),
    appEventId: String(entry.appEventId || "").trim(),
    fingerprint: String(entry.fingerprint || ""),
    locationId: loc,
    lines: snapshotLossLines(entry.lines),
    conds: snapshotLossConds(entry.conds || { locationId: loc }),
  };
  return next;
}

export function clearLossPendingForLocation(store, locationId) {
  const loc = String(locationId || "").trim();
  const next = { ...(store && typeof store === "object" ? store : {}) };
  delete next[loc];
  return next;
}

/**
 * このアプリが手持ち在庫へ出す書き込み。0件または1件。
 * 販売注文の引当と出荷元変更は 0 件（Shopify の注文が committed を一度動かす）。
 */
export function planOnHandWrites(type, input = {}) {
  switch (type) {
    case "outbound_create":
      return [{ owner: "physical_transfer", op: "transfer_and_shipment" }];
    case "partial_receive":
    case "remaining_receive": {
      const quantity = inboundPlannedReceiveQuantity(input.row || input);
      return quantity > 0
        ? [{ owner: "physical_transfer", op: "inventoryShipmentReceive", quantity, reason: "ACCEPTED" }]
        : [];
    }
    case "stocktake_confirm":
    case "loss_confirm":
      return [{ owner: "app_adjustment", op: "apply-change", appEventId: String(input.appEventId || "") }];
    case "communication_retry":
      if (input.alreadyApplied) return [];
      return [{ owner: "app_adjustment", op: "apply-change", appEventId: String(input.appEventId || "") }];
    case "location_switch":
    case "fulfillment_origin_change":
    case "sales_order_allocation":
      return [];
    case "pickup_interstore_transfer":
      return [{ owner: "physical_transfer", op: "transfer_and_shipment" }];
    default:
      throw new Error(`unknown on-hand plan: ${type}`);
  }
}
