#!/usr/bin/env node
/**
 * Preview workflow の最小セルフテスト。
 * 一時 PREVIEW_WORKTREE_PATH を使い、本体 branch を汚さない。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packageFilesHash,
  packagesDifferFromMain,
  repoRootFromScripts,
  runGit,
  mustGit,
} from "./lib.mjs";

const repoRoot = repoRootFromScripts();
const setupScript = path.join(repoRoot, "scripts/preview/setup.mjs");
const prScript = path.join(repoRoot, "scripts/preview/pr.mjs");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed += 1;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed += 1;
  }
}

function runNode(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function main() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pos-preview-test-"));
  const previewPath = path.join(tmpBase, "ciara-system-preview");
  const env = {
    PREVIEW_WORKTREE_PATH: previewPath,
    PREVIEW_SKIP_NPM_CI: "1",
  };

  console.log(`Temp preview path: ${previewPath}`);
  const mainBranchBefore = mustGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
  });
  const mainHeadBefore = mustGit(["rev-parse", "HEAD"], { cwd: repoRoot });

  // 1) setup first time
  console.log("\n[1] preview:setup 初回");
  let r = runNode(setupScript, [], env);
  assert(r.status === 0, `setup exit 0 (got ${r.status})`);
  assert(fs.existsSync(path.join(previewPath, ".git")) || fs.existsSync(previewPath), "preview path exists");
  const head1 = mustGit(["rev-parse", "HEAD"], { cwd: previewPath });
  assert(/^[0-9a-f]{40}$/.test(head1), "preview HEAD is a commit");

  // 2) setup reuse
  console.log("\n[2] preview:setup 既存再利用");
  r = runNode(setupScript, [], env);
  assert(r.status === 0, "setup reuse exit 0");
  assert(
    (r.stdout || "").includes("再利用") || (r.stdout || "").includes("reuse"),
    "reuse message present",
  );
  const head2 = mustGit(["rev-parse", "HEAD"], { cwd: previewPath });
  assert(head1 === head2, "HEAD unchanged on reuse");

  // 3) preview:pr happy path — merged PR #2 still fetchable via pull ref
  console.log("\n[3] preview:pr 正常系 (PR #2)");
  r = runNode(prScript, ["--", "2"], env);
  assert(r.status === 0, `preview:pr #2 exit 0 (got ${r.status})\n${r.stderr}\n${r.stdout}`);
  const pr2Head = mustGit(["rev-parse", "HEAD"], { cwd: previewPath });
  assert(/^[0-9a-f]{40}$/.test(pr2Head), "PR checkout has SHA");
  // Fetch expected SHA independently
  mustGit(["fetch", "origin", "pull/2/head"], { cwd: repoRoot });
  const expected2 = mustGit(["rev-parse", "FETCH_HEAD"], { cwd: repoRoot });
  assert(pr2Head === expected2, "preview HEAD matches pull/2/head");

  // 4) nonexistent PR
  console.log("\n[4] 存在しない PR");
  r = runNode(prScript, ["--", "999999"], env);
  assert(r.status !== 0, "nonexistent PR exits non-zero");
  assert(
    /存在しない|失敗|could not|not found|pull\/999999/i.test(
      `${r.stderr}\n${r.stdout}`,
    ),
    "nonexistent PR error message is clear",
  );

  // 5) dirty stop
  console.log("\n[5] dirty 停止");
  fs.writeFileSync(path.join(previewPath, "DIRTY_PREVIEW_TEST.txt"), "dirty\n");
  r = runNode(prScript, ["--", "2"], env);
  assert(r.status !== 0, "dirty preview:pr exits non-zero");
  assert(
    /未コミット|dirty|破棄せず/i.test(`${r.stderr}\n${r.stdout}`),
    "dirty stop message",
  );
  // Ensure file not wiped
  assert(
    fs.existsSync(path.join(previewPath, "DIRTY_PREVIEW_TEST.txt")),
    "dirty file preserved (no clean/reset)",
  );
  fs.unlinkSync(path.join(previewPath, "DIRTY_PREVIEW_TEST.txt"));

  // 6) re-fetch after HEAD update simulation — checkout older then pr again
  console.log("\n[6] HEAD 更新後の再 fetch");
  const originMain = mustGit(["rev-parse", "origin/main"], { cwd: repoRoot });
  mustGit(["checkout", "--detach", originMain], { cwd: previewPath });
  r = runNode(prScript, ["--", "2"], env);
  assert(r.status === 0, "re-fetch preview:pr exit 0");
  const again = mustGit(["rev-parse", "HEAD"], { cwd: previewPath });
  mustGit(["fetch", "origin", "pull/2/head"], { cwd: repoRoot });
  const expectedAgain = mustGit(["rev-parse", "FETCH_HEAD"], { cwd: repoRoot });
  assert(again === expectedAgain, "re-fetch lands on latest pull/2/head");

  // 7) package change detection
  console.log("\n[7] package 変更検知");
  // On current main tip in preview, packages should match origin/main
  mustGit(["checkout", "--detach", originMain], { cwd: previewPath });
  assert(
    packagesDifferFromMain(previewPath, "origin/main") === false,
    "same packages as origin/main → false",
  );
  // Simulate change
  const pkgPath = path.join(previewPath, "package.json");
  const original = fs.readFileSync(pkgPath, "utf8");
  const mutated = original.replace(
    '"private": true',
    '"private": true,\n  "previewTestMarker": true',
  );
  assert(mutated !== original, "mutation applied to package.json text");
  fs.writeFileSync(pkgPath, mutated);
  // packagesDifferFromMain uses git diff HEAD vs origin/main — working tree
  // edit alone may not count. Commit-less: use hash helper instead for WT.
  const hashBefore = packageFilesHash(path.join(repoRoot));
  const hashPreview = packageFilesHash(previewPath);
  assert(hashBefore !== hashPreview, "packageFilesHash detects package.json change");
  // restore to keep worktree clean for cleanup
  fs.writeFileSync(pkgPath, original);

  // Also verify git-based differ when HEAD has different tree: use empty commit? skip.
  // Document: packagesDifferFromMain compares commits (HEAD vs main), hash covers WT.

  // Main worktree unchanged
  console.log("\n[8] 本体 worktree 非影響");
  const mainBranchAfter = mustGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
  });
  const mainHeadAfter = mustGit(["rev-parse", "HEAD"], { cwd: repoRoot });
  assert(mainBranchBefore === mainBranchAfter, "main/feature branch name unchanged");
  assert(mainHeadBefore === mainHeadAfter, "feature worktree HEAD unchanged");

  // Cleanup preview worktree registration (no reset --hard / clean -fd)
  console.log("\n[cleanup]");
  const rm = runGit(["worktree", "remove", previewPath], { cwd: repoRoot });
  if (rm.status !== 0) {
    console.warn(rm.stderr || rm.stdout);
    failed += 1;
  } else {
    console.log("  removed test worktree");
  }
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
