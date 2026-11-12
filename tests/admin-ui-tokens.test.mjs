import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminBodyFontSizePx,
  adminColors,
  adminFontFamily,
  adminQtyCellPaddingPx,
} from "../app/components/adminUi.ts";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "../app/admin-ui.css"), "utf8");

test("本文は Inter のあと日本語のシステムフォントへ落ちる", () => {
  assert.equal(adminFontFamily.startsWith("Inter, "), true);
  for (const family of ["Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo"]) {
    assert.equal(adminFontFamily.includes(family), true, family);
  }
  assert.equal(css.includes("Hiragino Sans"), true);
  assert.equal(css.includes("Meiryo"), true);
});

test("本文は 14px、数量比較のセル余白は 8px のまま", () => {
  assert.equal(adminBodyFontSizePx, 14);
  assert.equal(adminQtyCellPaddingPx, 8);
  assert.equal(adminColors.interactive, "#2c6ecb");
  assert.match(css, /\.admin-qty-table th,\s*\.admin-qty-table td \{\s*padding: 8px;/);
  assert.match(css, /\.admin-nav \{\s*[^}]*font-size: 14px;/);
});
