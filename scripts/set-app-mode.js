#!/usr/bin/env node
/**
 * extensions/common/appUrl.js の APP_MODE を "public" または "inhouse" に書き換える。
 * 使用例: node scripts/set-app-mode.js public
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appUrlPath = path.join(__dirname, "..", "extensions", "common", "appUrl.js");

const mode = process.argv[2]?.toLowerCase();
if (mode !== "public" && mode !== "inhouse") {
  console.error("Usage: node scripts/set-app-mode.js <public|inhouse>");
  process.exit(1);
}

let content = readFileSync(appUrlPath, "utf8");
content = content.replace(
  /const APP_MODE = "(?:public|inhouse)";/,
  `const APP_MODE = "${mode}";`
);
writeFileSync(appUrlPath, content);
console.log(`[set-app-mode] APP_MODE set to "${mode}" in extensions/common/appUrl.js`);
