import { renderReservationReceipt } from "./reservationReceipt.js";
/** Pure rules shared by server and POS; no PII in error messages. */
export const RESERVATION_LABELS = Object.freeze({ reserving: "確認中", held: "取置中", checkout: "会計中", cancelling: "確認中", completing: "確認中", sold: "販売完了", cancelled: "キャンセル", failed: "登録できませんでした" });
export const TERMINAL_RESERVATIONS = ["sold", "cancelled", "failed"];
export const RESERVATION_PROPERTY = "取置番号";
export const CHECKOUT_PROPERTY = "_pos_stock_reservation_checkout";
export function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const get = type => parts.find(p => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function addDays(day, days) {
  if (!validDate(day) || !Number.isInteger(days) || days < 1 || days > 365) throw new Error("標準取置日数は1〜365日の整数にしてください");
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function needsFollowUp(row, now = Date.now()) {
  if (TERMINAL_RESERVATIONS.includes(row.status)) return false;
  if (row.status !== "held" && row.status !== "checkout") return true;
  return (row.nextFollowDate || row.dueDate) <= localDate(now, row.timezone);
}
export function maskPhone(phone) {
  return phone ? `•••• ${String(phone).replace(/\D/g, "").slice(-4)}` : "—";
}
export function normalizeReservationLines(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 250) throw new Error("商品は1〜250明細で指定してください");
  const seen = new Set();
  return input.map(line => {
    const variantId = String(line?.variantId || "");
    const quantity = Number(line?.quantity);
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999 || seen.has(variantId)) throw new Error("商品と数量を確認してください（重複商品・不正な数量があります）");
    seen.add(variantId);
    return { variantId, quantity };
  });
}
export function assertOrderMatches(row, order) {
  const attr = key => order?.customAttributes?.find(a => a.key === key)?.value;
  if (!order || order.cancelledAt || order.displayFinancialStatus !== "PAID" || order.displayFulfillmentStatus !== "FULFILLED" || order.sourceName !== "pos" || order.retailLocation?.id !== row.locationId || attr(RESERVATION_PROPERTY) !== row.id || attr(CHECKOUT_PROPERTY) !== row.checkoutKey) throw new Error("決済済みの同じ店舗の取置注文を確認できません");
  if (row.customerId && order.customer?.id !== row.customerId) throw new Error("注文の顧客が取置と一致しません");
  if (order.lineItems?.pageInfo?.hasNextPage || order.refunds?.length) throw new Error("返品または明細のある注文を管理者が確認してください");
  const fulfilled = new Map();
  if (!order.fulfillments?.length) throw new Error("POS注文の在庫減算を確認できません");
  for (const fulfillment of order.fulfillments) {
    if (fulfillment.location?.id !== row.locationId || fulfillment.fulfillmentLineItems?.pageInfo?.hasNextPage) throw new Error("注文の出荷店舗を確認してください");
    for (const item of fulfillment.fulfillmentLineItems?.nodes || []) {
      const id = item.lineItem?.variant?.id;
      fulfilled.set(id, (fulfilled.get(id) || 0) + item.quantity);
    }
  }
  if (row.lines.some(line => fulfilled.get(line.variantId) !== line.quantity)) throw new Error("取置商品の在庫減算を確認できません");
  const items = order.lineItems?.nodes || [];
  const actual = new Map();
  for (const line of items) {
    if (!line.variant?.id || line.quantity !== line.currentQuantity) throw new Error("注文の商品・数量が変更されています");
    actual.set(line.variant.id, (actual.get(line.variant.id) || 0) + line.quantity);
  }
  if (actual.size !== row.lines.length || row.lines.some(line => actual.get(line.variantId) !== line.quantity)) throw new Error("注文の商品・数量が取置と一致しません");
}
export function cartCanReceive(row, cart) {
  if (!cart || cart.editable === false) throw new Error("カートを編集できません");
  const props = cart.properties || {};
  const same = props[RESERVATION_PROPERTY] === row.id && props[CHECKOUT_PROPERTY] === row.checkoutKey;
  if (!same && ((cart.lineItems || []).length || Object.keys(props).length || (cart.customer && String(cart.customer.id) !== String(row.customerId || "").split("/").pop()))) throw new Error("ほかのお客様のカートがあります。空のカートから開いてください");
  if (cart.customer && String(cart.customer.id) !== String(row.customerId || "").split("/").pop()) throw new Error("カートの顧客が取置と一致しません");
  const counts = new Map();
  for (const line of cart.lineItems || []) {
    const variantId = `gid://shopify/ProductVariant/${line.variantId}`;
    if (!row.lines.some(item => item.variantId === variantId)) throw new Error("取置以外の商品がカートにあります");
    counts.set(variantId, (counts.get(variantId) || 0) + line.quantity);
  }
  if (row.lines.some(line => (counts.get(line.variantId) || 0) > line.quantity)) throw new Error("カートの数量が取置を超えています");
  return row.lines.map(line => ({ ...line, quantity: line.quantity - (counts.get(line.variantId) || 0) })).filter(line => line.quantity > 0);
}
export function receiptHtml(row, layout) { return renderReservationReceipt(row, layout); }

