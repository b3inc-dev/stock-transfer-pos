/**
 * POS のタイルを開いたとき、この機能を今の料金プランで使えるかをサーバーに聞く。
 * - 自社用（appUrl.js の APP_MODE = "inhouse"）はサーバーに聞かずに通す（今まで通り全機能）
 * - 公開用: /api/pos-plan に聞く。使えないときは理由と案内を返す
 * - 通信できない・契約を読めない: 止めて「もう一度試す」を出す（契約が要るとは言わない）
 * - 3 ロケーションのプランでロケーションが多すぎる（location_limit）: 止めて「プランを上げてください」と要るプランを出す。
 *   タイルを開くときだけ。開いたあとの確定の途中では止めない（半分だけ動かさないため）
 *
 * 画面を止めるだけでは足りないので、サーバー側（apply-change など）でも同じ決まりで止めている。
 * 出庫の Transfer 作成は POS から Shopify へ直接送るため、サーバーでは止められない。ここが唯一の止め口。
 */
import { buildPlanBlockMessage } from "./planAccess.js";

const PLAN_CHECK_TIMEOUT_MS = 15000;

/**
 * @param {import("./planAccess.js").PlanFeature} feature
 * @param {{ fetchImpl?: typeof fetch, appMode?: string, appUrl?: string, getSessionToken?: () => Promise<string> }} [deps] - テスト用
 * @returns {Promise<{ access: "allowed"|"plan_required"|"plan_check_failed"|"location_limit", heading?: string, message?: string, plan?: string|null, requiredPlan?: string|null }>}
 */
export async function checkPosPlanAccess(feature, deps = {}) {
  const appUrlMod = deps.appMode && deps.appUrl ? null : await import("./appUrl.js");
  const appMode = deps.appMode ?? appUrlMod.getAppMode();
  if (appMode === "inhouse") return { access: "allowed" };

  const fail = (plan) => {
    const msg = buildPlanBlockMessage("plan_check_failed", feature, plan);
    return { access: "plan_check_failed", heading: msg.heading, message: msg.body, plan: plan ?? null };
  };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const getToken = deps.getSessionToken ?? (() => globalThis?.shopify?.session?.getSessionToken?.());
  const appUrl = deps.appUrl ?? appUrlMod.getAppUrl();

  let res;
  let data;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), PLAN_CHECK_TIMEOUT_MS) : null;
  try {
    const token = await getToken();
    if (!token) return fail(null);
    res = await fetchImpl(`${appUrl}/api/pos-plan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ feature }),
      signal: controller ? controller.signal : undefined,
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.warn("[posPlanGate] plan check failed:", e?.message ?? e);
    return fail(null);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.ok && data?.ok === true && data?.access === "allowed") {
    return { access: "allowed", plan: data?.plan ?? null };
  }
  const code = data?.errorCode;
  // 3 ロケーションのプランでロケーションが多すぎる（サーバーの getShopPlan が決める。拡張では数えない）
  if (code === "location_limit") {
    const msg = buildPlanBlockMessage("location_limit", feature, data?.plan, {
      locationsCount: data?.locationsCount,
      maxLocations: data?.maxLocations,
    });
    return {
      access: "location_limit",
      heading: data?.heading || msg.heading,
      message: data?.message || msg.body,
      plan: data?.plan ?? null,
      requiredPlan: data?.requiredPlan ?? null,
    };
  }
  if (res.status === 402 || code === "plan_required") {
    const msg = buildPlanBlockMessage("plan_required", feature, data?.plan);
    return {
      access: "plan_required",
      heading: data?.heading || msg.heading,
      message: data?.message || msg.body,
      plan: data?.plan ?? null,
    };
  }
  // 401・5xx・その他は「確認できなかった」。もう一度試してもらう
  console.warn("[posPlanGate] plan check not ok:", res.status, code);
  return fail(data?.plan);
}
