// 料金プランの判定（管理画面のレイアウト・料金プラン画面・各画面の action・POS 用 API が使う共通の 1 か所）。
// 元は app/routes/app.tsx の getShopPlan。決まりは extensions/common/planAccess.js（POS 拡張と同じもの）。
import type { ActiveSubscription } from "./billing";
import {
  getPlanFromActiveSubscriptions,
  getMaxLocationsFromSubscriptionName,
} from "./billing";
import { computeExtraLocationUsage, reportExtraLocationUsage, type UsageReportStore } from "./app-events-usage.server";
import { resolvePlanDistribution } from "./plan-distribution";
import {
  getPartnerActiveSubscription,
  partnerSubscriptionToAdminShape,
  readPartnerApiConfig,
} from "./partner-subscription.server";
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
  | "adjustment";

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
  /**
   * 公開用・Lite/Pro で 10 か所を超えた分（App Events API で 1 請求期間に 1 回報告する数）。
   * 料金プラン画面で店に見せる。自社用・未契約・3 か所プランの不一致のときは無い。
   */
  extraLocationUsage?: {
    units: number;
    unitPriceUsd: number;
    amountUsd: number;
    /** Shopify の currentPeriodEnd（報告の記録 AppUsageReport を引くキー） */
    periodEnd: string | null;
  };
  /** 要因特定用。ENABLE_PLAN_DEBUG=1 のときのみ付与。本番では設定しないこと */
  planDebug?: {
    shop: string | undefined;
    appDistributionValue: string;
    distributionResult: "inhouse" | "public";
    shopInCustomList: boolean;
    customStoreIdsCount: number;
    /** どこから契約を読んだか（partner = Partner API、admin = Admin API） */
    planSource: "partner" | "admin";
    /** Partner API を使えなかった理由（スイッチオフ・設定不足・失敗の理由） */
    partnerStatus?: string;
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
  let shopGid: string | null = null;
  let activeSubscriptions: Array<{ id?: string; name?: string; status?: string; currentPeriodEnd?: string | null }> = [];
  try {
    const resp = await admin.graphql(
      `#graphql
        query ShopPlanAndLocations($first: Int!) {
          shop {
            id
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
            }
          }
        }
      `,
      { variables: { first: 250 } }
    );
    const text = typeof resp?.text === "function" ? await resp.text() : "";
    if (text && String(text).trim()) {
      try {
        const data = JSON.parse(text) as { data?: { locations?: { nodes?: unknown[] }; shop?: { id?: string; plan?: { partnerDevelopment?: boolean } }; currentAppInstallation?: { activeSubscriptions?: unknown[] } } };
        locationsCount = data?.data?.locations?.nodes?.length ?? 0;
        isDevelopmentStore = data?.data?.shop?.plan?.partnerDevelopment === true;
        shopGid = typeof data?.data?.shop?.id === "string" ? data.data.shop.id : null;
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

  // Partner API（既定オフ。PARTNER_API_SUBSCRIPTION_ENABLED=1 と設定がそろったときだけ）。
  // 契約が見つかればそれを正にする。契約なしと答えたら Admin API の結果を使う（Admin に有効な契約があれば止めない）。
  // 失敗（429・timeout など）のときは今まで通り Admin API の結果だけで決める（読めなければ planCheckFailed）。
  let planSource: "partner" | "admin" = "admin";
  let partnerStatus: string | undefined;
  /** プランの名前（Lite/Pro・3/10 か所）を読むための契約。Partner で見つかればその 1 件 */
  let planSubscriptions = activeSubscriptions;
  if (distribution === "public") {
    const partnerConfig = readPartnerApiConfig();
    if (!partnerConfig.enabled) {
      partnerStatus = partnerConfig.reason;
      if (partnerConfig.reason === "missing_config") {
        console.warn("[getShopPlan] PARTNER_API_SUBSCRIPTION_ENABLED=1 but missing:", (partnerConfig.missing ?? []).join(","));
      }
    } else if (!shopGid) {
      partnerStatus = "no_shop_id";
    } else {
      const partner = await getPartnerActiveSubscription({ config: partnerConfig.config, shopGid, shop: currentShop });
      if (!partner.ok) {
        partnerStatus = partner.reason;
      } else if (partner.subscription) {
        const shaped = partnerSubscriptionToAdminShape(partner.subscription, shopGid);
        planSource = "partner";
        subscriptionsRead = true;
        planSubscriptions = [shaped];
        planFromBilling = getPlanFromActiveSubscriptions([shaped] as ActiveSubscription[]);
      } else {
        partnerStatus = "none";
        // Partner は「契約なし」と答えた。Admin を読めなかったときも「未契約」と分かったので止めて案内する
        subscriptionsRead = true;
      }
    }
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

  // ロケーション数とプラン（3/10）の一致チェック。公開アプリ・Lite/Pro のときのみ
  let locationPlanMismatch = false;
  let maxLocationsForPlan: 3 | 10 | undefined;
  if (distribution === "public" && !forceInhouse && (plan === "lite" || plan === "pro")) {
    const active = planSubscriptions.filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE");
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

  // 10 か所を超えた分の従量（App Events API）。公開用・Lite/Pro・3 か所プランの不一致でないときだけ。
  // 送るかどうか・1 期間 1 回・失敗の記録は app-events-usage.server.ts。ここでは待たない（画面と POS の API を遅くしない）。
  let extraLocationUsage: ShopPlan["extraLocationUsage"];
  if (distribution === "public" && !forceInhouse && (plan === "lite" || plan === "pro") && !locationPlanMismatch) {
    const usage = computeExtraLocationUsage(plan, locationsCount);
    if (usage.units > 0) {
      const activeWithPeriod = activeSubscriptions.filter(
        (s) => String(s?.status || "").toUpperCase() === "ACTIVE" && s.currentPeriodEnd
      );
      const periodEnd = activeWithPeriod[0]?.currentPeriodEnd ?? null;
      extraLocationUsage = { units: usage.units, unitPriceUsd: usage.unitPriceUsd, amountUsd: usage.amountUsd, periodEnd };
      const reportPlan = plan;
      const shopForReport = String(currentShop ?? "").trim().toLowerCase();
      if (shopForReport) {
        void import("../db.server")
          .then(({ default: prisma }) =>
            reportExtraLocationUsage(
              { shop: shopForReport, shopGid, plan: reportPlan, locationsCount, periodEnd },
              { store: prisma.appUsageReport as unknown as UsageReportStore }
            )
          )
          .catch((e) => {
            console.error("[getShopPlan] extra location usage report crashed:", e instanceof Error ? e.message : String(e));
          });
      }
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
          planSource,
          ...(partnerStatus ? { partnerStatus } : {}),
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
    ...(extraLocationUsage ? { extraLocationUsage } : {}),
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
