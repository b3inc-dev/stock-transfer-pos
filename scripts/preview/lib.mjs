import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PREVIEW_PORT = 3001;
export const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
export const DEFAULT_PREVIEW_DIRNAME = "ciara-system-preview";
export const DEPS_HASH_FILE = ".preview-deps-hash";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function repoRootFromScripts() {
  // scripts/preview → repo root (the checkout that contains these scripts)
  return path.resolve(__dirname, "../..");
}

export function resolvePreviewPath(repoRoot = repoRootFromScripts()) {
  if (process.env.PREVIEW_WORKTREE_PATH) {
    return path.resolve(process.env.PREVIEW_WORKTREE_PATH);
  }
  return path.resolve(repoRoot, "..", DEFAULT_PREVIEW_DIRNAME);
}

/** git toplevel of process.cwd(); used to detect "run from preview by mistake". */
export function callerGitRoot() {
  const result = runGit(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (result.status !== 0) {
    return null;
  }
  return path.resolve(result.stdout);
}

export function assertNotRunningInsidePreview(previewPath) {
  const caller = callerGitRoot();
  if (caller && path.resolve(caller) === path.resolve(previewPath)) {
    fail(
      "Preview worktree 内から実行されています。本体側の checkout（preview スクリプトがある dir）から実行してください。\n" +
        `preview: ${previewPath}`,
    );
  }
}

export function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    cwd: options.cwd,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error,
  };
}

