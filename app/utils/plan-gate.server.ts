// 料金プランの門番（サーバー側）。画面を隠すだけにせず、書き込む処理の入口で止める。
// - 管理画面の action: adminPlanRedirect（親のレイアウト loader は action の前に走らないため）
// - POS 用 API: planBlockedPosResponse（apply-change / log-inventory-change / pos-stocktake-complete / pos-plan）
//   ロケーション数の上限（3 ロケーションのプラン）は pos-plan（タイルを開くとき）だけで見る（atOperationStart）
// 決まりは extensions/common/planAccess.js、判定は shop-plan.server.ts の checkShopFeatureAccess。
import { redirect } from "react-router";
import {
  buildPlanBlockMessage,
  featureForAdminPath,
  httpStatusForPlanAccess,
  requiredPlanForLocations,
} from "../../extensions/common/planAccess.js";
import type { PlanAccess, PlanFeature } from "./shop-plan.server";
import { checkShopFeatureAccess } from "./shop-plan.server";

type AdminGraphql = {
  graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/**
 * 管理画面の action の最初で呼ぶ（authenticate.admin の後）。
 * 使えないときは料金プランへ回す redirect を返す（各 action の try の中で呼べるよう、投げずに返す）。
 * 自社用は GraphQL を呼ばずに null を返す。
 */
export async function adminPlanRedirect(
  request: Request,
  admin: AdminGraphql,
  shop: string | undefined | null,
  feature?: PlanFeature,
): Promise<Response | null> {
  const f = (feature ?? featureForAdminPath(new URL(request.url).pathname)) as PlanFeature | null;
  if (!f) return null;
  const { access } = await checkShopFeatureAccess({ shop: String(shop ?? ""), feature: f, getAdmin: () => admin });
  if (access === "allowed") return null;
  return redirect(`/app/plan?required=${encodeURIComponent(f)}`);
}

/** POS へ返す止めたときの中身（UI_RULES 5章: 何が起きたか＋どうすればいいか） */
export function planBlockedBody(
  access: PlanAccess,
  feature: PlanFeature,
  plan: string | null | undefined,
  locations?: { locationsCount?: number; maxLocations?: number },
) {
  const msg = buildPlanBlockMessage(access, feature, plan, locations ?? {});
  const need = access === "location_limit" ? requiredPlanForLocations(plan, feature) : null;
  return {
    ok: false,
    errorCode: access,
    planAccess: access,
    feature,
    plan: plan ?? null,
    ...(access === "location_limit"
      ? {
          locationsCount: locations?.locationsCount ?? null,
          maxLocations: locations?.maxLocations ?? null,
          requiredPlan: need?.name ?? null,
        }
      : {}),
    error: msg ? `${msg.heading}。${msg.body}` : "この機能は使えません",
    heading: msg?.heading ?? "",
    message: msg?.body ?? "",
  };
}

/**
 * POS 用 API の入口で呼ぶ。使えるなら null、使えないなら返す Response。
 * failOpenOnCheckError=true のとき、契約を「読めなかった」だけなら通す
 * （在庫がもう Shopify で動いた後の記録・完了の通知を、読み取りの一時的な失敗で落とさないため）。
 */
export async function planBlockedPosResponse(args: {
  shop: string;
  feature: PlanFeature;
  getAdmin: () => Promise<AdminGraphql> | AdminGraphql;
  headers: Record<string, string>;
  failOpenOnCheckError?: boolean;
  /**
   * 新しい操作を始めるときだけ true（今は /api/pos-plan だけ）。3 ロケーションのプランで多すぎれば止める。
   * 書き込みの API（apply-change・log-inventory-change・pos-stocktake-complete）では付けない（確定の途中で止めない）。
   */
  atOperationStart?: boolean;
}): Promise<Response | null> {
  const { access, shopPlan } = await checkShopFeatureAccess({
    shop: args.shop,
    feature: args.feature,
    getAdmin: args.getAdmin,
    atOperationStart: args.atOperationStart === true,
  });
  if (access === "allowed") return null;
  if (access === "plan_check_failed" && args.failOpenOnCheckError) {
    console.warn(`[plan-gate] plan check failed; allowing follow-up write: shop=${args.shop} feature=${args.feature}`);
    return null;
  }
  const locations = { locationsCount: shopPlan.locationsCount, maxLocations: shopPlan.maxLocationsForPlan };
  return new Response(JSON.stringify(planBlockedBody(access, args.feature, shopPlan.plan, locations)), {
    status: httpStatusForPlanAccess(access),
    headers: { "Content-Type": "application/json", ...args.headers },
  });
}
