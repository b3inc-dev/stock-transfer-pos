#!/usr/bin/env node
/**
 * Preview worktree で開発サーバーをポート 3001 固定で起動する。
 * 通常の `npm run dev`（shopify app dev → prisma migrate deploy）は使わない。
 * migrate / db push は行わず、prisma generate + react-router dev のみ。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  PREVIEW_PORT,
  PREVIEW_URL,
  assertNotRunningInsidePreview,
  fail,
  findWorktreeByPath,
  info,
  warn,
  repoRootFromScripts,
  resolvePreviewPath,
} from "./lib.mjs";

function main() {
  const scriptsRoot = repoRootFromScripts();
  const previewPath = resolvePreviewPath(scriptsRoot);
  // Scripts live in the caller checkout; still refuse if cwd is the preview tree.
  assertNotRunningInsidePreview(previewPath);

  const existing = findWorktreeByPath(scriptsRoot, previewPath);
  if (!existing) {
    fail(
      `Preview worktree がありません: ${previewPath}\n` +
        `先に本体側で: npm run preview:setup && npm run preview:pr -- <PR番号>`,
    );
  }

  if (!fs.existsSync(path.join(previewPath, "node_modules"))) {
    fail(
      `Preview worktree に node_modules がありません: ${previewPath}\n` +
        `本体側で npm run preview:pr -- <PR番号> を実行するか、` +
        `Preview 内で npm ci してください。`,
    );
  }

  info(`Preview worktree: ${previewPath}`);
  info(`PORT=${PREVIEW_PORT} で起動します → ${PREVIEW_URL}`);
  info(
    "shopify app dev / prisma migrate deploy は使いません（Preview は generate + react-router dev のみ）。",
  );
  warn(
    "通常の npm run dev（3000）と同時起動する場合、Shopify CLI のトンネル/FRONTEND_PORT とは別物です。",
  );

  const env = {
    ...process.env,
    PORT: String(PREVIEW_PORT),
  };

  info("prisma generate（DB変更なし）…");
  const gen = spawnSync("npx", ["prisma", "generate"], {
    cwd: previewPath,
    env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if ((gen.status ?? 1) !== 0) {
    fail(`prisma generate に失敗しました（exit ${gen.status}）。migrate は実行していません。`);
  }

  const child = spawn(
    "npm",
    ["exec", "--", "react-router", "dev"],
    {
      cwd: previewPath,
      env,
      stdio: "inherit",
    },
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (err) => {
    fail(`preview:dev の起動に失敗しました: ${err.message}`);
  });
}

main();
