import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_FEATURES,
  buildPlanBlockMessage,
  decideFeatureAccess,
  featureForActivity,
  featureForAdminPath,
  featuresForPlanState,
  httpStatusForPlanAccess,
} from "../extensions/common/planAccess.js";
import { checkPosPlanAccess } from "../extensions/common/posPlanGate.js";
import { interpretLogChunkResponse } from "../extensions/common/inventoryLogWrite.js";
import { resolvePlanDistribution } from "../app/utils/plan-distribution.ts";
import { getPlanFromActiveSubscriptions } from "../app/utils/billing.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

describe("decideFeatureAccess: 公開用の未契約は何も使えない", () => {
  test("未契約（plan=null）はすべて plan_required", () => {
    for (const f of ALL_FEATURES) {
      assert.equal(decideFeatureAccess({ distribution: "public", plan: null }, f), "plan_required", f);
    }
  });
  test("契約を読めなかったときは plan_check_failed（未契約とは言わない）", () => {
    for (const f of ALL_FEATURES) {
      assert.equal(decideFeatureAccess({ distribution: "public", plan: null, planCheckFailed: true }, f), "plan_check_failed");
    }
  });
  test("Lite は設定・入出庫だけ", () => {
    const s = { distribution: "public", plan: "lite" };
    assert.deepEqual(
      ALL_FEATURES.filter((f) => decideFeatureAccess(s, f) === "allowed").sort(),
      ["history", "settings", "transfer"]
    );
  });
  test("Pro はすべて", () => {
    for (const f of ALL_FEATURES) assert.equal(decideFeatureAccess({ distribution: "public", plan: "pro" }, f), "allowed");
  });
  test("自社用は契約なしでもすべて使える（Ciara を壊さない）", () => {
    for (const f of ALL_FEATURES) {
      assert.equal(decideFeatureAccess({ distribution: "inhouse", plan: null }, f), "allowed");
      assert.equal(decideFeatureAccess({ distribution: "inhouse", plan: null, planCheckFailed: true }, f), "allowed");
    }
  });
  test("知らない機能名は Lite では使えない（広く開けない）", () => {
    assert.equal(decideFeatureAccess({ distribution: "public", plan: "lite" }, "unknown"), "plan_required");
  });
  test("featuresForPlanState はメニュー用の一覧を返す", () => {
    const f = featuresForPlanState({ distribution: "public", plan: null });
    assert.equal(Object.values(f).some(Boolean), false);
    const lite = featuresForPlanState({ distribution: "public", plan: "lite" });
    assert.equal(lite.history, true);
    assert.equal(lite.loss, false);
  });
});

describe("どの処理がどの機能か", () => {
  test("activity → 機能", () => {
    assert.equal(featureForActivity("outbound_transfer"), "transfer");
    assert.equal(featureForActivity("inbound_transfer"), "transfer");
    assert.equal(featureForActivity("loss_entry"), "loss");
    assert.equal(featureForActivity("purchase_entry"), "purchase");
    assert.equal(featureForActivity("purchase_cancel"), "purchase");
    assert.equal(featureForActivity("adjustment"), "adjustment");
    assert.equal(featureForActivity("inventory_count"), "stocktake");
    // 知らない activity は Pro 扱い
    assert.equal(decideFeatureAccess({ distribution: "public", plan: "lite" }, featureForActivity("something_new")), "plan_required");
  });
  test("管理画面の URL → 機能（ホーム・料金プラン・接続維持は誰でも開ける）", () => {
    assert.equal(featureForAdminPath("/app"), null);
    assert.equal(featureForAdminPath("/app/"), null);
    assert.equal(featureForAdminPath("/app/plan"), null);
    assert.equal(featureForAdminPath("/app/keepalive"), null);
    assert.equal(featureForAdminPath("/app/settings"), "settings");
    assert.equal(featureForAdminPath("/app/history"), "history");
    assert.equal(featureForAdminPath("/app/history/123"), "history");
    assert.equal(featureForAdminPath("/app/loss.data"), "loss");
    assert.equal(featureForAdminPath("/app/inventory-count"), "stocktake");
    assert.equal(featureForAdminPath("/app/export-change-history-csv"), "inventoryInfo");
    assert.equal(featureForAdminPath("/app/additional"), "stocktake"); // 知らない画面は Pro 扱い
    assert.equal(featureForAdminPath("/auth/login"), null);
  });
});

