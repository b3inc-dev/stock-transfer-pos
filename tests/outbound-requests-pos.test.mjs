/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateOutboundActual } from "../extensions/common/outboundRequests.js";

test("POS scans and extra products require a SKU difference modal before shipping; double confirm sends once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "outbound-request-pos-")), output = path.join(dir, "ui.mjs"), root = path.resolve(".");
  await build({ stdin: { contents: `import {render} from 'preact';import {OutboundRequestModal} from '${root}/extensions/stock-transfer-request/src/Modal.jsx';export const mount=()=>render(<OutboundRequestModal/>,document.body);export const unmount=()=>render(null,document.body);`, resolveDir: root, loader: "jsx" }, bundle: true, format: "esm", platform: "browser", jsx: "automatic", jsxImportSource: "preact", outfile: output, plugins: [{ name: "host", setup(builder) { builder.onResolve({ filter: /^@shopify\/ui-extensions\/preact$/ }, () => ({ path: "host", namespace: "host" })); builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: "", loader: "js" })); } }] });
  const { window } = parseHTML("<html><body></body></html>");
  const old = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node, shopify: globalThis.shopify, fetch: globalThis.fetch };
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node });
  const line = (n, quantity) => ({ variantId: `gid://shopify/ProductVariant/${n}`, inventoryItemId: `gid://shopify/InventoryItem/${n}`, title: `商品${n}`, sku: `SKU${n}`, barcode: String(n), quantity, reason: "" });
  let row = { id: "request-fixture", number: "OR-1", version: 1, originId: "gid://shopify/Location/1", originName: "A", destinationName: "B", status: "requested", claimed: false, lines: [line(1, 2), line(2, 2)], actualLines: [], note: "店舗間移動" };
  const policy = { allowUnder: true, underReason: "required", allowOver: true, overReason: "required", allowExtra: true, extraReason: "required" }, calls = [], storage = new Map(), prints = [];
  let scan;
  globalThis.shopify = { session: { currentSession: { locationId: 1 }, getSessionToken: async () => "fixture" }, storage: { async get(key) { return storage.get(key); }, async set(key, value) { storage.set(key, structuredClone(value)); } }, scanner: { scannerData: { current: { subscribe(fn) { scan = fn; return () => { scan = null; }; } } }, hideCameraScanner() {}, showCameraScanner() {} }, toast: { show() {} }, printing: { getPrinters: async () => [{ connected: true }], async print(src) { prints.push(src); } } };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    const response = extra => Response.json({ ok: true, settings: { version: 1, policy }, shipping: { required: false, allowCustomCarrier: true, carriers: [] }, ...extra });
    if (body.command === "list") return response({ rows: [row], count: 1 });
    if (body.command === "detail") return response({ row });
    if (body.command === "claim") { row = { ...row, status: "working", claimed: true, version: row.version + 1 }; return response({ row }); }
    if (body.command === "products") return response({ products: [line(3, 0)] });
    if (body.command === "preview") {
      const checked = validateOutboundActual(row.lines, body.actual, policy);
      return response({ preview: { ...checked, differences: checked.differences.map(line => ({ ...line, title: body.actual.find(item => item.inventoryItemId === line.inventoryItemId)?.title, sku: body.actual.find(item => item.inventoryItemId === line.inventoryItemId)?.sku })), token: "preview-confirmation" } });
    }
    if (body.command === "begin") {
      assert.equal(body.token, "preview-confirmation");
      assert.deepEqual(body.actual.map(line => line.quantity), [3, 0, 1]);
      row = { ...row, actualLines: body.actual, status: "processing", version: row.version + 1, execution: { flight: false } };
      return response({ row });
    }
    if (body.command === "advance") { row = { ...row, status: "completed", version: row.version + 1 }; return response({ row }); }
    throw new Error(`Unexpected ${body.command}`);
  };
  const ui = await import(pathToFileURL(output).href), wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const click = text => {
    const target = [...document.querySelectorAll("s-button")].find(element => element.textContent === text);
    assert.ok(target, text); target.dispatchEvent(new window.Event("click"));
  };
  try {
    ui.mount(); await wait(); await wait();
    const item = document.querySelector("s-clickable"); assert.ok(item); item.dispatchEvent(new window.Event("click")); await wait();
    click("作業を開始"); await wait(); await wait();
    assert.equal(typeof scan, "function"); scan({ data: "1" }); scan({ data: "1" }); scan({ data: "1" }); await wait();
    click("検索"); await wait(); click("商品3・SKU3を追加"); await wait();
    const reasons = [...document.querySelectorAll('s-text-field[label="理由（必須）"]')];
    assert.equal(reasons.length, 3);
    for (const input of reasons) { input.value = "店舗確認済み"; input.dispatchEvent(new window.Event("input")); }
    await wait();
    const finishButton = [...document.querySelectorAll("s-button")].find(element => element.textContent === "出庫完了");
    assert.equal(finishButton.getAttribute("command"), "--show", "use the supported native command, not an optional imperative modal method");
    assert.equal(finishButton.getAttribute("commandFor"), "outbound-request-differences");
    click("出庫完了"); await wait();
    assert.equal(calls.filter(call => call.command === "begin").length, 0);
    assert.equal(calls.filter(call => call.command === "advance").length, 0);
    const modal = document.querySelector("#outbound-request-differences");
    for (const expected of ["数量の差異を確認", "SKU1", "SKU2", "SKU3", "依頼 2 → 出庫 3（差分 +1）", "依頼 2 → 出庫 0（差分 -2）", "依頼 0 → 出庫 1（差分 +1）", "店舗確認済み"]) assert.ok(`${modal.getAttribute("heading")} ${modal.textContent}`.includes(expected), expected);
    click("確認して出庫"); click("確認して出庫"); await wait();
    assert.equal(calls.filter(call => call.command === "begin").length, 1);
    assert.equal(calls.filter(call => call.command === "advance").length, 1);
    assert.ok(document.body.textContent.includes("出庫完了"));
    click("依頼書を印刷"); await wait();
    assert.ok(prints[0].startsWith("/api/outbound-requests?receipt=request-fixture&locationId="));
    assert.equal(calls.filter(call => call.command === "begin").length, 1, "printing never ships again");
  } finally { ui.unmount(); Object.assign(globalThis, old); }
});

test("new POS screens use only components declared by their installed Shopify SDK", async () => {
  const extension = path.resolve("extensions/stock-transfer-request");
  const require = createRequire(path.join(extension, "package.json"));
  let directory = path.dirname(require.resolve("@shopify/ui-extensions/preact"));
  while (!await readFile(path.join(directory, "package.json"), "utf8").then(text => JSON.parse(text).name === "@shopify/ui-extensions").catch(() => false)) {
    const parent = path.dirname(directory); assert.notEqual(parent, directory); directory = parent;
  }
  const declarations = await readFile(path.join(directory, "src/surfaces/point-of-sale/components.d.ts"), "utf8");
  const tags = new Set([...declarations.matchAll(/declare const tagName[^=]*= '(s-[\w-]+)'/g)].map(match => match[1]));
  for (const file of ["Modal.jsx", "Tile.jsx"]) {
    const source = await readFile(path.join(extension, "src", file), "utf8");
    for (const match of source.matchAll(/<(s-[\w-]+)\b/g)) assert.ok(tags.has(match[1]), `${file}: ${match[1]}`);
    assert.doesNotMatch(source, /<s-search-field[^>]*\blabel=/);
    assert.doesNotMatch(source, /(?:maxBlockSize|blockSize)="[\d.]+vh"/);
  }
});
