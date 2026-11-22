/**
 * 3 ロケーションのプランで 4 か所以上ある店を、POS のタイルを開くときにも止める（2026-11-22 T の決定・D17）。
 * - 判定は 1 か所（billing.ts の decideLocationPlanMismatch → shop-plan.server.ts の getShopPlan）。管理画面と POS が同じ結果を見る
 * - 止めるのは「新しい操作を始めるとき」（/api/pos-plan）だけ。確定の途中の API（apply-change・履歴・棚卸の完了）では止めない
 * - 10 ロケーションのプランは 11 か所以上でも止めない（従量。D15）
 * - 自社用（Ciara）は止めない
 * Run: node --test tests/location-limit.test.mjs
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// app/utils の .ts は拡張子なしで import し合う。テストのときだけ .ts を補い、
// Shopify と DB につなぐファイル（shopify.server / db.server）は何もしない代わりのものにする。
register(
  "data:text/javascript," +
    encodeURIComponent(`
const STUBS = {
  "shopify.server": "export const sessionStorage = {}; export const unauthenticated = {}; export const authenticate = {}; export default {};",
  "db.server": "export default { appUsageReport: {} };",
};
export async function resolve(specifier, context, next) {
  for (const [name, src] of Object.entries(STUBS)) {
    if (specifier.endsWith("/" + name) || specifier.endsWith("/" + name + ".ts")) {
      return { url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true };
    }
  }
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    throw e;
  }
}
`)
);

const {
  buildPlanBlockMessage,
  decideFeatureAccess,
  decideOperationStartAccess,
  httpStatusForPlanAccess,
  requiredPlanForLocations,
  ALL_FEATURES,
  LITE_FEATURES,
} = await import("../extensions/common/planAccess.js");
const { checkPosPlanAccess } = await import("../extensions/common/posPlanGate.js");
const { decideLocationPlanMismatch } = await import("../app/utils/billing.ts");
const { checkShopFeatureAccess, getShopPlan, __clearPlanAccessCacheForTest } = await import(
  "../app/utils/shop-plan.server.ts"
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const active = (name) => ({ id: `gid://shopify/AppSubscription/${name}`, name, status: "ACTIVE", currentPeriodEnd: null, createdAt: null });

/** Admin API のふり。locations か所・契約 subs を返す。呼ばれた回数を数える */
function fakeAdmin({ locations, subs }) {
  const admin = {
    calls: 0,
    async graphql() {
      admin.calls += 1;
      const body = {
        data: {
          shop: { id: "gid://shopify/Shop/1", plan: { partnerDevelopment: false } },
          locations: { nodes: Array.from({ length: locations }, (_, i) => ({ id: `gid://shopify/Location/${i + 1}` })) },
          currentAppInstallation: { activeSubscriptions: subs },
        },
      };
      return { text: async () => JSON.stringify(body) };
    },
  };
  return admin;
}

describe("decideLocationPlanMismatch（判定の 1 か所）", () => {
  test("3 ロケーションのプランで 4 か所以上は止める", () => {
    assert.deepEqual(decideLocationPlanMismatch([active("Lite - 3ロケーション")], 4), { mismatch: true, maxLocations: 3 });
    assert.deepEqual(decideLocationPlanMismatch([active("pro-3")], 7), { mismatch: true, maxLocations: 3 });
  });
  test("3 か所ちょうど・それより少ないときは止めない", () => {
    assert.deepEqual(decideLocationPlanMismatch([active("lite-3")], 3), { mismatch: false });
    assert.deepEqual(decideLocationPlanMismatch([active("lite-3")], 1), { mismatch: false });
  });
  test("10 ロケーションのプランは 11 か所以上でも止めない（従量。D15）", () => {
    assert.deepEqual(decideLocationPlanMismatch([active("Lite - 10ロケーション")], 11), { mismatch: false });
    assert.deepEqual(decideLocationPlanMismatch([active("pro-10")], 40), { mismatch: false });
  });
  test("3 と 10 の契約が両方あるときは大きい方（10）で見る", () => {
    assert.deepEqual(decideLocationPlanMismatch([active("lite-3"), active("pro-10")], 5), { mismatch: false });
  });
  test("名前から数を読めない・アンダースコア・ACTIVE でない契約では止めない（今まで通り）", () => {
    const err = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(decideLocationPlanMismatch([active("Pro")], 50), { mismatch: false });
      assert.deepEqual(decideLocationPlanMismatch([active("lite_3")], 5), { mismatch: false });
      assert.deepEqual(decideLocationPlanMismatch([{ name: "lite-3", status: "CANCELLED" }], 5), { mismatch: false });
      assert.deepEqual(decideLocationPlanMismatch([], 5), { mismatch: false });
    } finally {
      console.error = err;
    }
  });
});

