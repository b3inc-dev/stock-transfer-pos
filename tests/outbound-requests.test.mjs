import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OUTBOUND_REQUEST_POLICY, normalizeOutboundRequestPolicy, validateOutboundActual, outboundChunks, renderOutboundRequestReceipt, validOutboundDate } from "../extensions/common/outboundRequests.js";
const line = (id, quantity) => ({ inventoryItemId: `gid://shopify/InventoryItem/${id}`, variantId: `gid://shopify/ProductVariant/${id}`, title: `商品${id}`, sku: `SKU${id}`, barcode: `${id}`, quantity, reason: "" });
test("all combinations of under/over/extra permission and reason modes are enforced", () => {
  for (const kind of ["under", "over", "extra"]) for (const allowed of [false, true]) for (const reasonMode of ["none", "optional", "required"]) {
    const policy = { ...DEFAULT_OUTBOUND_REQUEST_POLICY, [{ under: "allowUnder", over: "allowOver", extra: "allowExtra" }[kind]]: allowed, [`${kind}Reason`]: reasonMode };
    const requested = [line(1, 2)];
    const actual = kind === "extra" ? [line(1, 2), line(2, 1)] : [line(1, kind === "under" ? 1 : 3)];
    if (!allowed || reasonMode === "required") assert.throws(() => validateOutboundActual(requested, actual, policy));
    else assert.equal(validateOutboundActual(requested, actual, policy).differences.length, 1);
    actual.forEach(row => { row.reason = "理由"; });
    if (allowed) {
      const result = validateOutboundActual(requested, actual, policy);
      assert.equal(result.differences[0].kind, kind);
      assert.equal(result.differences[0].reason, reasonMode === "none" ? "" : "理由");
    } else assert.throws(() => validateOutboundActual(requested, actual, policy));
  }
});
test("zero requested rows are underages; all-zero shipments and invalid quantities cannot pass", () => {
  const policy = { ...DEFAULT_OUTBOUND_REQUEST_POLICY, allowUnder: true, underReason: "required" };
  const result = validateOutboundActual([line(1, 2), line(2, 3)], [{ ...line(1, 0), reason: "欠品" }, line(2, 3)], policy);
  assert.equal(result.differences[0].delta, -2);
  for (const quantity of [-1, 1.5, NaN, Infinity, "2", 1000000]) assert.throws(() => validateOutboundActual([line(1, 2)], [line(1, quantity)], policy));
  assert.throws(() => validateOutboundActual([line(1, 2)], [{ ...line(1, 0), reason: "欠品" }], policy));
  assert.throws(() => validateOutboundActual([line(1, 2)], [line(1, 1), line(1, 1)], policy));
  assert.throws(() => normalizeOutboundRequestPolicy({ allowExtra: "true" }));
});
test("250/251 line boundaries split into transfers and omit zero-quantity rows", () => {
  assert.deepEqual(outboundChunks(Array.from({ length: 250 }, (_, i) => line(i, 1))).map(rows => rows.length), [250]);
  assert.deepEqual(outboundChunks([...Array.from({ length: 251 }, (_, i) => line(i, 1)), line(300, 0)]).map(rows => rows.length), [250, 1]);
});
test("receipt uses requested and actual snapshots, includes extra products and escapes text", () => {
  const html = renderOutboundRequestReceipt({ number: "OR-1", version: 4, originName: "A", destinationName: "B", status: "completed", note: "<script>bad</script>", lines: [line(1, 2)], actualLines: [{ ...line(1, 1), reason: "欠品" }, { ...line(2, 1), reason: "追加" }] });
  assert.ok(html.includes("依頼 2<br>出庫 1")); assert.ok(html.includes("SKU2")); assert.ok(html.includes("理由: 追加"));
  assert.ok(!html.includes("<script>")); assert.ok(html.includes("&lt;script&gt;"));
});
test("calendar dates and printer width cannot be silently normalized to other values", () => {
  assert.equal(validOutboundDate("2028-02-29"), true);
  for (const value of ["2026-02-29", "2026-02-30", "2026-13-01", "2026/11/25", "bad"]) assert.equal(validOutboundDate(value), false);
  assert.throws(() => normalizeOutboundRequestPolicy({ paperWidth: 100 }));
});