/** A marked cart precedes the server claim, so a lost claim response can resume without releasing stock. */
export async function handoffReservationCart(detail, pos, api, update = () => {}) {
  let row = detail;
  const cart = pos.cart.current.value;
  const checkoutKey = row.checkoutKey || (cart.properties?.[RESERVATION_PROPERTY] === row.id ? cart.properties[CHECKOUT_PROPERTY] : null) || crypto.randomUUID();
  cartCanReceive({ ...row, checkoutKey }, cart);
  const deviceId = String(pos.session.deviceId);
  if (row.status === "checkout" && (cart.properties?.[CHECKOUT_PROPERTY] !== row.checkoutKey || cart.properties?.[RESERVATION_PROPERTY] !== row.id)) throw new Error("会計用カートが見つかりません。二重会計を防ぐため、注文を照合してください");
  if (row.status === "held") {
    await pos.cart.addCartProperties({ [RESERVATION_PROPERTY]: row.id, [CHECKOUT_PROPERTY]: checkoutKey });
    try {
      const result = await api({ command: "checkout", id: row.id, version: row.version, deviceId, checkoutKey });
      row = result.row; update(row);
    } catch (error) {
      const current = pos.cart.current.value;
      if (error.checkoutRejected === true && !current.lineItems?.length && current.properties?.[RESERVATION_PROPERTY] === row.id && current.properties?.[CHECKOUT_PROPERTY] === checkoutKey) {
        await pos.cart.removeCartProperties([RESERVATION_PROPERTY, CHECKOUT_PROPERTY]);
      }
      throw error;
    }
  }
  if (row.status !== "checkout" || row.checkoutDevice !== deviceId) throw new Error("別の端末で会計中です。元の端末から再開してください");
  const assertSameCart = () => {
    const current = pos.cart.current.value;
    if (current.properties?.[RESERVATION_PROPERTY] !== row.id || current.properties?.[CHECKOUT_PROPERTY] !== row.checkoutKey) throw new Error("会計中にカートが切り替わりました。元の取置カートから再開してください");
    cartCanReceive(row, current);
    return current;
  };
  const current = assertSameCart();
  if (row.customerId && !current.customer) await pos.cart.setCustomer({ id: Number(row.customerId.split("/").pop()) });
  for (const target of row.lines) {
    // Native cart updates can arrive between awaited additions. Re-read before each item.
    const line = cartCanReceive(row, assertSameCart()).find(item => item.variantId === target.variantId);
    if (!line) continue;
    const uuid = await pos.cart.addLineItem(Number(line.variantId.split("/").pop()), line.quantity);
    if (!uuid) throw new Error("商品をカートに追加できませんでした。同じ取置から会計を再開してください");
  }
  if (cartCanReceive(row, assertSameCart()).length) throw new Error("全商品を引き継げませんでした。同じ取置から再開してください");
  return row;
}