describe("decideOperationStartAccess（タイルを開くとき）", () => {
  const over = (plan) => ({ distribution: "public", plan, locationPlanMismatch: true, maxLocationsForPlan: 3, locationsCount: 5 });
  test("3 ロケーションのプランで多すぎれば location_limit（Lite の機能でも Pro の機能でも）", () => {
    assert.equal(decideOperationStartAccess(over("lite"), "transfer"), "location_limit");
    assert.equal(decideOperationStartAccess(over("lite"), "loss"), "location_limit");
    assert.equal(decideOperationStartAccess(over("pro"), "stocktake"), "location_limit");
  });
  test("自社用は不一致の印があっても通す（Ciara を止めない）", () => {
    for (const f of ALL_FEATURES) {
      assert.equal(decideOperationStartAccess({ ...over("pro"), distribution: "inhouse" }, f), "allowed");
    }
  });
  test("未契約・読めなかったは今まで通りの理由を出す", () => {
    assert.equal(decideOperationStartAccess({ distribution: "public", plan: null, locationPlanMismatch: true }, "transfer"), "plan_required");
    assert.equal(
      decideOperationStartAccess({ distribution: "public", plan: null, planCheckFailed: true, locationPlanMismatch: true }, "transfer"),
      "plan_check_failed"
    );
  });
  test("不一致でなければ decideFeatureAccess と同じ", () => {
    for (const plan of ["lite", "pro", null]) {
      for (const f of ALL_FEATURES) {
        const s = { distribution: "public", plan };
        assert.equal(decideOperationStartAccess(s, f), decideFeatureAccess(s, f), `${plan} ${f}`);
      }
    }
  });
  test("書き込みの API が使う decideFeatureAccess は不一致を見ない（確定の途中で止めない）", () => {
    for (const f of LITE_FEATURES) assert.equal(decideFeatureAccess(over("lite"), f), "allowed");
    for (const f of ALL_FEATURES) assert.equal(decideFeatureAccess(over("pro"), f), "allowed");
  });
});

describe("止めたときの文（プランを上げてください＋要るプラン）", () => {
  test("Lite・Lite の機能 → Lite - 10ロケーション", () => {
    const m = buildPlanBlockMessage("location_limit", "transfer", "lite", { locationsCount: 5, maxLocations: 3 });
    assert.equal(m.heading, "プランを上げてください");
    assert.match(m.body, /3 ロケーションまで/);
    assert.match(m.body, /5 か所/);
    assert.match(m.body, /「Lite - 10ロケーション」/);
    assert.match(m.body, /料金プラン/);
  });
  test("Lite・Pro だけの機能 → Pro - 10ロケーション", () => {
    const m = buildPlanBlockMessage("location_limit", "stocktake", "lite", { locationsCount: 4, maxLocations: 3 });
    assert.match(m.body, /「Pro - 10ロケーション」/);
    assert.deepEqual(requiredPlanForLocations("lite", "stocktake"), { plan: "pro", name: "Pro - 10ロケーション" });
  });
  test("Pro → Pro - 10ロケーション", () => {
    assert.match(buildPlanBlockMessage("location_limit", "transfer", "pro", { locationsCount: 6, maxLocations: 3 }).body, /「Pro - 10ロケーション」/);
  });
  test("数が無くても文は出る", () => {
    const m = buildPlanBlockMessage("location_limit", "transfer", "lite");
    assert.equal(m.heading, "プランを上げてください");
    assert.match(m.body, /3 か所より多い/);
  });
  test("402（送り直しても変わらない）。古い版の拡張も 402 でサーバーの文をそのまま出す", () => {
    assert.equal(httpStatusForPlanAccess("location_limit"), 402);
  });
});

