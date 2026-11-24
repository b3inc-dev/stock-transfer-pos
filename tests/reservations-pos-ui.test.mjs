/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
test("POS customer association, confirmation registration and independent copy printing are retry safe", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reservation-pos-ui-"));
  const root = path.resolve(".");
  const output = path.join(dir, "ui.mjs");
  await build({ stdin: { contents: `import{render}from'preact';import{ReservationModal}from'${root}/extensions/stock-transfer-reservation/src/Modal.jsx';export const mount=()=>render(<ReservationModal/>,document.body);export const unmount=()=>render(null,document.body);`, resolveDir: root, loader: "jsx" }, bundle: true, format: "esm", platform: "browser", jsx: "automatic", jsxImportSource: "preact", outfile: output, plugins: [{ name: "host", setup(builder) { builder.onResolve({ filter: /^@shopify\/ui-extensions\/preact$/ }, () => ({ path: "host", namespace: "host" })); builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: "", loader: "js" })); } }] });
  const { window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node });
  const calls = [], prints = [];
  let subscriber, draft = { id: "R-12345678-1234-1234-1234-123456789abc", name: "ゲスト", phone: "09012345678", faceToFace: true, lines: [{ variantId: "gid://shopify/ProductVariant/1", title: "商品", quantity: 2 }] };
  const cart = { customer: null, properties: {}, editable: true };
  const row = { ...draft, status: "held", locationName: "店舗", dueDate: "2026-12-02", phone: "09012345678", events: [], lines: draft.lines, version: 1 };
  let rejectPrint = true;
  globalThis.shopify = { session: { currentSession: { locationId: 1 }, getSessionToken: async () => "fixture" }, cart: { current: { value: cart, subscribe(callback) { subscriber = callback; return () => {}; } }, async setCustomer(customer) { calls.push("setCustomer"); cart.customer = customer; subscriber(cart); }, async removeCustomer() { calls.push("removeCustomer"); cart.customer = null; subscriber(cart); } }, storage: { get: async () => draft, set: async (_key, value) => { draft = structuredClone(value); } }, scanner: { hideCameraScanner() {} }, toast: { show() {} }, action: { dismissModal: async () => {} }, printing: { getPrinters: async () => [{ connected: true, id: 1 }], print: async url => { prints.push(url); if (rejectPrint) throw new Error("offline"); } } };
  globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(options.body); calls.push(input.command);
    if (input.command === "sessionDisplay") return Response.json({ ok: true, locationName: "店舗", customer: cart.customer ? { name: "姓 名", phone: "+818012345678", hasPhone: true } : null });
    if (input.command === "receiptOptions") return Response.json({ ok: true, customerCopy: true, storeCopy: true });
    if (input.command === "customers") return Response.json({ ok: true, customers: [{ id: "gid://shopify/Customer/1", name: "姓 名", phone: "+818012345678" }], pageInfo: { hasNextPage: false, endCursor: null } });
    if (input.command === "productSettings") return Response.json({ ok: true, searchLimit: 50, productLimit: 250 });
    if (input.command === "products") return Response.json({ ok: true, products: [], pageInfo: { hasNextPage: false } });
    if (input.command === "create") return Response.json({ ok: true, row });
    throw new Error(`unexpected ${input.command}`);
  };
  const ui = await import(pathToFileURL(output).href);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = (text, modal = false) => {
    const button = [...document.querySelectorAll("s-button")].find(node => node.textContent === text && Boolean(node.closest("s-modal")) === modal);
    assert.ok(button, text); button.dispatchEvent(new window.Event("click"));
  };
  try {
    ui.mount(); await wait(150);
    assert.equal([...document.querySelectorAll("s-button")].filter(node => node.textContent === "戻る" && !node.closest("s-modal")).length, 0, "intake has no previous screen");
    click("お客様を選択"); await wait(100);
    const search = document.querySelector('s-search-field[placeholder="氏名・電話番号で検索"]'); search.value = "姓 名"; search.dispatchEvent(new window.Event("input")); await wait(450);
    const customer = document.querySelector("s-clickable"); assert.ok(customer); customer.dispatchEvent(new window.Event("click")); await wait(150);
    assert.equal(document.querySelector('s-search-field[placeholder="氏名・電話番号で検索"]'), null, "selected customer removes the native input so its keyboard can close");
    // A native blur/change arriving after selection must not reopen the search field.
    search.value = "姓 名前"; search.dispatchEvent(new window.Event("change")); await wait(50);
    assert.equal(document.querySelector('s-search-field[placeholder="氏名・電話番号で検索"]'), null);
    click("検索し直す"); await wait(50);
    assert.ok(document.querySelector('s-search-field[placeholder="氏名・電話番号で検索"]'));
    document.querySelector("s-clickable").dispatchEvent(new window.Event("click")); await wait(50);
    assert.equal(cart.customer, null); click("このお客様を選択"); await wait(150);
    assert.equal(cart.customer.id, 1); assert.ok(document.body.textContent.includes("080-1234-5678"));
    cart.properties["取置番号"] = "existing"; click("カートから解除"); await wait(100); assert.equal(cart.customer.id, 1);
    delete cart.properties["取置番号"]; click("カートから解除"); await wait(150); assert.equal(cart.customer, null);
    click("次へ"); await wait(150); assert.equal(document.querySelector('s-page').getAttribute("heading"), "取置する商品");
    assert.ok([...document.querySelectorAll("s-button")].some(node => node.textContent === "戻る" && !node.closest("s-modal")));
    assert.equal(calls.filter(call => call === "create").length, 0);
    click("確定する", true); await wait(200);
    assert.equal(calls.filter(call => call === "create").length, 1);
    assert.ok(prints[0].includes("copy=customer")); assert.equal(document.querySelector("s-page").getAttribute("heading"), "取置の詳細");
    assert.ok(document.body.textContent.includes("取置は登録済み"));
    rejectPrint = false; click("店舗控えを印刷"); await wait(100);
    assert.ok(prints[1].includes("copy=store")); assert.equal(calls.filter(call => call === "create").length, 1);
    assert.equal(draft.lines.length, 0);
    click("連絡・印刷"); await wait(100); assert.equal(document.querySelector("s-page").getAttribute("heading"), "連絡・印刷");
    click("お客様控えを印刷"); await wait(100); assert.ok(prints[2].includes("copy=customer")); assert.equal(calls.filter(call => call === "create").length, 1);
  } finally { ui.unmount(); delete globalThis.shopify; delete globalThis.fetch; }
  // Keep the built artifact in the OS temp directory for diagnosing a failing test.
  await writeFile(path.join(dir, "result.txt"), "customer association + print failure + store copy passed\n");
});
