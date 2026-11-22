// 管理画面の UI ルール v1.1（docs/UI_RULES.md）のうち、ソースで確かめられるものを試験で止める。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ui = readFileSync("app/components/admin-ui.tsx", "utf8");
const routes = readdirSync("app/routes")
  .filter((name) => /^app\..*\.(tsx|jsx)$/.test(name) || name === "app._index.tsx" || name === "app._index.jsx")
  .map((name) => ({ name, source: readFileSync(`app/routes/${name}`, "utf8") }));

test("adminCss に引用符と > を書かない（サーバーで描くと &quot; &gt; になりセレクタが効かない。13章）", () => {
  const start = ui.indexOf("export const adminCss = `") + "export const adminCss = `".length;
  const css = ui.slice(start, ui.indexOf("`;", start));
  assert.ok(css.length > 1000, "adminCss が見つからない");
  assert.equal(css.includes('"'), false, "adminCss に \" がある");
  assert.equal(css.includes("'"), false, "adminCss に ' がある");
  assert.equal(css.includes(">"), false, "adminCss に > がある");
});

test("日付欄と スマホの大きさ（ボタン 40px・入力 44px/16px）の CSS がある（13章）", () => {
  assert.match(ui, /\[type=date\]/);
  assert.match(ui, /::-webkit-date-and-time-value \{ text-align: left; \}/);
  assert.match(ui, /min-height: 40px/);
  assert.match(ui, /min-height: 44px; font-size: 16px;/);
});

test("上部メニューは共通の部品で描き、共通の CSS を一緒に1回だけ描く（3章・13章）", () => {
  const nav = readFileSync(process.env.UI_NAV_FILE ?? "app/components/AppNavBar.tsx", "utf8");
  assert.match(nav, /<AdminStyle \/>/);
  assert.match(nav, /<AppNavBarView /);
});

test("画面に下線のリンクを書かない（4章）", () => {
  for (const { name, source } of routes) {
    assert.equal(/textDecoration:\s*"underline"/.test(source), false, `${name} に下線がある`);
  }
});

test("日付欄は共通の CSS（Admin-input）を付けて枠からはみ出さないようにする（6章・13章）", () => {
  for (const { name, source } of routes) {
    for (const match of source.matchAll(/type="date"/g)) {
      const around = source.slice(match.index, match.index + 200);
      assert.match(around, /className="[^"]*Admin-input/, `${name} の日付欄に Admin-input がない`);
    }
  }
});

test("History-table の表は各セルに data-label を付ける（スマホは1件1枚のカード。8章）", () => {
  for (const { name, source } of routes) {
    for (const match of source.matchAll(/<table className="History-table"/g)) {
      const block = source.slice(match.index, source.indexOf("</table>", match.index));
      const cells = [...block.matchAll(/<td\b[^>]*/g)].map((m) => m[0]);
      assert.ok(cells.length > 0, `${name} の表にセルがない`);
      for (const cell of cells) assert.match(cell, /data-label=/, `${name} の表のセルに data-label がない`);
    }
  }
});
