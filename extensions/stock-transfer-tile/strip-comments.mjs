#!/usr/bin/env node
/**
 * ModalOutbound.jsx からコメントを削除して 64KB 制限対策。
 * - 行全体が // の行を削除
 * - 行全体がブロックコメントまたは * の行を削除
 * - JSX 内の { ... } コメントを削除
 * - 行末の // コメントを削除
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, "src", "ModalOutbound.jsx");
let content = fs.readFileSync(srcPath, "utf8");
const originalLen = Buffer.byteLength(content, "utf8");

// 1) 複数行ブロックコメント /* ... */ を削除（JSX の {/* */} は後で処理）
//    空行に置換して行番号のずれを抑える
content = content.replace(/\/\*(?!\*\/)[\s\S]*?\*\//g, (m) => {
  const lines = m.split("\n").length;
  return lines > 1 ? "\n".repeat(lines - 1) : "";
});

// 2) JSX コメント {/* ... */} を削除（複数行対応）
content = content.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

// 3) 行単位で処理：行全体がコメントの行を削除、行末の // を削除
const lines = content.split("\n");
const out = [];
let inBlock = false;

for (let i = 0; i < lines.length; i++) {
  let line = lines[i];
  const trimmed = line.trim();

  // ブロックコメント内（上で削除したので通常は来ないが、* だけの行対策）
  if (inBlock) {
    if (trimmed.endsWith("*/")) inBlock = false;
    out.push(""); // 空行で行数維持
    continue;
  }
  if (trimmed.startsWith("/*") && !trimmed.endsWith("*/")) {
    inBlock = true;
    out.push("");
    continue;
  }

  // 行全体が // コメント
  if (trimmed.startsWith("//")) {
    out.push("");
    continue;
  }
  // 行全体が /* ... */ の1行
  if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) {
    out.push("");
    continue;
  }
  // 行全体が * のみ（ブロックの続き）
  if (/^\s*\*[^/]/.test(line) || /^\s*\*\s*$/.test(line)) {
    out.push("");
    continue;
  }

  // 行末の // コメントを削除（文字列内は簡易スキップ）
  const lastSlash = line.lastIndexOf("//");
  if (lastSlash !== -1) {
    const before = line.slice(0, lastSlash);
    const inDouble = (before.match(/"/g) || []).length % 2 !== 0;
    const inSingle = (before.match(/'/g) || []).length % 2 !== 0;
    const inTemplate = (before.match(/`/g) || []).length % 2 !== 0;
    if (!inDouble && !inSingle && !inTemplate) {
      line = before.trimEnd();
    }
  }

  out.push(line);
}

content = out.join("\n");
// 連続空行を1つにまとめてさらに削減（任意）
content = content.replace(/\n{3,}/g, "\n\n");

const newLen = Buffer.byteLength(content, "utf8");
fs.writeFileSync(srcPath, content, "utf8");
console.log(`ModalOutbound.jsx: ${(originalLen / 1024).toFixed(1)} KB -> ${(newLen / 1024).toFixed(1)} KB (${originalLen - newLen} bytes removed)`);
