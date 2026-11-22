/**
 * deploy の前の見張り（#37 の引き継ぎ）: APP_MODE と toml の application_url が合わないと止める。
 * Run: node --test tests/verify-app-mode.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const { checkAppMode } = await import("../scripts/verify-app-mode.js");
const root = new URL("..", import.meta.url).pathname;
const read = (f) => readFileSync(path.join(root, f), "utf8");
const appUrl = read("extensions/common/appUrl.js");
const withMode = (mode) => appUrl.replace(/const APP_MODE = "(?:public|inhouse)";/, `const APP_MODE = "${mode}";`);
const inhouseToml = read("shopify.app.toml");
const publicToml = read("shopify.app.public.toml");

describe("checkAppMode", () => {
  it("合っている 2 通りは OK", () => {
    assert.deepEqual(checkAppMode({ tomlText: inhouseToml, appUrlText: withMode("inhouse") }).ok, true);
    assert.deepEqual(checkAppMode({ tomlText: publicToml, appUrlText: withMode("public") }).ok, true);
  });
  it("合わない 2 通りは止める（251 の件: 自社用の toml に public のまま）", () => {
    const a = checkAppMode({ tomlText: inhouseToml, appUrlText: withMode("public") });
    assert.equal(a.ok, false);
    assert.equal(a.expectedMode, "inhouse");
    assert.match(a.error, /deploy:inhouse/);
    const b = checkAppMode({ tomlText: publicToml, appUrlText: withMode("inhouse") });
    assert.equal(b.ok, false);
    assert.equal(b.expectedMode, "public");
  });
  it("どちらの URL とも違う toml は止める", () => {
    const toml = inhouseToml.replace(/application_url = "[^"]+"/, 'application_url = "https://example.trycloudflare.com"');
    const r = checkAppMode({ tomlText: toml, appUrlText: withMode("inhouse") });
    assert.equal(r.ok, false);
  });
  it("application_url が無い・APP_MODE が無い・URL の定数が無いときは止める", () => {
    assert.equal(checkAppMode({ tomlText: "name = 'x'", appUrlText: appUrl }).ok, false);
    assert.equal(checkAppMode({ tomlText: inhouseToml, appUrlText: appUrl.replace(/const APP_MODE = [^;]+;/, "") }).ok, false);
    assert.equal(
      checkAppMode({ tomlText: inhouseToml, appUrlText: withMode("inhouse").replace(/const PROD_APP_URL_INHOUSE = [^;]+;/, "") }).ok,
      false
    );
  });
  it("コメントの中の APP_MODE の例に引っぱられない", () => {
    // appUrl.js の先頭のコメントには「APP_MODE = "inhouse"」の例が書いてある
    assert.match(appUrl, /\/\/ .*APP_MODE = "inhouse"/);
    assert.equal(checkAppMode({ tomlText: publicToml, appUrlText: withMode("public") }).mode, "public");
  });
});

describe("コマンドとして動かす", () => {
  function sandbox(mode) {
    const dir = mkdtempSync(path.join(tmpdir(), "verify-app-mode-"));
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "extensions", "common"), { recursive: true });
    cpSync(path.join(root, "scripts", "verify-app-mode.js"), path.join(dir, "scripts", "verify-app-mode.js"));
    writeFileSync(path.join(dir, "extensions", "common", "appUrl.js"), withMode(mode));
    writeFileSync(path.join(dir, "shopify.app.toml"), inhouseToml);
    writeFileSync(path.join(dir, "shopify.app.public.toml"), publicToml);
    return dir;
  }
  const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, "scripts", "verify-app-mode.js"), ...args], { encoding: "utf8" });

  it("合っていれば exit 0、合わなければ exit 1", () => {
    const dir = sandbox("public");
    assert.equal(run(dir, "shopify.app.public.toml").status, 0);
    const ng = run(dir, "shopify.app.toml");
    assert.equal(ng.status, 1);
    assert.match(ng.stderr, /止めました/);
  });
  it("引数が無い・toml が無いときも exit 1", () => {
    const dir = sandbox("inhouse");
    assert.equal(run(dir).status, 1);
    assert.equal(run(dir, "nope.toml").status, 1);
  });
});

describe("package.json の deploy スクリプト", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const [name, mode, toml] of [
    ["deploy:public", "public", "shopify.app.public.toml"],
    ["deploy:inhouse", "inhouse", "shopify.app.toml"],
  ]) {
    it(`${name}: 書きかえ → 見張り → 同じ toml を --config で deploy の順`, () => {
      const s = pkg.scripts[name];
      const setAt = s.indexOf(`set-app-mode.js ${mode}`);
      const verifyAt = s.indexOf(`verify-app-mode.js ${toml}`);
      const deployAt = s.indexOf(`shopify app deploy --config ${toml}`);
      assert.ok(setAt >= 0 && verifyAt > setAt && deployAt > verifyAt, s);
      // && でつないでいる（見張りが止めたら deploy まで行かない）
      assert.ok(!/;|\|\|/.test(s), s);
    });
  }
});

describe("npm run deploy は止める（見張りを通らないため）", () => {
  const pkg = JSON.parse(read("package.json"));
  it("deploy は shopify app deploy を呼ばず、止めるスクリプトだけを動かす", () => {
    const s = pkg.scripts.deploy;
    assert.equal(s, "node scripts/deploy-blocked.js");
    assert.doesNotMatch(s, /shopify\s+app\s+deploy/);
  });
  it("止めるスクリプトは案内を出して exit 1（deploy:inhouse / deploy:public を使う）", () => {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "deploy-blocked.js")], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /deploy:inhouse か deploy:public を使ってください/);
    assert.equal(r.stdout, "");
  });
  it("shopify app deploy を直接呼ぶのは見張りを通す deploy:public / deploy:inhouse だけ", () => {
    for (const [name, s] of Object.entries(pkg.scripts)) {
      if (!/shopify\s+app\s+deploy/.test(s)) continue;
      assert.ok(name === "deploy:public" || name === "deploy:inhouse", name);
      assert.match(s, /verify-app-mode\.js/, name);
    }
  });
});
