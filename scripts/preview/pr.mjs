#!/usr/bin/env node
/**
 * Preview worktree を指定 PR の最新 HEAD に切り替える。
 * - 本体 worktree / branch は変更しない
 * - dirty なら停止
 * - package 差分があれば Preview 内で npm ci（本番DB操作なし）
 * - Prisma 変更は警告のみ
 */
import {
  assertClean,
  assertNotRunningInsidePreview,
  callerGitRoot,
  checkoutPrInPreview,
  ensureDeps,
  fail,
  findWorktreeByPath,
  info,
  mustGit,
  parsePrNumber,
  repoRootFromScripts,
  resolvePrHead,
  resolvePreviewPath,
  runGit,
  warnPrismaIfNeeded,
} from "./lib.mjs";

function main() {
  const prNumber = parsePrNumber(process.argv.slice(2));
  const scriptsRoot = repoRootFromScripts();
  const previewPath = resolvePreviewPath(scriptsRoot);
  const callerRoot = callerGitRoot() || scriptsRoot;

  assertNotRunningInsidePreview(previewPath);

  const existing = findWorktreeByPath(scriptsRoot, previewPath);
  if (!existing) {
    fail(
      `Preview worktree がありません: ${previewPath}\n` +
        `先に実行してください: npm run preview:setup`,
    );
  }

  assertClean(previewPath, "Preview worktree");

  const beforeCallerBranch = mustGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: callerRoot,
  });
  const beforeCallerHead = mustGit(["rev-parse", "HEAD"], { cwd: callerRoot });

  info(`PR #${prNumber} の最新 HEAD を取得します…`);
  const pr = resolvePrHead(scriptsRoot, prNumber);

  // Always refresh pull ref so we pick up newly pushed commits.
  const fetchPr = runGit(
    ["fetch", "origin", `pull/${prNumber}/head`],
    { cwd: scriptsRoot },
  );
  if (fetchPr.status !== 0) {
    fail(
      `PR #${prNumber} の fetch に失敗しました。\n${fetchPr.stderr || fetchPr.stdout}`,
    );
  }
  const latestSha = mustGit(["rev-parse", "FETCH_HEAD"], { cwd: scriptsRoot });

  if (pr.headRefOid && pr.headRefOid !== latestSha && pr.source === "gh") {
    info(
      `gh 時点の OID (${pr.headRefOid.slice(0, 7)}) から更新後 HEAD (${latestSha.slice(0, 7)}) を使います。`,
    );
  }

  const titlePart = pr.title ? ` — ${pr.title}` : "";
  info(`Checkout PR #${prNumber}${titlePart}`);
  info(`HEAD: ${latestSha}`);

  checkoutPrInPreview(previewPath, latestSha);

  const afterCallerBranch = mustGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: callerRoot,
  });
  const afterCallerHead = mustGit(["rev-parse", "HEAD"], { cwd: callerRoot });
  if (
    beforeCallerBranch !== afterCallerBranch ||
    beforeCallerHead !== afterCallerHead
  ) {
    fail(
      "本体 worktree の HEAD/branch が変わってしまいました。想定外のため停止します。" +
        ` before=${beforeCallerBranch}@${beforeCallerHead}` +
        ` after=${afterCallerBranch}@${afterCallerHead}`,
    );
  }

  warnPrismaIfNeeded(previewPath);

  const autoCi = process.env.PREVIEW_SKIP_NPM_CI === "1" ? false : true;
  ensureDeps(previewPath, { autoCi });

  const short = mustGit(["rev-parse", "--short", "HEAD"], { cwd: previewPath });
  info("");
  info(`Preview worktree を PR #${prNumber} (${short}) に切り替えました。`);
  info("本体 worktree は変更していません。");
  info("確認（本体側のまま）:");
  info("  npm run preview:dev");
  info("  → http://127.0.0.1:3001");
  if (pr.url) info(`PR: ${pr.url}`);
}

main();
