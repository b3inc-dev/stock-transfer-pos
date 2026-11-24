import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, assertOrderMatches, cartCanReceive, CHECKOUT_PROPERTY, localDate, maskPhone, needsFollowUp, normalizeReservationLines, receiptHtml, RESERVATION_PROPERTY } from "../extensions/common/reservations.js";
const variantId = "gid://shopify/ProductVariant/1";
const row = { id: "R-1", locationId: "gid://shopify/Location/1", locationName: "店<script>", timezone: "Asia/Tokyo", status: "held", dueDate: "2026-11-25", lines: [{ variantId, title: "<Tシャツ>", quantity: 2 }], checkoutKey: "key", createdAt: "2026-11-23T12:00:00Z", createdBy: "123" };
function order() { return { cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", sourceName: "pos", retailLocation: { id: row.locationId }, customAttributes: [{ key: RESERVATION_PROPERTY, value: row.id }, { key: CHECKOUT_PROPERTY, value: row.checkoutKey }], refunds: [], lineItems: { nodes: [{ variant: { id: variantId }, quantity: 2, currentQuantity: 2 }], pageInfo: { hasNextPage: false } }, fulfillments: [{ location: { id: row.locationId }, fulfillmentLineItems: { nodes: [{ lineItem: { variant: { id: variantId } }, quantity: 2 }], pageInfo: { hasNextPage: false } } }] }; }
test("store local date, year boundary and DST use calendar days", () => {
  assert.equal(localDate("2026-11-24T15:00:00Z", "Asia/Tokyo"), "2026-11-25");
  assert.equal(localDate("2026-11-24T15:00:00Z", "America/Los_Angeles"), "2026-11-24");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-07", 2), "2026-03-09");
  assert.throws(() => addDays("2026-02-30", 7));
});
test("due from local midnight; planned date supersedes deadline; terminal cases never due", () => {
  assert.equal(needsFollowUp(row, Date.parse("2026-11-24T14:59:59Z")), false);
  assert.equal(needsFollowUp(row, Date.parse("2026-11-24T15:00:00Z")), true);
  assert.equal(needsFollowUp({ ...row, nextFollowDate: "2026-11-27" }, Date.parse("2026-11-25T15:00:00Z")), false);
  assert.equal(needsFollowUp({ ...row, status: "sold" }, Date.parse("2027-01-01")), false);
  assert.equal(needsFollowUp({ ...row, status: "reserving" }), true);
});
test("validate all quantities and prevent duplicate variant/overflow/chunking", () => {
  assert.deepEqual(normalizeReservationLines([{ variantId, quantity: 2 }]), [{ variantId, quantity: 2 }]);
  for (const quantity of [0, -1, 1.5, NaN, 10000]) assert.throws(() => normalizeReservationLines([{ variantId, quantity }]));
  assert.throws(() => normalizeReservationLines([{ variantId, quantity: 1 }, { variantId, quantity: 2 }]));
  assert.throws(() => normalizeReservationLines(Array.from({ length: 251 }, (_, i) => ({ variantId: `gid://shopify/ProductVariant/${i}`, quantity: 1 }))));
});
test("only exact fully paid fulfilled POS order at same store can finish", () => {
  assert.doesNotThrow(() => assertOrderMatches(row, order()));
  for (const mutation of [
    o => { o.displayFinancialStatus = "PARTIALLY_PAID"; }, o => { o.cancelledAt = "2026-11-25"; },
    o => { o.retailLocation.id = "gid://shopify/Location/2"; }, o => { o.sourceName = "web"; },
    o => { o.lineItems.nodes[0].currentQuantity = 1; }, o => { o.lineItems.nodes[0].quantity = 3; },
    o => { o.lineItems.pageInfo.hasNextPage = true; }, o => { o.refunds = [{ id: "refund" }]; },
    o => { o.customAttributes[1].value = "other"; }, o => { o.displayFulfillmentStatus = "UNFULFILLED"; },
    o => { o.fulfillments[0].location.id = "other"; }, o => { o.fulfillments[0].fulfillmentLineItems.nodes[0].quantity = 1; },
  ]) { const value = order(); mutation(value); assert.throws(() => assertOrderMatches(row, value)); }
  assert.throws(() => assertOrderMatches({ ...row, customerId: "customer1" }, { ...order(), customer: { id: "customer2" } }));
});
test("cart isolation and interrupted add only supplies missing quantity", () => {
  assert.equal(cartCanReceive(row, { editable: true, lineItems: [], properties: {} })[0].quantity, 2);
  assert.throws(() => cartCanReceive(row, { lineItems: [{ variantId: 1, quantity: 1 }], properties: {} }));
  assert.throws(() => cartCanReceive(row, { lineItems: [], properties: {}, customer: { id: 9 } }));
  const cart = { properties: { [RESERVATION_PROPERTY]: row.id, [CHECKOUT_PROPERTY]: row.checkoutKey }, lineItems: [{ variantId: 1, quantity: 1 }] };
  assert.equal(cartCanReceive(row, cart)[0].quantity, 1);
  assert.throws(() => cartCanReceive(row, { ...cart, lineItems: [{ variantId: 1, quantity: 3 }] }));
  assert.deepEqual(cartCanReceive(row, { ...cart, lineItems: [{ variantId: 1, quantity: 2 }] }), []);
});
test("receipt escapes HTML and excludes customer PII and money", () => {
  const html = receiptHtml({ ...row, guestName: "Private Name", contactPhone: "+819012345678", customerId: "secret-customer" });
  assert.ok(html.includes("&lt;Tシャツ&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!/Private Name|819012345678|secret-customer/.test(html));
  assert.equal(maskPhone("09012345678"), "•••• 5678");
});
test("claim response lost after server commit leaves a resumable marked cart; interrupted adds do not double", async () => {
  const { handoffReservationCart } = await import("../extensions/common/reservations.js");
  let saved;
  let loseResponse = true;
  const cart = { properties: {}, lineItems: [], editable: true };
  const pos = { session: { deviceId: 1 }, cart: { current: { value: cart },
    async addCartProperties(props) { Object.assign(cart.properties, props); },
    async setCustomer(customer) { cart.customer = customer; },
    async addLineItem(variantId, quantity) { cart.lineItems.push({ variantId, quantity }); return "line"; } } };
  const api = async input => { saved = { ...row, status: "checkout", checkoutDevice: "1", checkoutKey: input.checkoutKey }; if (loseResponse) { loseResponse = false; throw new Error("lost"); } return { row: saved }; };
  const held = { ...row, checkoutKey: null };
  await assert.rejects(handoffReservationCart(held, pos, api), /lost/);
  assert.equal(cart.properties[CHECKOUT_PROPERTY], saved.checkoutKey);
  await handoffReservationCart(saved, pos, api);
  await handoffReservationCart(saved, pos, api);
  assert.equal(cart.lineItems.length, 1); assert.equal(cart.lineItems[0].quantity, 2);
  cart.lineItems = []; cart.properties = {};
  await assert.rejects(handoffReservationCart(saved, pos, api), /会計用カート/);
});
test("an empty cart with the same preselected customer is compatible", () => {
  assert.equal(cartCanReceive({ ...row, customerId: "gid://shopify/Customer/9" }, { properties: {}, lineItems: [], customer: { id: 9 } })[0].quantity, 2);
});
test("native cart switch while awaiting server claim cannot change another customer's cart", async () => {
  const { handoffReservationCart } = await import("../extensions/common/reservations.js");
  const cart = { properties: {}, lineItems: [], editable: true };
  let customerWrites = 0, lineWrites = 0;
  const pos = { session: { deviceId: 1 }, cart: { current: { value: cart },
    async addCartProperties(props) { Object.assign(cart.properties, props); },
    async setCustomer() { customerWrites++; }, async addLineItem() { lineWrites++; return "line"; } } };
  const api = async input => { pos.cart.current.value = { properties: {}, lineItems: [], customer: { id: 999 } }; return { row: { ...row, customerId: "gid://shopify/Customer/9", status: "checkout", checkoutDevice: "1", checkoutKey: input.checkoutKey } }; };
  await assert.rejects(handoffReservationCart({ ...row, checkoutKey: null, customerId: "gid://shopify/Customer/9" }, pos, api), /カートが切り替わりました/);
  assert.equal(customerWrites, 0); assert.equal(lineWrites, 0);
});
test("definite claim rejection removes only its empty cart markers, unknown response preserves them", async () => {
  const { handoffReservationCart } = await import("../extensions/common/reservations.js");
  for (const definite of [true, false]) {
    const cart = { properties: {}, lineItems: [], editable: true };
    const pos = { session: { deviceId: 1 }, cart: { current: { value: cart }, async addCartProperties(props) { Object.assign(cart.properties, props); }, async removeCartProperties(keys) { keys.forEach(key => delete cart.properties[key]); } } };
    const api = async () => { throw Object.assign(new Error("claim failed"), { checkoutRejected: definite }); };
    await assert.rejects(handoffReservationCart({ ...row, checkoutKey: null }, pos, api), /claim failed/);
    assert.equal(Boolean(cart.properties[RESERVATION_PROPERTY]), !definite);
  }
});

test("purchasing from a hold detail adds all variants and quantities, but does not complete the sale", async () => {
  const { handoffReservationCart } = await import("../extensions/common/reservations.js");
  const detail = { ...row, checkoutKey: null, customerId: "gid://shopify/Customer/9", lines: [...row.lines, { variantId: "gid://shopify/ProductVariant/2", quantity: 3 }] };
  const cart = { properties: {}, lineItems: [], customer: { id: 9 }, editable: true };
  const commands = [];
  const pos = { session: { deviceId: 1 }, cart: { current: { value: cart },
    async addCartProperties(props) { Object.assign(cart.properties, props); },
    async setCustomer() { throw new Error("should preserve the selected customer"); },
    async addLineItem(variantId, quantity) { cart.lineItems.push({ variantId, quantity }); return `line-${variantId}`; } } };
  const api = async input => { commands.push(input.command); return { row: { ...detail, status: "checkout", checkoutKey: input.checkoutKey, checkoutDevice: "1" } }; };
  const result = await handoffReservationCart(detail, pos, api);
  assert.deepEqual(cart.lineItems, [{ variantId: 1, quantity: 2 }, { variantId: 2, quantity: 3 }]);
  assert.deepEqual(commands, ["checkout"]); assert.equal(result.status, "checkout");
  assert.equal(cart.properties[RESERVATION_PROPERTY], detail.id); assert.equal(cart.customer.id, 9);
});

test("partial cart addition with a lost response resumes missing variants without duplication", async () => {
  const { handoffReservationCart } = await import("../extensions/common/reservations.js");
  const detail = { ...row, checkoutKey: null, lines: [...row.lines, { variantId: "gid://shopify/ProductVariant/2", quantity: 3 }] };
  const cart = { properties: {}, lineItems: [], editable: true };
  let saved, loseResponse = true;
  const writes = [];
  const pos = { session: { deviceId: 1 }, cart: { current: { value: cart },
    async addCartProperties(props) { Object.assign(cart.properties, props); },
    async addLineItem(variantId, quantity) {
      cart.lineItems.push({ variantId, quantity }); writes.push(variantId);
      if (loseResponse) { loseResponse = false; throw new Error("response lost after first addition"); }
      return `line-${variantId}`;
    } } };
  const api = async input => { saved = { ...detail, status: "checkout", checkoutKey: input.checkoutKey, checkoutDevice: "1" }; return { row: saved }; };
  await assert.rejects(handoffReservationCart(detail, pos, api), /response lost/);
  await handoffReservationCart(saved, pos, api);
  assert.deepEqual(writes, [1, 2]); assert.deepEqual(cart.lineItems, [{ variantId: 1, quantity: 2 }, { variantId: 2, quantity: 3 }]);
});

test("cart changes between product additions use the latest missing quantity", async () => {
  const { handoffReservationCart } = await import("../extensions/common/reservations.js");
  const detail = { ...row, status: "checkout", checkoutDevice: "1", lines: [...row.lines, { variantId: "gid://shopify/ProductVariant/2", quantity: 3 }] };
  const cart = { properties: { [RESERVATION_PROPERTY]: detail.id, [CHECKOUT_PROPERTY]: detail.checkoutKey }, lineItems: [], editable: true };
  const writes = [];
  const pos = { session: { deviceId: 1 }, cart: { current: { value: cart }, async addLineItem(variantId, quantity) {
    writes.push({ variantId, quantity }); cart.lineItems.push({ variantId, quantity });
    if (variantId === 1) cart.lineItems.push({ variantId: 2, quantity: 1 }); // native POS update during await
    return `line-${variantId}`;
  } } };
  await handoffReservationCart(detail, pos, async () => { throw new Error("must reuse existing checkout"); });
  assert.deepEqual(writes, [{ variantId: 1, quantity: 2 }, { variantId: 2, quantity: 2 }]);
});
