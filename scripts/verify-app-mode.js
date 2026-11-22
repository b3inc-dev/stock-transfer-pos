#!/usr/bin/env node
/**
 * `shopify app deploy` の前の見張り（#37 の引き継ぎ）。
 *
 * extensions/common/appUrl.js の APP_MODE と、deploy する toml の application_url が合っているかを確かめる。
 * 合わないと、POS の拡張が別のアプリのサーバーを呼び、棚卸の確定などが
 * 「Invalid session token」（401）になる（pos-stock-ciara-251 で本当に起きた）。
 *
 * どの URL がどちらの APP_MODE かは、appUrl.js の PROD_APP_URL_PUBLIC / PROD_APP_URL_INHOUSE から読む
 * （URL を 2 か所に書かない）。合わない・読めないときは exit 1 で止める。
 *
 * 使い方: node scripts/verify-app-mode.js <shopify.app.toml|shopify.app.public.toml>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_URL_FILE = path.join("extensions", "common", "appUrl.js");

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * 文字列だけで確かめる（ファイルを読まない。試験から直接呼ぶ）。
 * @returns {{ ok: true, mode: string, host: string } | { ok: false, error: string, expectedMode?: string }}
 */
export function checkAppMode({ tomlText, appUrlText, tomlName = "toml" }) {
  const urlMatch = String(tomlText ?? "").match(/^\s*application_url\s*=\s*"([^"]+)"/m);
  if (!urlMatch) return { ok: false, error: `${tomlName} に application_url がありません` };
  const host = hostOf(urlMatch[1]);
  if (!host) return { ok: false, error: `${tomlName} の application_url が URL ではありません: ${urlMatch[1]}` };

  const src = String(appUrlText ?? "");
  const modeMatch = src.match(/^\s*const APP_MODE = "(public|inhouse)";/m);
  if (!modeMatch) return { ok: false, error: `${APP_URL_FILE} に APP_MODE（"public" か "inhouse"）がありません` };
  const publicUrl = src.match(/const PROD_APP_URL_PUBLIC = "([^"]+)";/)?.[1];
  const inhouseUrl = src.match(/const PROD_APP_URL_INHOUSE = "([^"]+)";/)?.[1];
  if (!publicUrl || !inhouseUrl) {
    return { ok: false, error: `${APP_URL_FILE} に PROD_APP_URL_PUBLIC / PROD_APP_URL_INHOUSE がありません` };
  }
  const expectedByHost = { [hostOf(publicUrl)]: "public", [hostOf(inhouseUrl)]: "inhouse" };
  const expectedMode = expectedByHost[host];
  if (!expectedMode) {
    return {
      ok: false,
      error:
        `${tomlName} の application_url（${host}）が、${APP_URL_FILE} のどちらの URL とも違います` +
        `（公開用 ${hostOf(publicUrl)} / 自社用 ${hostOf(inhouseUrl)}）`,
    };
  }
  const actualMode = modeMatch[1];
  if (actualMode !== expectedMode) {
    return {
      ok: false,
      expectedMode,
      error:
        `APP_MODE が "${actualMode}" ですが、${tomlName} は ${host}（"${expectedMode}" 用）です。` +
        ` npm run deploy:${expectedMode} を使ってください（または node scripts/set-app-mode.js ${expectedMode}）`,
    };
  }
  return { ok: true, mode: actualMode, host };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const tomlArg = process.argv[2];
  if (!tomlArg) {
    console.error("使い方: node scripts/verify-app-mode.js <shopify.app.toml|shopify.app.public.toml>");
    process.exit(1);
  }
  let tomlText;
  let appUrlText;
  try {
    tomlText = readFileSync(path.resolve(root, tomlArg), "utf8");
    appUrlText = readFileSync(path.join(root, APP_URL_FILE), "utf8");
  } catch (e) {
    console.error(`[verify-app-mode] 止めました: ファイルを読めません（${e instanceof Error ? e.message : String(e)}）`);
    process.exit(1);
  }
  const r = checkAppMode({ tomlText, appUrlText, tomlName: tomlArg });
  if (!r.ok) {
    console.error(`[verify-app-mode] 止めました（deploy していません）: ${r.error}`);
    process.exit(1);
  }
  console.log(`[verify-app-mode] OK: APP_MODE="${r.mode}" と ${tomlArg}（${r.host}）が合っています`);
}