describe("checkPosPlanAccess: location_limit を受けて止める", () => {
  const base = { appMode: "public", appUrl: "https://example.test", getSessionToken: async () => "tok" };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  test("サーバーの見出し・本文・要るプランを出す", async () => {
    const r = await checkPosPlanAccess("transfer", {
      ...base,
      fetchImpl: async () =>
        resp(402, {
          ok: false,
          errorCode: "location_limit",
          plan: "lite",
          heading: "プランを上げてください",
          message: "「Lite - 10ロケーション」に変更してください。",
          locationsCount: 5,
          maxLocations: 3,
          requiredPlan: "Lite - 10ロケーション",
        }),
    });
    assert.equal(r.access, "location_limit");
    assert.equal(r.heading, "プランを上げてください");
    assert.match(r.message, /Lite - 10ロケーション/);
    assert.equal(r.requiredPlan, "Lite - 10ロケーション");
  });
  test("サーバーが文を返さなくても、拡張の側で同じ決まりの文を作る", async () => {
    const r = await checkPosPlanAccess("loss", {
      ...base,
      fetchImpl: async () => resp(402, { ok: false, errorCode: "location_limit", plan: "pro", locationsCount: 4, maxLocations: 3 }),
    });
    assert.equal(r.access, "location_limit");
    assert.match(r.message, /Pro - 10ロケーション/);
  });
  test("自社用の拡張はサーバーに聞かない", async () => {
    let called = false;
    const r = await checkPosPlanAccess("transfer", { ...base, appMode: "inhouse", fetchImpl: async () => { called = true; } });
    assert.equal(r.access, "allowed");
    assert.equal(called, false);
  });
});

describe("サーバーの門番 checkShopFeatureAccess（getShopPlan の本物を通す）", () => {
  const SHOP = "over-limit.myshopify.com";
  const saved = {};
  const KEYS = ["APP_DISTRIBUTION", "CUSTOM_APP_STORE_IDS", "SHOPIFY_API_KEY", "PARTNER_API_SUBSCRIPTION_ENABLED", "APP_EVENTS_USAGE_ENABLED"];
  let warn;
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.APP_DISTRIBUTION = "public";
    delete process.env.CUSTOM_APP_STORE_IDS;
    delete process.env.SHOPIFY_API_KEY;
    delete process.env.PARTNER_API_SUBSCRIPTION_ENABLED;
    delete process.env.APP_EVENTS_USAGE_ENABLED;
    __clearPlanAccessCacheForTest();
    warn = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    console.warn = warn;
  });

  test("getShopPlan: Lite 3 ロケーションで 5 か所 → locationPlanMismatch・上限 3", async () => {
    const plan = await getShopPlan(fakeAdmin({ locations: 5, subs: [active("Lite - 3ロケーション")] }), SHOP);
    assert.equal(plan.plan, "lite");
    assert.equal(plan.locationPlanMismatch, true);
    assert.equal(plan.maxLocationsForPlan, 3);
    assert.equal(plan.locationsCount, 5);
  });
  test("getShopPlan: Lite 10 ロケーションで 12 か所 → 止めない・従量の数が出る（D15 が届くように）", async () => {
    const plan = await getShopPlan(fakeAdmin({ locations: 12, subs: [active("Lite - 10ロケーション")] }), SHOP);
    assert.equal(plan.locationPlanMismatch, undefined);
    assert.equal(plan.extraLocationUsage?.units, 2);
  });
  test("タイルを開くとき（atOperationStart）は location_limit で止める", async () => {
    const admin = fakeAdmin({ locations: 5, subs: [active("lite-3")] });
    const r = await checkShopFeatureAccess({ shop: SHOP, feature: "transfer", getAdmin: () => admin, atOperationStart: true });
    assert.equal(r.access, "location_limit");
    assert.equal(r.shopPlan.maxLocationsForPlan, 3);
  });
  test("書き込みの API（atOperationStart なし）は止めない（確定の途中で半分にしない）", async () => {
    const admin = fakeAdmin({ locations: 5, subs: [active("lite-3")] });
    const r = await checkShopFeatureAccess({ shop: SHOP, feature: "transfer", getAdmin: () => admin });
    assert.equal(r.access, "allowed");
  });
  test("止まる店は覚えない（プランを上げた直後の「もう一度確認」で通れる）", async () => {
    let subs = [active("lite-3")];
    const admin = {
      calls: 0,
      async graphql(...a) {
        return fakeAdmin({ locations: 5, subs }).graphql(...a).finally(() => (admin.calls += 1));
      },
    };
    const first = await checkShopFeatureAccess({ shop: SHOP, feature: "transfer", getAdmin: () => admin, atOperationStart: true });
    assert.equal(first.access, "location_limit");
    subs = [active("lite-10")]; // Shopify でプランを上げた
    const second = await checkShopFeatureAccess({ shop: SHOP, feature: "transfer", getAdmin: () => admin, atOperationStart: true });
    assert.equal(second.access, "allowed");
    assert.equal(admin.calls, 2, "1 回目の結果を覚えていない");
  });
  test("3 か所以内は通す", async () => {
    const admin = fakeAdmin({ locations: 3, subs: [active("pro-3")] });
    const r = await checkShopFeatureAccess({ shop: SHOP, feature: "stocktake", getAdmin: () => admin, atOperationStart: true });
    assert.equal(r.access, "allowed");
  });
  test("自社用（APP_DISTRIBUTION=inhouse）は Shopify に聞かずに通す", async () => {
    process.env.APP_DISTRIBUTION = "inhouse";
    const admin = fakeAdmin({ locations: 30, subs: [active("lite-3")] });
    const r = await checkShopFeatureAccess({ shop: SHOP, feature: "transfer", getAdmin: () => admin, atOperationStart: true });
    assert.equal(r.access, "allowed");
    assert.equal(admin.calls, 0);
  });
  test("自社用の店（CUSTOM_APP_STORE_IDS）は公開用のサーバーでも通す", async () => {
    process.env.CUSTOM_APP_STORE_IDS = SHOP;
    const admin = fakeAdmin({ locations: 30, subs: [active("lite-3")] });
    const r = await checkShopFeatureAccess({ shop: SHOP, feature: "transfer", getAdmin: () => admin, atOperationStart: true });
    assert.equal(r.access, "allowed");
    assert.equal(admin.calls, 0);
  });
});

