/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
test("both apps declare optional customer writes without making them mandatory for ordinary holds", async () => {
  for (const filename of ["shopify.app.toml", "shopify.app.public.toml"]) {
    const source = await readFile(filename, "utf8");
    assert.match(source, /optional_scopes = \[[^\n]*"write_customers"/);
    assert.doesNotMatch(source.match(/^scopes = .*$/m)[0], /write_customers/);
  }
});
test("Admin exposes a separate explicit grant for customer phone writes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reservation-phone-scopes-")); const output = path.join(dir, "ui.mjs");
  await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{ReservationScopeAccess}from'${path.resolve('app/components/ReservationScopeAccess.tsx')}';let root;const error=()=>{};export function mount(){root=createRoot(document.body);root.render(<ReservationScopeAccess onError={error}/>)}export function unmount(){root.unmount()}`, resolveDir: path.resolve('.'), loader: "jsx" }, bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile: output, plugins: [{ name: "bridge", setup(builder) { builder.onResolve({ filter: /^@shopify\/app-bridge-react$/ }, () => ({ path: "bridge", namespace: "mock" })); builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const useAppBridge=()=>globalThis.phoneScopeBridge; export const SaveBar=()=>null;", loader: "js" })); } }] });
  const { window } = parseHTML("<html><body></body></html>"); Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node });
  let granted = ["read_customers", "read_orders"]; const requested = [];
  globalThis.phoneScopeBridge = { scopes: { async query() { return { granted }; }, async request(scopes) { requested.push(scopes); granted = [...granted, ...scopes]; return { detail: { granted } }; } } };
  const ui = await import(pathToFileURL(output).href); const wait = () => new Promise(resolve => setTimeout(resolve, 80));
  try {
    ui.mount(); await wait(); assert.equal(requested.length, 0);
    assert.ok(document.body.textContent.includes("顧客・注文の読み取りは許可されています"));
    const button = [...document.querySelectorAll("button")].find(node => node.textContent === "顧客情報への登録を許可"); assert.ok(button); assert.equal(button.type, "button");
    button.dispatchEvent(new window.Event("click", { bubbles: true })); await wait();
    assert.deepEqual(requested, [["write_customers"]]); assert.ok(document.body.textContent.includes("顧客情報への登録は許可されています"));
  } finally { ui.unmount(); delete globalThis.phoneScopeBridge; }
});
