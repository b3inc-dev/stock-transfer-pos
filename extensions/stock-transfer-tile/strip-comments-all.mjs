#!/usr/bin/env node
/**
 * 64KB 制限対策: バンドルに含まれるファイルからコメントを削除。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "src");

const FILES = [
  "ModalOutbound.jsx",
  "modalHooks.js",
  "modalHelpers.js",
  "modalUiParts.jsx",
  "modalConstants.js",
];

function stripComments(content) {
  content = content.replace(/\/\*(?!\*\/)[\s\S]*?\*\//g, (m) => {
    const lines = m.split("\n").length;
    return lines > 1 ? "\n".repeat(lines - 1) : "";
  });
  content = content.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
  const lines = content.split("\n");
  const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.endsWith("*/")) inBlock = false;
      out.push("");
      continue;
    }
    if (trimmed.startsWith("/*") && !trimmed.endsWith("*/")) {
      inBlock = true;
      out.push("");
      continue;
    }
    if (trimmed.startsWith("//")) {
      out.push("");
      continue;
    }
    if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) {
      out.push("");
      continue;
    }
    if (/^\s*\*[^/]/.test(line) || /^\s*\*\s*$/.test(line)) {
      out.push("");
      continue;
    }
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
  content = content.replace(/\n{3,}/g, "\n\n");
  return content;
}

function shrinkWhitespace(content) {
  const lines = content.split("\n");
  const out = lines.map((line) => {
    const trimmed = line.replace(/[\t ]+$/, "");
    const t = trimmed.trim();
    if (t === "{}" || t === "{ }") return "";
    return trimmed;
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

let totalRemoved = 0;
for (const rel of FILES) {
  const srcPath = path.join(srcDir, rel);
  if (!fs.existsSync(srcPath)) continue;
  let content = fs.readFileSync(srcPath, "utf8");
  const originalLen = Buffer.byteLength(content, "utf8");
  content = stripComments(content);
  content = shrinkWhitespace(content);
  const newLen = Buffer.byteLength(content, "utf8");
  fs.writeFileSync(srcPath, content, "utf8");
  const removed = originalLen - newLen;
  totalRemoved += removed;
  console.log(`${rel}: ${(originalLen / 1024).toFixed(1)} KB -> ${(newLen / 1024).toFixed(1)} KB (${removed} bytes removed)`);
}
console.log(`Total: ${totalRemoved} bytes removed`);