export function mustGit(args, options = {}) {
  const result = runGit(args, options);
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.status}`;
    const err = new Error(detail);
    err.gitStatus = result.status;
    err.gitStderr = result.stderr;
    err.gitStdout = result.stdout;
    throw err;
  }
  return result.stdout;
}

export function isDirty(cwd) {
  const out = mustGit(["status", "--porcelain"], { cwd });
  return out.length > 0;
}

export function assertClean(cwd, label = "worktree") {
  if (isDirty(cwd)) {
    const status = mustGit(["status", "--porcelain"], { cwd });
    fail(
      `${label} に未コミット変更があります。破棄せず停止します。\n` +
        `path: ${cwd}\n` +
        `${status}\n` +
        `手動でコミットするか変更を退避してから再実行してください。` +
        `（git reset --hard / git clean -fd は使いません）`,
    );
  }
}

export function listWorktrees(repoRoot) {
  const out = mustGit(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const items = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) items.push(current);
      current = { path: line.slice("worktree ".length), bare: false, detached: false, branch: null, head: null };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "") {
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  return items;
}

export function findWorktreeByPath(repoRoot, targetPath) {
  const resolved = path.resolve(targetPath);
  return listWorktrees(repoRoot).find((w) => path.resolve(w.path) === resolved) || null;
}

export function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

export function info(message) {
  console.log(message);
}

export function warn(message) {
  console.warn(`Warning: ${message}`);
}

export function packageFilesHash(cwd) {
  const files = ["package.json", "package-lock.json"];
  const hash = createHash("sha256");
  for (const file of files) {
    const full = path.join(cwd, file);
    hash.update(file);
    hash.update("\0");
    if (fs.existsSync(full)) {
      hash.update(fs.readFileSync(full));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function packagesDifferFromMain(previewRoot, mainRef = "origin/main") {
  const result = runGit(
    ["diff", "--quiet", mainRef, "HEAD", "--", "package.json", "package-lock.json"],
    { cwd: previewRoot },
  );
  // diff --quiet: 0 = same, 1 = different, other = error
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  // If mainRef missing etc., treat as unknown/different for safety messaging
  warn(`main との package 差分確認に失敗しました: ${result.stderr || result.stdout}`);
  return true;
}

export function prismaChangedFromMain(previewRoot, mainRef = "origin/main") {
  const result = runGit(
    ["diff", "--name-only", mainRef, "HEAD", "--", "prisma"],
    { cwd: previewRoot },
  );
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ensureDeps(previewRoot, { autoCi = true } = {}) {
  const hash = packageFilesHash(previewRoot);
  const hashFile = path.join(previewRoot, DEPS_HASH_FILE);
  const nodeModules = path.join(previewRoot, "node_modules");
  const previous = fs.existsSync(hashFile)
    ? fs.readFileSync(hashFile, "utf8").trim()
    : "";
  const differMain = packagesDifferFromMain(previewRoot);
  // Only install when modules are missing or the lock/manifest hash changed.
  // differMain is informational (vs main) and must not force reinstall every switch.
  const needsCi = !fs.existsSync(nodeModules) || previous !== hash;

  if (differMain) {
    info(
      "package.json / package-lock.json が origin/main と異なります。" +
        (needsCi
          ? " Preview worktree 内で npm ci が必要です。"
          : " 現在の Preview 依存ハッシュは一致済みです。"),
    );
  }

  if (!needsCi) {
    info("依存関係は最新です（npm ci スキップ）。");
    return { ranCi: false, differMain, needsCi: false };
  }

  if (!autoCi) {
    info("npm ci が必要です。Preview worktree で手動実行してください:");
    info(`  cd ${previewRoot} && npm ci`);
    return { ranCi: false, differMain, needsCi: true };
  }

  info("Preview worktree 内のみで npm ci を実行します…");
  const result = spawnSync("npm", ["ci"], {
    cwd: previewRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    fail(`npm ci に失敗しました（exit ${result.status}）。Preview worktree: ${previewRoot}`);
  }
  fs.writeFileSync(hashFile, `${hash}\n`, "utf8");
  info(`依存関係を更新しました（${DEPS_HASH_FILE} を記録）。`);
  return { ranCi: true, differMain, needsCi: true };
}

export function warnPrismaIfNeeded(previewRoot) {
  const changed = prismaChangedFromMain(previewRoot);
  if (changed.length === 0) return;
  warn(
    "Prisma schema / migration が origin/main から変更されています。\n" +
      changed.map((f) => `  - ${f}`).join("\n") +
      "\n" +
      "db push / migrate apply / production DB 操作は自動実行しません。必要なら人間が Preview 用のローカルDBだけで判断してください。",
  );
}

/**
 * Resolve PR head SHA via gh, with git fetch refs/pull/<n>/head fallback.
 */
export function resolvePrHead(repoRoot, prNumber) {
  const gh = spawnSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "number,title,state,url,headRefOid,headRefName"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  if (!gh.error && gh.status === 0 && gh.stdout) {
    try {
      const data = JSON.parse(gh.stdout);
      if (!data.headRefOid) {
        throw new Error("headRefOid missing");
      }
      return {
        source: "gh",
        number: data.number,
        title: data.title,
        state: data.state,
        url: data.url,
        headRefOid: data.headRefOid,
        headRefName: data.headRefName,
      };
    } catch (e) {
      warn(`gh pr view の解析に失敗。git fetch fallback を使います: ${e.message}`);
    }
  } else {
    const detail = (gh.stderr || gh.stdout || gh.error?.message || "").trim();
    if (detail) {
      // Distinguish "not found" when possible
      if (/could not find|not found|no pull requests found|HTTP 404/i.test(detail)) {
        fail(
          `PR #${prNumber} は存在しないか参照できません。\n${detail}`,
        );
      }
      warn(`gh 利用不可または失敗。git fetch fallback を使います: ${detail}`);
    } else {
      warn("gh 利用不可。git fetch fallback を使います。");
    }
  }

  // Ensure we can fetch PR refs
  const fetch = runGit(
    ["fetch", "origin", `pull/${prNumber}/head`],
    { cwd: repoRoot },
  );
  if (fetch.status !== 0) {
    fail(
      `PR #${prNumber} の取得に失敗しました（存在しないか権限がありません）。\n` +
        `${fetch.stderr || fetch.stdout}`,
    );
  }

  const sha = mustGit(["rev-parse", "FETCH_HEAD"], { cwd: repoRoot });
  return {
    source: "git-fetch",
    number: Number(prNumber),
    title: null,
    state: null,
    url: null,
    headRefOid: sha,
    headRefName: `refs/pull/${prNumber}/head`,
  };
}

export function checkoutPrInPreview(previewRoot, headSha) {
  assertClean(previewRoot, "Preview worktree");
  // Objects are shared across worktrees; caller must have fetched the PR ref.
  // Detached checkout — does not move the main worktree branch.
  const result = runGit(["checkout", "--detach", headSha], { cwd: previewRoot });
  if (result.status !== 0) {
    fail(
      `Preview worktree の checkout に失敗しました（未コミット変更の可能性あり。破棄はしません）。\n` +
        `${result.stderr || result.stdout}`,
    );
  }
  const actual = mustGit(["rev-parse", "HEAD"], { cwd: previewRoot });
  if (actual !== headSha) {
    fail(`checkout 後の HEAD (${actual}) が期待 (${headSha}) と一致しません。`);
  }
  return actual;
}

export function parsePrNumber(argv) {
  // Supports: preview:pr -- 27   |  preview:pr 27
  const args = argv.filter((a) => a !== "--");
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    fail("使い方: npm run preview:pr -- <PR番号>");
  }
  const n = Number(args[0]);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`不正な PR 番号です: ${args[0]}`);
  }
  return n;
}
