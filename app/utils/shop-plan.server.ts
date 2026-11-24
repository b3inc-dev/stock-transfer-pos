// 料金プランの判定（管理画面のレイアウト・料金プラン画面・各画面の action・POS 用 API が使う共通の 1 か所）。
// 元は app/routes/app.tsx の getShopPlan。決まりは extensions/common/planAccess.js（POS 拡張と同じもの）。
import type { ActiveSubscription } from "./billing";
import {
  getPlanFromActiveSubscriptions,
  getMaxLocationsFromSubscriptionName,
  getUsageLineItemId,
  calculateUsageAmount,
  reportUsageRecord,
} from "./billing";
import { resolvePlanDistribution } from "./plan-distribution";
import { getInhouseClientId, getPublicClientId } from "./shop-install-probe.server";
import {
  decideFeatureAccess,
  featuresForPlanState,
} from "../../extensions/common/planAccess.js";

type AdminGraphql = {
  graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type PlanFeature =
  | "settings"
  | "history"
  | "transfer"
  | "inventoryInfo"
  | "purchase"
  | "loss"
  | "order"
  | "stocktake"
  | "adjustment"
  | "reservation";

export type PlanAccess = "allowed" | "plan_required" | "plan_check_failed";

export type ShopPlanFeatures = Record<PlanFeature, boolean>;

export type ShopPlan = {
  distribution: "inhouse" | "public";
  plan: "lite" | "pro" | null;
  features: ShopPlanFeatures;
  locationsCount: number;
  /** 開発ストア（partnerDevelopment）のとき true。開発ストアもプランを選ぶ（Shopify のテスト課金で請求なし） */
  isDevelopmentStore: boolean;
  /** 公開用で、Shopify から契約の状態を読めなかったとき true。未契約とは分けて「もう一度試す」を案内する */
  planCheckFailed?: boolean;
  /** ロケーション数が契約プラン（3 or 10）を超えている場合 true。プラン変更案内を表示し機能を制限する */
  locationPlanMismatch?: boolean;
  /** 現在のプランが対象とする最大ロケーション数（3 or 10）。locationPlanMismatch 時のみ意味を持つ */
  maxLocationsForPlan?: 3 | 10;
  /** 要因特定用。ENABLE_PLAN_DEBUG=1 のときのみ付与。本番では設定しないこと */
  planDebug?: {
    shop: string | undefined;
    appDistributionValue: string;
    distributionResult: "inhouse" | "public";
    shopInCustomList: boolean;
    customStoreIdsCount: number;
  };
};

/** このサーバー・この店が自社用か公開用か（GraphQL を呼ばない） */
export function getPlanDistribution(shop?: string | null) {
  return resolvePlanDistribution(process.env, shop, getPublicClientId(), getInhouseClientId());
}

/** 自社用（全機能）の ShopPlan。GraphQL を呼ばずに返せるときに使う */
function inhouseShopPlan(): ShopPlan {
  return {
    distribution: "inhouse",
    plan: "pro",
    features: featuresForPlanState({ distribution: "inhouse", plan: "pro" }) as ShopPlanFeatures,
    locationsCount: 0,
    isDevelopmentStore: false,
  };
}

/** getShopPlan が投げたときの代わり（公開用は「読めなかった」として止める） */
export function fallbackShopPlan(shop?: string | null): ShopPlan {
  const { distribution } = getPlanDistribution(shop);
  if (distribution === "inhouse") return inhouseShopPlan();
  return {
    distribution: "public",
    plan: null,
    features: featuresForPlanState({ distribution: "public", plan: null, planCheckFailed: true }) as ShopPlanFeatures,
    locationsCount: 0,
    isDevelopmentStore: false,
    planCheckFailed: true,
  };
}

export async function getShopPlan(admin: AdminGraphql, currentShop?: string): Promise<ShopPlan> {
  const { distribution, forceInhouse } = getPlanDistribution(currentShop);
  const customStoreIdsCount = (process.env.CUSTOM_APP_STORE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).length;

  let locationsCount = 0;
  let isDevelopmentStore = false;
  let planFromBilling: "lite" | "pro" | null = null;
  /** Shopify から契約の一覧を読めたか（読めない＝未契約とは言えない） */
  let subscriptionsRead = false;
  let activeSubscriptions: Array<{ id?: string; name?: string; status?: string; currentPeriodEnd?: string | null; lineItems?: Array<{ id: string; plan?: { pricingDetails?: { __typename?: string } } }> }> = [];
  try {
    const resp = await admin.graphql(
      `#graphql
        query ShopPlanAndLocations($first: Int!) {
          shop {
            plan {
              partnerDevelopment
            }
          }
          locations(first: $first) { nodes { id } }
          currentAppInstallation {
            activeSubscriptions {
              id
              name
              status
              currentPeriodEnd
              lineItems {
                id
                plan {
                  pricingDetails {
                    __typename
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { first: 250 } }
    );
    const text = typeof resp?.text === "function" ? await resp.text() : "";
    if (text && String(text).trim()) {
      try {
        const data = JSON.parse(text) as { data?: { locations?: { nodes?: unknown[] }; shop?: { plan?: { partnerDevelopment?: boolean } }; currentAppInstallation?: { activeSubscriptions?: unknown[] } } };
        locationsCount = data?.data?.locations?.nodes?.length ?? 0;
        isDevelopmentStore = data?.data?.shop?.plan?.partnerDevelopment === true;
        const subs = data?.data?.currentAppInstallation?.activeSubscriptions;
        if (Array.isArray(subs)) {
          subscriptionsRead = true;
          activeSubscriptions = subs as typeof activeSubscriptions;
          planFromBilling = getPlanFromActiveSubscriptions(activeSubscriptions as ActiveSubscription[]);
        }
      } catch {
        // ignore parse error (syntax error, unexpected end of file 等を出さない)
      }
    }
  } catch (e) {
    console.warn("[getShopPlan] plan query failed:", e instanceof Error ? e.message : String(e));
  }

  // プラン: 自社用（inhouse）は全機能。公開用は開発ストアも本番も Shopify の契約（開発ストアはテスト課金）で決める。
  // 契約なしは null（どの機能も使えない）。契約を読めなかったときも null だが planCheckFailed で区別する。
  let plan: "lite" | "pro" | null = null;
  let planCheckFailed = false;
  if (distribution === "inhouse") {
    plan = "pro";
  } else {
    plan = planFromBilling;
    planCheckFailed = !subscriptionsRead;
    if (planCheckFailed) console.warn("[getShopPlan] could not read activeSubscriptions; blocking until it can be read. shop=", currentShop);
  }

  const features = featuresForPlanState({ distribution, plan, planCheckFailed }) as ShopPlanFeatures;

  // 公開・本番・Lite/Pro・10ロケーション超のとき、従量課金を 1 回だけ報告（同一期間は idempotencyKey で重複防止）
  if (
    distribution === "public" &&
    !isDevelopmentStore &&
    (plan === "lite" || plan === "pro") &&
    locationsCount > 10
  ) {
    try {
      const active = activeSubscriptions.filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE");
      const sub = active.find((s) => getUsageLineItemId(s as ActiveSubscription) && s.currentPeriodEnd) as (ActiveSubscription & { currentPeriodEnd?: string | null }) | undefined;
      const usageLineItemId = sub ? getUsageLineItemId(sub) : null;
      const periodEnd = sub?.currentPeriodEnd;
      if (usageLineItemId && periodEnd && sub?.id) {
        const { amountUsd, extraLocations } = calculateUsageAmount(plan, locationsCount);
        if (amountUsd > 0) {
          const idempotencyKey = `usage-${sub.id}-${periodEnd}`;
          const description = `${extraLocations} extra location(s) (${locationsCount} total): $${amountUsd.toFixed(2)}`;
          reportUsageRecord(admin, usageLineItemId, amountUsd, description, idempotencyKey).catch(() => {
            // ローダーの応答をブロックしない。失敗時は次回アクセス時に再試行される
          });
        }
      }
    } catch {
      // Usage 報告失敗で設定・ホーム等の loader を落とさない
    }
  }

  // ロケーション数とプラン（3/10）の一致チェック。公開アプリ・Lite/Pro のときのみ
  let locationPlanMismatch = false;
  let maxLocationsForPlan: 3 | 10 | undefined;
  if (distribution === "public" && !forceInhouse && (plan === "lite" || plan === "pro")) {
    const active = activeSubscriptions.filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE");
    let maxFromPlans: 3 | 10 | null = null;
    for (const s of active) {
      const m = getMaxLocationsFromSubscriptionName(String(s?.name || ""));
      if (m !== null) {
        if (maxFromPlans === null || m > maxFromPlans) maxFromPlans = m;
      }
    }
    if (maxFromPlans !== null && locationsCount > maxFromPlans) {
      locationPlanMismatch = true;
      maxLocationsForPlan = maxFromPlans;
    }
  }

  const planDebug =
    process.env.ENABLE_PLAN_DEBUG === "1"
      ? {
          shop: currentShop,
          appDistributionValue: process.env.APP_DISTRIBUTION ?? "(未設定)",
          distributionResult: distribution,
          shopInCustomList: forceInhouse,
          customStoreIdsCount,
        }
      : undefined;

  return {
    distribution,
    plan,
    features,
    locationsCount,
    isDevelopmentStore,
    ...(planCheckFailed ? { planCheckFailed: true } : {}),
    ...(locationPlanMismatch ? { locationPlanMismatch: true, maxLocationsForPlan } : {}),
    planDebug,
  };
}

/**
 * ShopPlan で機能が使えるか。
 * ロケーション数とプランの不一致（locationPlanMismatch）はここでは見ない（今まで通り管理画面のレイアウトだけが料金プランへ回す）。
 */
export function accessForShopPlan(shopPlan: ShopPlan, feature: PlanFeature): PlanAccess {
  return decideFeatureAccess(shopPlan, feature) as PlanAccess;
}

// 使えると分かった店だけ少しのあいだ覚える（POS の 1 回の確定で API が何度も呼ばれるため）。
// 止めた結果は覚えない（契約した直後にすぐ使えるように）。
const ALLOWED_CACHE_MS = 60_000;
const allowedCache = new Map<string, { plan: ShopPlan; at: number }>();

/**
 * サーバー側の門番。自社用は GraphQL を呼ばずに通す（Ciara の速さを変えない）。
 * 公開用は getShopPlan で契約を読み、機能が使えるかを返す。
 */
export async function checkShopFeatureAccess(args: {
  shop: string;
  feature: PlanFeature;
  getAdmin: () => Promise<AdminGraphql> | AdminGraphql;
}): Promise<{ access: PlanAccess; shopPlan: ShopPlan }> {
  const { distribution } = getPlanDistribution(args.shop);
  if (distribution === "inhouse") return { access: "allowed", shopPlan: inhouseShopPlan() };

  const key = args.shop.trim().toLowerCase();
  const cached = allowedCache.get(key);
  let shopPlan: ShopPlan;
  if (cached && Date.now() - cached.at < ALLOWED_CACHE_MS) {
    shopPlan = cached.plan;
  } else {
    try {
      shopPlan = await getShopPlan(await args.getAdmin(), args.shop);
    } catch (e) {
      console.warn("[checkShopFeatureAccess] getShopPlan failed:", e instanceof Error ? e.message : String(e));
      shopPlan = fallbackShopPlan(args.shop);
    }
    if (shopPlan.plan && !shopPlan.planCheckFailed) {
      allowedCache.set(key, { plan: shopPlan, at: Date.now() });
    } else {
      allowedCache.delete(key);
    }
  }
  const access = accessForShopPlan(shopPlan, args.feature);
  if (access !== "allowed") {
    console.warn(`[plan-gate] blocked: shop=${args.shop} feature=${args.feature} access=${access} plan=${shopPlan.plan ?? "none"}`);
  }
  return { access, shopPlan };
}

/** テスト用 */
export function __clearPlanAccessCacheForTest() {
  allowedCache.clear();
}