describe("止めたときの文と HTTP", () => {
  test("未契約: 契約が要ること＋どこで選ぶか", () => {
    const m = buildPlanBlockMessage("plan_required", "loss", null);
    assert.equal(m.heading, "料金プランの契約が必要です");
    assert.match(m.body, /ロス/);
    assert.match(m.body, /料金プラン/);
  });
  test("Lite で Pro の機能: Pro に変える案内", () => {
    const m = buildPlanBlockMessage("plan_required", "stocktake", "lite");
    assert.match(m.heading, /棚卸は Pro プラン/);
  });
  test("読めなかった: もう一度試す", () => {
    const m = buildPlanBlockMessage("plan_check_failed", "transfer", null);
    assert.match(m.heading, /確認できませんでした/);
  });
  test("使えるときは文なし", () => {
    assert.equal(buildPlanBlockMessage("allowed", "loss", "pro"), null);
  });
  test("402 は送り直さない、503 は送り直してよい", () => {
    assert.equal(httpStatusForPlanAccess("plan_required"), 402);
    assert.equal(httpStatusForPlanAccess("plan_check_failed"), 503);
    const v = interpretLogChunkResponse(402, { ok: false, errorCode: "plan_required" });
    assert.equal(v.success, false);
    assert.equal(v.retryable, false);
    assert.equal(v.errorCode, "plan_required");
  });
});

describe("resolvePlanDistribution: 自社用を守る", () => {
  const PUBLIC_ID = "public-client-id";
  test("APP_DISTRIBUTION=inhouse は自社用", () => {
    assert.equal(resolvePlanDistribution({ APP_DISTRIBUTION: "inhouse" }, "a.myshopify.com", PUBLIC_ID).distribution, "inhouse");
  });
  test("CUSTOM_APP_STORE_IDS の店は自社用", () => {
    const r = resolvePlanDistribution({ APP_DISTRIBUTION: "public", CUSTOM_APP_STORE_IDS: "x.myshopify.com, A.myshopify.com" }, "a.myshopify.com", PUBLIC_ID);
    assert.equal(r.distribution, "inhouse");
    assert.equal(r.forceInhouse, true);
  });
  test("APP_DISTRIBUTION が空でも API キーが公開用と違えば自社用", () => {
    assert.equal(resolvePlanDistribution({ SHOPIFY_API_KEY: "inhouse-id" }, "a.myshopify.com", PUBLIC_ID).distribution, "inhouse");
  });
  test("公開用の API キーなら公開用", () => {
    assert.equal(resolvePlanDistribution({ SHOPIFY_API_KEY: PUBLIC_ID }, "a.myshopify.com", PUBLIC_ID).distribution, "public");
  });
  test("APP_DISTRIBUTION=public ははっきり公開用", () => {
    assert.equal(resolvePlanDistribution({ APP_DISTRIBUTION: "public", SHOPIFY_API_KEY: "other" }, "a.myshopify.com", PUBLIC_ID).distribution, "public");
  });
  test("何も分からないときは今まで通り公開用", () => {
    assert.equal(resolvePlanDistribution({}, "a.myshopify.com", null).distribution, "public");
  });
});

describe("getPlanFromActiveSubscriptions", () => {
  test("Pro / Lite / なし", () => {
    assert.equal(getPlanFromActiveSubscriptions([{ id: "1", name: "Pro (up to 10 locations)", status: "ACTIVE" }]), "pro");
    assert.equal(getPlanFromActiveSubscriptions([{ id: "1", name: "Lite", status: "ACTIVE" }]), "lite");
    assert.equal(getPlanFromActiveSubscriptions([]), null);
    assert.equal(getPlanFromActiveSubscriptions([{ id: "1", name: "Pro", status: "CANCELLED" }]), null);
  });
  test("有効な契約の名前が読めないときは Lite（払っている店を止めない）", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(getPlanFromActiveSubscriptions([{ id: "1", name: "Basic", status: "ACTIVE" }]), "lite");
    } finally {
      console.warn = warn;
    }
  });
});

