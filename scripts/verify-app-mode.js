#!/usr/bin/env node
/**
 * extensions/common/appUrl.js の APP_MODE が、デプロイ対象 toml の application_url と一致するか検証する。
 * 不一致なら exit 1（POS 拡張が別アプリのサーバーを呼び、Invalid session token 401 になるのを防ぐ）。
 * 使用例: node scripts/verify-app-mode.js shopify.app.toml
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrlPath = path.join(root, "extensions", "common", "appUrl.js");

const EXPECTED_MODE_BY_HOST = {
  "stock-transfer-pos.onrender.com": "inhouse",
  "pos-stock.onrender.com": "public",
};

const tomlArg = process.argv[2];
if (!tomlArg) {
  console.error("Usage: node scripts/verify-app-mode.js <shopify.app.toml|shopify.app.public.toml>");
  process.exit(1);
}

const fail = (msg) => {
  console.error(`[verify-app-mode] NG: ${msg}`);
  process.exit(1);
};

const toml = readFileSync(path.resolve(root, tomlArg), "utf8");
const urlMatch = toml.match(/^\s*application_url\s*=\s*"([^"]+)"/m);
if (!urlMatch) fail(`application_url not found in ${tomlArg}`);
const host = new URL(urlMatch[1]).host;
const expectedMode = EXPECTED_MODE_BY_HOST[host];
if (!expectedMode) fail(`unknown application_url host "${host}" in ${tomlArg}`);

const appUrl = readFileSync(appUrlPath, "utf8");
const modeMatch = appUrl.match(/const APP_MODE = "(public|inhouse)";/);
if (!modeMatch) fail(`APP_MODE not found in extensions/common/appUrl.js`);
const actualMode = modeMatch[1];

if (actualMode !== expectedMode) {
  fail(
    `APP_MODE="${actualMode}" but ${tomlArg} application_url is ${host} (expects "${expectedMode}"). ` +
      `Run: node scripts/set-app-mode.js ${expectedMode}`
  );
}
console.log(`[verify-app-mode] OK: APP_MODE="${actualMode}" matches ${tomlArg} (${host})`);
