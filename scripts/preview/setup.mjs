#!/usr/bin/env node
/**
 * Preview 専用 worktree を安全に準備する。
 * - 既にあれば再利用（二重作成しない）
 * - 本体（呼び出し元）の branch は切り替えない
 * - dirty なら破棄せず停止
 */
import fs from "node:fs";
import {
  assertClean,
  assertNotRunningInsidePreview,
  ensureDeps,
  fail,
  findWorktreeByPath,
  info,
  mustGit,
  repoRootFromScripts,
  resolvePreviewPath,
  runGit,
} from "./lib.mjs";

function main() {
  const scriptsRoot = repoRootFromScripts();
  const previewPath = resolvePreviewPath(scriptsRoot);

  info(`Scripts checkout: ${scriptsRoot}`);
  info(`Preview worktree: ${previewPath}`);
  assertNotRunningInsidePreview(previewPath);

  // Refresh main tip for initial checkout material; does not switch branches.
  const fetchMain = runGit(["fetch", "origin", "main"], { cwd: scriptsRoot });
  if (fetchMain.status !== 0) {
    fail(`origin/main の fetch に失敗しました:\n${fetchMain.stderr || fetchMain.stdout}`);
  }

  const existing = findWorktreeByPath(scriptsRoot, previewPath);
  if (existing) {
    assertClean(previewPath, "Preview worktree");
    const head = mustGit(["rev-parse", "--short", "HEAD"], { cwd: previewPath });
    info(`既存の Preview worktree を再利用します（HEAD ${head}）。`);
  } else if (fs.existsSync(previewPath)) {
    const entries = fs.readdirSync(previewPath);
    fail(
      `パスは存在しますが git worktree として登録されていません: ${previewPath}\n` +
        `（エントリ数: ${entries.length}）。手動確認してください。自動削除・上書きはしません。`,
    );
  } else {
    // Create detached worktree at origin/main — does not move current branch.
    const add = runGit(
      ["worktree", "add", "--detach", previewPath, "origin/main"],
      { cwd: scriptsRoot },
    );
    if (add.status !== 0) {
      fail(`Preview worktree の作成に失敗しました:\n${add.stderr || add.stdout}`);
    }
    const head = mustGit(["rev-parse", "--short", "HEAD"], { cwd: previewPath });
    info(`Preview worktree を作成しました（detached @ origin/main, HEAD ${head}）。`);
  }

  const autoCi = process.env.PREVIEW_SKIP_NPM_CI === "1" ? false : true;
  ensureDeps(previewPath, { autoCi });

  info("");
  info("次のステップ（すべて本体側の checkout で実行）:");
  info("  npm run preview:pr -- <PR番号>");
  info("  npm run preview:dev");
  info(`  → ${"http://127.0.0.1:3001"}`);
  info("cd して Preview 内で preview:* を回す必要はありません。");
}

main();
