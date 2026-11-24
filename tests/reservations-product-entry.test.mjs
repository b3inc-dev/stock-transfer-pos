import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { appendProductToDraft, loadProductReservationDraft } from "../extensions/stock-transfer-reservation/src/productEntry.js";
const variant = { id: 22, productId: 11, displayName: "Tシャツ / 青 / M" };
const newDraft = () => ({ id: "R-new", lines: [], name: "", phone: "", faceToFace: true, print: false });
function fixture(saved, options = {}) {
  const fetched = [], writes = [];
  const storage = { async get(key) { assert.equal(key, "draft:store1"); if (options.storageError) throw new Error("read failed"); return saved; }, async set(...args) { writes.push(args); } };
  const productSearch = { async fetchProductVariantWithId(id) { fetched.push(id); if (options.lookupError) throw new Error("lookup failed"); return options.variant === undefined ? variant : options.variant; } };
  return { fetched, writes, load: () => loadProductReservationDraft({ storage, storageKey: "draft:store1", product: options.product || { id: 11, variantId: 22 }, productSearch, createDraft: newDraft }) };
}
test("product-details starts with its exact selected variant, quantity one, no inventory writes", async () => {
  const f = fixture(null); const result = await f.load();
  assert.equal(result.kind, "ready"); assert.deepEqual(f.fetched, [22]); assert.deepEqual(f.writes, []);
  assert.deepEqual(result.draft.lines, [{ variantId: "gid://shopify/ProductVariant/22", title: variant.displayName, quantity: 1 }]);
});
test("an unfinished different draft requires confirmation, preserving customer fields and original lines", async () => {
  const saved = { ...newDraft(), id: "R-existing", name: "Guest", phone: "09012345678", lines: [{ variantId: "gid://shopify/ProductVariant/33", quantity: 4 }] };
  const before = structuredClone(saved), f = fixture(saved), result = await f.load();
  assert.equal(result.kind, "confirm"); assert.deepEqual(saved, before); assert.deepEqual(f.writes, []);
  const appended = appendProductToDraft(result.draft, result.line);
  assert.equal(appended.id, saved.id); assert.equal(appended.name, saved.name); assert.equal(appended.phone, saved.phone);
  assert.deepEqual(appended.lines[0], before.lines[0]); assert.equal(appended.lines[1].quantity, 1); assert.deepEqual(saved, before);
});
test("same product in saved draft keeps its quantity without duplicate additions on reopening", async () => {
  const saved = { ...newDraft(), lines: [{ variantId: "gid://shopify/ProductVariant/22", quantity: 3 }] };
  const result = await fixture(saved).load();
  assert.equal(result.kind, "ready"); assert.equal(result.draft.lines.length, 1); assert.equal(result.draft.lines[0].quantity, 3);
  assert.equal(appendProductToDraft(result.draft, { variantId: "gid://shopify/ProductVariant/22", quantity: 1 }), saved);
});
test("unknown submitted result wins over current product, retaining exact frozen payload", async () => {
  const saved = { ...newDraft(), submitted: true, customerId: "gid://shopify/Customer/7", lines: [{ variantId: "gid://shopify/ProductVariant/33", quantity: 2 }] };
  const f = fixture(saved, { lookupError: true }); const result = await f.load();
  assert.equal(result.kind, "submitted"); assert.equal(result.draft, saved); assert.deepEqual(f.fetched, []);
  assert.throws(() => appendProductToDraft(saved, { variantId: "gid://shopify/ProductVariant/22", quantity: 1 }), /登録結果/);
});
test("missing or mismatched product context never guesses the first variant", async () => {
  for (const options of [{ product: { id: 11, variantId: 0 } }, { product: { id: 11 } }, { variant: null }, { variant: { ...variant, id: 23 } }, { variant: { ...variant, productId: 12 } }]) {
    const f = fixture(null, options); await assert.rejects(f.load()); assert.deepEqual(f.writes, []);
  }
});
test("storage/lookup failures leave the original draft untouched; full draft cannot overflow", async () => {
  await assert.rejects(fixture(null, { storageError: true }).load());
  await assert.rejects(fixture(null, { lookupError: true }).load());
  const full = { ...newDraft(), lines: Array.from({ length: 250 }, (_, id) => ({ variantId: `gid://shopify/ProductVariant/${id}`, quantity: 1 })) };
  assert.throws(() => appendProductToDraft(full, { variantId: "gid://shopify/ProductVariant/251", quantity: 1 }), /250/);
  assert.equal(full.lines.length, 250);
});
test("product action and modal are registered as a pair and use the Preact runtime", async () => {
  const config = readFileSync("extensions/stock-transfer-reservation/shopify.extension.toml", "utf8");
  assert.match(config, /module = "\.\/src\/ProductAction.jsx"\s+target = "pos.product-details.action.menu-item.render"/);
  assert.match(config, /module = "\.\/src\/ModalProduct.jsx"\s+target = "pos.product-details.action.render"/);
  for (const entry of ["ProductAction", "ModalProduct"]) {
    const result = await build({ entryPoints: [`extensions/stock-transfer-reservation/src/${entry}.jsx`], bundle: true, write: false, format: "esm", logLevel: "silent", external: ["preact", "preact/*", "@shopify/*", "react", "react/*"] });
    const code = result.outputFiles.map(file => file.text).join("\n");
    assert.match(code, /from\s+["']preact\/jsx-runtime["']/); assert.doesNotMatch(code, /from\s+["']react(?:\/jsx-runtime)?["']/);
  }
});

test("Back waits for the newest draft and an older in-flight save cannot overwrite it", async () => {
  const { createReservationDraftWriter } = await import("../extensions/stock-transfer-reservation/src/productEntry.js");
  let releaseFirst, stored;
  const writes = [];
  const storage = { async set(key, value) {
    writes.push(value);
    if (writes.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
    stored = value;
  } };
  const writer = createReservationDraftWriter(storage, "draft");
  const old = writer.save({ name: "old" });
  await new Promise(resolve => setImmediate(resolve));
  let dismissed = false;
  const back = writer.save({ name: "latest" }).then(() => { dismissed = true; });
  assert.equal(dismissed, false); assert.equal(writes.length, 1);
  releaseFirst(); await Promise.all([old, back]);
  assert.equal(dismissed, true); assert.equal(stored.name, "latest");
});
test("failed save leaves Back pending for correction and a subsequent save can recover", async () => {
  const { createReservationDraftWriter } = await import("../extensions/stock-transfer-reservation/src/productEntry.js");
  let fail = true, stored, dismissed = false;
  const writer = createReservationDraftWriter({ async set(key, value) { if (fail) throw new Error("full"); stored = value; } }, "draft");
  await assert.rejects(writer.save({ name: "latest" }).then(() => { dismissed = true; }), /保存できません/);
  assert.equal(dismissed, false); fail = false;
  await writer.save({ name: "latest" }); assert.equal(stored.name, "latest");
});