describe("checkPosPlanAccess（POS のタイル）", () => {
  const base = { appMode: "public", appUrl: "https://example.test", getSessionToken: async () => "tok" };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  test("自社用の拡張はサーバーに聞かずに通す", async () => {
    let called = false;
    const r = await checkPosPlanAccess("loss", { ...base, appMode: "inhouse", fetchImpl: async () => { called = true; } });
    assert.equal(r.access, "allowed");
    assert.equal(called, false);
  });
  test("使える", async () => {
    let sent = null;
    const r = await checkPosPlanAccess("loss", {
      ...base,
      fetchImpl: async (url, init) => {
        sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
        return resp(200, { ok: true, access: "allowed", plan: "pro" });
      },
    });
    assert.equal(r.access, "allowed");
    assert.equal(sent.url, "https://example.test/api/pos-plan");
    assert.deepEqual(sent.body, { feature: "loss" });
    assert.equal(sent.auth, "Bearer tok");
  });
  test("未契約は理由つきで止める", async () => {
    const r = await checkPosPlanAccess("loss", {
      ...base,
      fetchImpl: async () => resp(402, { ok: false, errorCode: "plan_required", heading: "料金プランの契約が必要です", message: "選んでください" }),
    });
    assert.equal(r.access, "plan_required");
    assert.equal(r.heading, "料金プランの契約が必要です");
    assert.equal(r.message, "選んでください");
  });
  test("通信できない・5xx・トークンなしは「確認できませんでした」で止める", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await checkPosPlanAccess("transfer", { ...base, fetchImpl: async () => { throw new TypeError("Load failed"); } })).access, "plan_check_failed");
      assert.equal((await checkPosPlanAccess("transfer", { ...base, fetchImpl: async () => resp(503, { ok: false, errorCode: "plan_check_failed" }) })).access, "plan_check_failed");
      assert.equal((await checkPosPlanAccess("transfer", { ...base, getSessionToken: async () => "", fetchImpl: async () => resp(200, {}) })).access, "plan_check_failed");
    } finally {
      console.warn = warn;
    }
  });
});

describe("止め口がつながっている（ソースの確認）", () => {
  test("apply-change: 新しいイベントを作る前に止める。completed の再送などは止めない", () => {
    const src = read("app/routes/api.inventory.apply-change.tsx");
    const gate = src.indexOf("await planBlockedPosResponse(");
    const find = src.indexOf("db.inventoryChangeEvent.findUnique({\n      where: { appEventId },\n      include: { lines: true },");
    const create = src.indexOf("db.inventoryChangeEvent.create(");
    const normalize = src.indexOf("await normalizeDeltaEntries(");
    assert.ok(gate > 0 && find > 0 && create > 0 && normalize > 0);
    assert.ok(find < gate, "既存イベントを読んだ後");
    assert.ok(gate < normalize && gate < create, "在庫を読む・イベントを作る前");
    assert.match(src, /if \(!existingEvent \|\| \(existingEvent\.shop === shop && existingEvent\.status === "failed"\)\)/);
  });
  test("log-inventory-change / pos-stocktake-complete: 読めなかっただけなら通す", () => {
    for (const p of ["app/routes/api.log-inventory-change.tsx", "app/routes/api.pos-stocktake-complete.tsx"]) {
      const src = read(p);
      assert.match(src, /planBlockedPosResponse\(/, p);
      assert.match(src, /failOpenOnCheckError: true/, p);
    }
  });
  test("管理画面の action はすべてプランを見る", () => {
    const files = {
      "app/routes/app.adjustment.tsx": "adjustment",
      "app/routes/app.history.tsx": "history",
      "app/routes/app.inventory-count.tsx": "stocktake",
      "app/routes/app.inventory-info.tsx": "inventoryInfo",
      "app/routes/app.loss.tsx": "loss",
      "app/routes/app.order.tsx": "order",
      "app/routes/app.purchase.tsx": "purchase",
      "app/routes/app.settings.tsx": "settings",
    };
    for (const [p, feature] of Object.entries(files)) {
      const src = read(p);
      assert.ok(src.includes(`await adminPlanRedirect(request, admin, session?.shop, "${feature}")`), p);
      assert.ok(src.includes("if (planRedirect) return planRedirect;"), p);
    }
    assert.match(read("app/export-change-history-csv.server.ts"), /checkShopFeatureAccess\(\{ shop: session\?\.shop \?\? "", feature: "inventoryInfo"/);
  });
  test("POS のタイルはすべて PlanGate で包む", () => {
    const tiles = {
      "extensions/stock-transfer-tile/src/ModalOutbound.jsx": "transfer",
      "extensions/stock-transfer-inbound/src/Modal.jsx": "transfer",
      "extensions/stock-transfer-loss/src/Modal.jsx": "loss",
      "extensions/stock-transfer-stocktake/src/Modal.jsx": "stocktake",
      "extensions/stock-transfer-purchase/src/Modal.jsx": "purchase",
      "extensions/stock-transfer-order/src/Modal.jsx": "order",
      "extensions/stock-transfer-adjustment/src/Modal.jsx": "adjustment",
    };
    for (const [p, feature] of Object.entries(tiles)) {
      const src = read(p);
      assert.ok(src.includes(`<PlanGate feature="${feature}"`), p);
      assert.match(src, /getModalApi=\{\(\) => posModalApi\}>\s*<Extension \/>\s*<\/PlanGate>/, p);
    }
  });
});
