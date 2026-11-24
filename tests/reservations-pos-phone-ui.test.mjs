/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
test("phone consent resets on edit/customer change and saved hold survives customer-write failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reservation-phone-pos-")); const output = path.join(dir, "ui.mjs"); const root = path.resolve('.');
  await build({ stdin: { contents: `import{render}from'preact';import{ReservationModal}from'${root}/extensions/stock-transfer-reservation/src/Modal.jsx';export const mount=()=>render(<ReservationModal/>,document.body);export const unmount=()=>render(null,document.body);`, resolveDir: root, loader: "jsx" }, bundle: true, format: "esm", platform: "browser", jsx: "automatic", jsxImportSource: "preact", outfile: output, plugins: [{ name: "host", setup(builder) { builder.onResolve({ filter: /^@shopify\/ui-extensions\/preact$/ }, () => ({ path: "host", namespace: "host" })); builder.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: "", loader: "js" })); } }] });
  const { window } = parseHTML("<html><body></body></html>"); Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node });
  const cart = { customer: { id: 1 }, properties: {}, editable: true }; let subscriber, submitted;
  let draft = { id: "R-12345678-1234-1234-1234-123456789abc", name: "", phone: "", faceToFace: true, lines: [{ variantId: "gid://shopify/ProductVariant/1", title: "商品", quantity: 1 }] };
  let creates = 0;
  globalThis.shopify = { session: { currentSession: { locationId: 1 }, getSessionToken: async () => "fixture" }, cart: { current: { value: cart, subscribe(fn) { subscriber = fn; return () => {}; } } }, storage: { get: async () => draft, set: async (_key, value) => { draft = structuredClone(value); } }, scanner: { hideCameraScanner() {} }, toast: { show() {} } };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.command === "sessionDisplay") return Response.json({ ok: true, locationName: "店", customer: { name: "姓 名", hasPhone: false, phone: "" }, canSaveCustomerPhone: true });
    if (body.command === "receiptOptions") return Response.json({ ok: true, customerCopy: false, storeCopy: false });
    if (body.command === "products") return Response.json({ ok: true, products: [], pageInfo: { hasNextPage: false } });
    if (body.command === "productSettings") return Response.json({ ok: true, searchLimit: 50, productLimit: 250 });
    if (body.command === "create") { creates++; submitted = body; return Response.json({ ok: true, customerPhoneWarning: "取置は登録済みです。顧客情報へ登録できませんでした。", row: { ...body, customerPhoneSaveState: "failed", contactVisible: true, status: "held", phone: body.phone, name: "姓 名", locationName: "店", dueDate: "2026-12-02", events: [], version: 1 } }); }
    throw new Error(body.command);
  };
  const ui = await import(pathToFileURL(output).href); const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const phone = () => document.querySelector('s-text-field[label="連絡用の電話番号（未登録）"]');
  const toggle = () => document.querySelector('s-switch[label="顧客情報にも登録する"]');
  const enter = async value => { phone().value = value; phone().dispatchEvent(new window.Event("input")); await wait(); };
  const choose = async () => { toggle().checked = true; toggle().dispatchEvent(new window.Event("change")); await wait(); };
  const click = async text => { const node = [...document.querySelectorAll("s-button")].find(n => n.textContent === text); assert.ok(node, text); node.dispatchEvent(new window.Event("click")); await wait(); };
  try {
    ui.mount(); await wait(); await wait();
    assert.ok(phone()); assert.equal(Boolean(toggle().checked), false);
    await enter("09012345678"); await choose(); assert.equal(toggle().checked, true);
    await enter("08012345678"); assert.equal(toggle().checked, false);
    await choose(); cart.customer = { id: 2 }; subscriber(cart); await wait(); await wait();
    assert.equal(Boolean(toggle().checked), false); assert.equal(phone().value || phone().getAttribute("value") || "", "");
    await enter("09012345678"); await choose(); await click("次へ");
    assert.ok(document.querySelector('#reservation-register-confirm').textContent.includes("電話番号を顧客情報にも登録します"), JSON.stringify({ draft, text: document.body.textContent }));
    await click("確定する"); await wait();
    assert.equal(creates, 1); assert.equal(submitted.saveCustomerPhone, true); assert.equal(submitted.customerId, "gid://shopify/Customer/2"); assert.equal(submitted.phone, "09012345678");
    assert.equal(document.querySelector('s-page').getAttribute('heading'), "取置の詳細"); assert.ok(document.body.textContent.includes("顧客情報へ登録できません"));
    assert.ok([...document.querySelectorAll('s-button')].some(n => n.textContent === "顧客へ電話番号を登録")); assert.equal(draft.lines.length, 0);
  } finally { ui.unmount(); delete globalThis.shopify; delete globalThis.fetch; }
});
