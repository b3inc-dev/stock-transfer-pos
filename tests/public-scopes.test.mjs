/**
 * 公開用は read_orders を持たない（2026-11-22 T の決定・#79・DECISIONS D18）。自社用（Ciara）は今まで通り。
 * Run: node --test tests/public-scopes.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const { checkPublicScopes, parseScopes, parseWebhookTopics } = await import("../scripts/verify-app-mode.js");
const { INHOUSE_DEFAULT_SCOPES, PUBLIC_DEFAULT_SCOPES, resolveAppScopes } = await import("../app/utils/default-scopes.ts");
const root = new URL("..", import.meta.url).pathname;
const read = (f) => readFileSync(path.join(root, f), "utf8");
const inhouseToml = read("shopify.app.toml");
const publicToml = read("shopify.app.public.toml");
const sorted = (a) => [...a].sort();

describe("toml のスコープ", () => {
  it("公開用は read_orders を持たず、注文・返品の Webhook も受けない", () => {
    assert.ok(!parseScopes(publicToml).includes("read_orders"));
    assert.deepEqual(parseWebhookTopics(publicToml).filter((t) => /^(orders|refunds)\//.test(t)), []);
    assert.deepEqual(checkPublicScopes({ tomlText: publicToml }), { ok: true });
  });
  it("自社用（Ciara）は read_orders と注文・返品の Webhook を今まで通り持つ", () => {
    assert.ok(parseScopes(inhouseToml).includes("read_orders"));
    const topics = parseWebhookTopics(inhouseToml);
    assert.ok(topics.includes("orders/updated"));
    assert.ok(topics.includes("refunds/create"));
  });
  it("read_orders を外しただけで、ほかのスコープは自社用と同じ", () => {
    assert.deepEqual(sorted(parseScopes(publicToml)), sorted(parseScopes(inhouseToml).filter((s) => s !== "read_orders")));
  });
  it("SCOPES が無いときの既定は、それぞれの toml と同じ", () => {
    assert.deepEqual(sorted(INHOUSE_DEFAULT_SCOPES.split(",")), sorted(parseScopes(inhouseToml)));
    assert.deepEqual(sorted(PUBLIC_DEFAULT_SCOPES.split(",")), sorted(parseScopes(publicToml)));
  });
});

describe("resolveAppScopes", () => {
  it("SCOPES があればそれを使う", () => {
    assert.deepEqual(resolveAppScopes(" read_products, read_locations ", "public"), ["read_products", "read_locations"]);
  });
  it("無ければ公開用は read_orders なし、自社用と分からないときは read_orders あり", () => {
    assert.ok(!resolveAppScopes(undefined, "public").includes("read_orders"));
    assert.ok(!resolveAppScopes("  ", "public").includes("read_orders"));
    assert.ok(resolveAppScopes(undefined, "inhouse").includes("read_orders"));
    assert.ok(resolveAppScopes(undefined, null).includes("read_orders"));
  });
  it("shopify.server.ts は料金プランと同じ決まりで公開用／自社用を決める", () => {
    const src = read("app/shopify.server.ts");
    assert.match(src, /resolveAppScopes\(\s*process\.env\.SCOPES,\s*detectServerDistribution\(process\.env, null, getPublicClientId\(\), getInhouseClientId\(\)\)\.distribution/);
    assert.doesNotMatch(src, /"read_inventory,/, "スコープの文字列を 2 か所に書かない");
  });
});

describe("checkPublicScopes（deploy:public の見張り）", () => {
  it("read_orders を足すと止める", () => {
    const toml = publicToml.replace(/^(\s*scopes\s*=\s*")([^"]*)"/m, '$1$2,read_orders"');
    const r = checkPublicScopes({ tomlText: toml });
    assert.equal(r.ok, false);
    assert.match(r.error, /read_orders/);
  });
  it("注文・返品の Webhook のコメントを外すと止める", () => {
    const toml = publicToml.replace('# topics = [ "orders/updated" ]', 'topics = [ "orders/updated" ]');
    assert.notEqual(toml, publicToml);
    const r = checkPublicScopes({ tomlText: toml });
    assert.equal(r.ok, false);
    assert.match(r.error, /orders\/updated/);
    const r2 = checkPublicScopes({ tomlText: publicToml.replace('# topics = [ "refunds/create" ]', 'topics = [ "refunds/create" ]') });
    assert.equal(r2.ok, false);
  });
  it("コメントの中の read_orders・scopes の行には引っぱられない", () => {
    assert.match(publicToml, /#.*read_orders/);
    assert.equal(checkPublicScopes({ tomlText: publicToml }).ok, true);
  });
  it("scopes が無い toml は止める", () => {
    assert.equal(checkPublicScopes({ tomlText: 'name = "x"' }).ok, false);
  });
});

describe("コマンドとして動かす", () => {
  const appUrl = read("extensions/common/appUrl.js");
  function sandbox(mode, pubToml) {
    const dir = mkdtempSync(path.join(tmpdir(), "public-scopes-"));
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "extensions", "common"), { recursive: true });
    cpSync(path.join(root, "scripts", "verify-app-mode.js"), path.join(dir, "scripts", "verify-app-mode.js"));
    writeFileSync(
      path.join(dir, "extensions", "common", "appUrl.js"),
      appUrl.replace(/const APP_MODE = "(?:public|inhouse)";/, `const APP_MODE = "${mode}";`),
    );
    writeFileSync(path.join(dir, "shopify.app.toml"), inhouseToml);
    writeFileSync(path.join(dir, "shopify.app.public.toml"), pubToml);
    return dir;
  }
  const run = (dir, toml) => spawnSync(process.execPath, [path.join(dir, "scripts", "verify-app-mode.js"), toml], { encoding: "utf8" });

  it("公開用の toml に read_orders があると exit 1（deploy:public が止まる）", () => {
    const bad = publicToml.replace(/^(\s*scopes\s*=\s*")([^"]*)"/m, '$1$2,read_orders"');
    const r = run(sandbox("public", bad), "shopify.app.public.toml");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /D18/);
  });
  it("今の公開用 toml は exit 0、自社用は read_orders があっても exit 0", () => {
    assert.equal(run(sandbox("public", publicToml), "shopify.app.public.toml").status, 0);
    assert.equal(run(sandbox("inhouse", publicToml), "shopify.app.toml").status, 0);
  });
});