describe("止め口のつながり（ソースの確認）", () => {
  test("/api/pos-plan だけが atOperationStart: true を渡す", () => {
    const src = read("app/routes/api.pos-plan.tsx");
    assert.match(src, /planBlockedPosResponse\(\{ shop, feature, getAdmin, headers: CORS_HEADERS, atOperationStart: true \}\)/);
    for (const p of [
      "app/routes/api.inventory.apply-change.tsx",
      "app/routes/api.log-inventory-change.tsx",
      "app/routes/api.pos-stocktake-complete.tsx",
      "app/utils/plan-gate.server.ts",
    ]) {
      const s = read(p);
      if (p.endsWith("plan-gate.server.ts")) {
        // adminPlanRedirect は atOperationStart を渡さない（管理画面はレイアウトが止める）
        const admin = s.slice(s.indexOf("export async function adminPlanRedirect"), s.indexOf("export function planBlockedBody"));
        assert.doesNotMatch(admin, /atOperationStart/, p);
      } else {
        assert.doesNotMatch(s, /atOperationStart/, p);
      }
    }
  });
  test("getShopPlan は decideLocationPlanMismatch の 1 か所で決める（自前で数えない）", () => {
    const src = read("app/utils/shop-plan.server.ts");
    assert.match(src, /decideLocationPlanMismatch\(planSubscriptions, locationsCount\)/);
    assert.doesNotMatch(src, /getMaxLocationsFromSubscriptionName/);
  });
  test("POS 拡張はロケーションを数えない（サーバーの答えを出すだけ）", () => {
    for (const p of ["extensions/common/posPlanGate.js", "extensions/common/PlanGate.jsx", "extensions/common/planAccess.js"]) {
      const s = read(p);
      assert.doesNotMatch(s, /locations\s*\(\s*first/, p);
      assert.doesNotMatch(s, /getMaxLocationsFromSubscriptionName/, p);
    }
  });
});
