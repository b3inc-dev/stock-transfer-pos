/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

for (const [name, heading, fallback] of [["inbound", "入庫", "処理・履歴"], ["stocktake", "棚卸", "登録・履歴"], ["reservation", "取置", "登録・履歴"], ["request", "出庫依頼", "確認・印刷・出庫"]]) {
  test(`${heading} tile renders pending counts, clears failures, refreshes on focus and preserves opening behavior`, async () => {
    const root = path.resolve("."), dir = await mkdtemp(path.join(tmpdir(), "pending-tile-")), output = path.join(dir, "tile.mjs");
    await build({ stdin: { contents: `import mount from '${root}/extensions/stock-transfer-${name}/src/Tile.jsx';import {render} from 'preact';export {mount};export const unmount=()=>render(null,document.body);`, resolveDir: root, loader: "jsx" }, bundle: true, format: "esm", platform: "browser", jsx: "automatic", jsxImportSource: "preact", outfile: output, plugins: [{ name: "tile-fixture", setup(builder) {
      builder.onResolve({ filter: /^@shopify\/ui-extensions\/preact$/ }, () => ({ path: "host", namespace: "fixture" }));
      builder.onResolve({ filter: /(?:inboundApi|stocktakeApi|posPlanGate|\/api)\.js$/ }, () => ({ path: "loaders", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "host" ? "" : `
        const load = async () => {if(globalThis.tileFixture.error)throw new Error('offline');return globalThis.tileFixture.count;};
        export const checkPosPlanAccess = async () => ({access:'allowed'});
        export const fetchPendingInboundCount = load;
        export const readPendingStocktakeCount = load;
        export const reservationApi = async input => {globalThis.tileFixture.command=input.command;return {count:await load()};};
        export const outboundRequestApi = async input => {globalThis.tileFixture.command=input.command;return {count:await load()};};
      `, loader: "js" }));
    } }] });
    const { window } = parseHTML("<html><body></body></html>");
    const previous = {};
    for (const key of ["window", "document", "HTMLElement", "Element", "Node", "shopify", "addEventListener", "removeEventListener", "tileFixture"]) previous[key] = globalThis[key];
    let opened = 0;
    Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window), shopify: { session: { currentSession: { locationId: 1 } }, action: { presentModal() { opened++; } } }, tileFixture: { count: 3, error: false } });
    const ui = await import(pathToFileURL(output).href), wait = () => new Promise(resolve => setTimeout(resolve, 100));
    const subheading = () => document.querySelector("s-tile")?.getAttribute("subheading");
    try {
      await ui.mount(); await wait(); await wait();
      assert.equal(subheading(), `${name === "reservation" ? "期限超過" : "未対応"} 3件`);
      assert.equal(document.querySelector("s-tile").getAttribute("heading"), heading);
      if (name === "reservation") assert.equal(globalThis.tileFixture.command, "overdueCount");
      globalThis.tileFixture.count = 0; window.dispatchEvent(new window.Event("focus")); await wait(); assert.equal(subheading(), fallback);
      globalThis.tileFixture.count = 7; window.dispatchEvent(new window.Event("focus")); await wait(); assert.equal(subheading(), `${name === "reservation" ? "期限超過" : "未対応"} 7件`);
      globalThis.tileFixture.error = true; window.dispatchEvent(new window.Event("focus")); await wait(); assert.equal(subheading(), fallback);
      document.querySelector("s-tile").dispatchEvent(new window.Event("click")); assert.equal(opened, 1);
      globalThis.shopify.session.currentSession.locationId = 2;
      globalThis.tileFixture.error = false; globalThis.tileFixture.count = 1;
      window.dispatchEvent(new window.Event("focus")); await wait(); assert.equal(subheading(), `${name === "reservation" ? "期限超過" : "未対応"} 1件`);
    } finally { ui.unmount(); Object.assign(globalThis, previous); }
  });
}
