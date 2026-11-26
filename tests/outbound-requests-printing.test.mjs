import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import { normalizeOutboundRequestPolicy } from "../extensions/common/outboundRequests.js";
let vite, render;
before(async () => {
  vite = await createServer({ configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false } });
  render = (await vite.ssrLoadModule("/app/services/outboundRequestReceipt.ts")).renderConfiguredOutboundRequestReceipt;
});
after(async () => { await vite?.close(); });
const row = { number: "OR-1", version: 1, originName: "A", destinationName: "B", status: "working", lines: [{ inventoryItemId: "1", title: "商品<script>", sku: "0001", barcode: "00001234", quantity: 2 }], actualLines: [], note: "確認" };
test("outbound receipts reuse reservation printer corrections for 58mm and keep 80mm standard", () => {
  for (const paperWidth of [58, 80]) for (const printerProfile of ["standard", "mpop_58", "mcp31lb_58"]) {
    const html = render(row, { paperWidth, printerProfile });
    assert.ok(html.includes("00001234")); assert.ok(html.includes("商品&lt;script&gt;"));
    assert.ok(!html.includes("<script>")); assert.ok(html.includes("viewport"));
    assert.equal(html.includes('data-receipt-printer-profile="mcp31lb_58"'), paperWidth === 58 && printerProfile === "mcp31lb_58");
    assert.equal(html.includes("width=600, initial-scale=1"), paperWidth === 58 && printerProfile === "mcp31lb_58");
    assert.equal(html.includes("width=400, initial-scale=1"), paperWidth === 58 && printerProfile === "mpop_58");
  }
});
test("old settings keep standard geometry and unsupported printer profiles are rejected", () => {
  assert.equal(normalizeOutboundRequestPolicy({}).printerProfile, "standard");
  assert.throws(() => normalizeOutboundRequestPolicy({ printerProfile: "other" }), /プリンター補正/);
});
