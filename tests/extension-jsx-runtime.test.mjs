import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// POS 拡張は Preact で描画する。extensions/common など拡張フォルダ外の JSX が
// ルート tsconfig（React 用 react-jsx）でビルドされると react/jsx-runtime の要素が
// Preact に混ざり、表示時に `undefined is not an object (evaluating 'e.nodeType')` で落ちる
// （ListPageControls.jsx が 51 件目で表示されたときに発生）。
// 全 POS 拡張のエントリを esbuild（Shopify CLI と同じく tsconfig を自動検出）でバンドルし、
// React の JSX ランタイムが入っていないことを確認する。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = path.join(root, "extensions");

let esbuild = null;
try {
  esbuild = await import("esbuild");
} catch {
  esbuild = null;
}

const entries = readdirSync(extensionsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("stock-transfer-"))
  .flatMap((d) => {
    const src = path.join(extensionsDir, d.name, "src");
    return readdirSync(src)
      .filter((f) => /^(Modal.*|Tile)\.jsx$/.test(f))
      .map((f) => path.join(src, f));
  });

for (const entry of entries) {
  test(`POS bundle uses only the Preact JSX runtime: ${path.relative(root, entry)}`, { skip: !esbuild && "esbuild not installed" }, async () => {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      external: ["preact", "preact/*", "@preact/*", "@shopify/*", "react", "react/*", "react-dom", "react-dom/*"],
    });
    const code = result.outputFiles.map((f) => f.text).join("\n");
    assert.doesNotMatch(code, /from\s+["']react(?:\/jsx-runtime|\/jsx-dev-runtime)?["']/);
    assert.match(code, /from\s+["']preact\/jsx-runtime["']/);
  });
}
