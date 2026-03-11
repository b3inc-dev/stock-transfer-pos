import { useEffect, useRef } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import { AppNavBar } from "../components/AppNavBar";
import type { ActiveSubscription } from "../utils/billing";
import {
  getPlanFromActiveSubscriptions,
  getMaxLocationsFromSubscriptionName,
  getUsageLineItemId,
  calculateUsageAmount,
  reportUsageRecord,
} from "../utils/billing";

export type ShopPlanFeatures = {
  inventoryInfo: boolean;
  history: boolean;
  purchase: boolean;
  loss: boolean;
  order: boolean;
  stocktake: boolean;
  adjustment: boolean;
};

export type ShopPlan = {
  distribution: "inhouse" | "public";
  plan: "lite" | "pro" | null;
  features: ShopPlanFeatures;
  locationsCount: number;
  /** 開発ストア（partnerDevelopment）のとき true。開発ストアには請求しない方針で全機能を利用可能にする */
  isDevelopmentStore: boolean;
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

/**
 * カスタムアプリとして扱うストアのショップドメイン一覧（カンマ区切り）。
 * 例: CUSTOM_APP_STORE_IDS=my-store.myshopify.com,other.myshopify.com
 * ここに含まれるストアでは常に全機能を解放する（APP_DISTRIBUTION が public でも inhouse 扱い）。
 */
function getCustomAppStoreIds(): string[] {
  const raw = process.env.CUSTOM_APP_STORE_IDS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function getShopPlan(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  currentShop?: string
): Promise<ShopPlan> {
  // カスタムアプリ: APP_DISTRIBUTION=inhouse または 現在のストアが CUSTOM_APP_STORE_IDS に含まれる場合は全機能解放
  const customStoreIds = getCustomAppStoreIds();
  const shopNormalized = currentShop?.trim().toLowerCase();
  const forceInhouse = Boolean(shopNormalized && customStoreIds.some((id) => id.trim().toLowerCase() === shopNormalized));
  const distEnv = (process.env.APP_DISTRIBUTION ?? "").trim().toLowerCase();
  const distribution = (distEnv === "inhouse" || forceInhouse ? "inhouse" : "public") as "inhouse" | "public";

  let locationsCount = 0;
  let isDevelopmentStore = false;
  let planFromBilling: "lite" | "pro" | null = null;
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
        activeSubscriptions = data?.data?.currentAppInstallation?.activeSubscriptions ?? [];
        planFromBilling = getPlanFromActiveSubscriptions(activeSubscriptions);
      } catch {
        // ignore parse error (syntax error, unexpected end of file 等を出さない)
      }
    }
  } catch {
    // ignore
  }

  // プラン: カスタムアプリ（inhouse）では全ての機能を解放。開発ストアは請求しないで全機能。public 本番は Billing から取得
  let plan: "lite" | "pro" | null = null;
  if (distribution === "inhouse") {
    plan = "pro"; // カスタムアプリは常に全機能利用可能
  } else if (isDevelopmentStore) {
    plan = "pro"; // 開発ストアには請求しない。全機能を利用可能にする
  } else {
    plan = planFromBilling; // 公開アプリ本番: activeSubscriptions から判定。未課金なら null（Lite 相当）
  }

  // カスタムアプリ（inhouse）のときは全ての機能を true。公開アプリは plan に応じて制御
  const features: ShopPlanFeatures = {
    inventoryInfo: distribution === "inhouse" || plan === "pro",
    history: true, // 全配布で利用可能
    purchase: distribution === "inhouse" || plan === "pro",
    loss: distribution === "inhouse" || plan === "pro",
    order: distribution === "inhouse" || plan === "pro",
    stocktake: distribution === "inhouse" || plan === "pro",
    adjustment: distribution === "inhouse" || plan === "pro",
  };

  // 公開・本番・Lite/Pro・10ロケーション超のとき、従量課金を 1 回だけ報告（同一期間は idempotencyKey で重複防止）
  if (
    distribution === "public" &&
    !isDevelopmentStore &&
    (plan === "lite" || plan === "pro") &&
    locationsCount > 10
  ) {
    const active = activeSubscriptions.filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE");
    const sub = active.find((s) => getUsageLineItemId(s as ActiveSubscription) && s.currentPeriodEnd) as (ActiveSubscription & { currentPeriodEnd?: string | null }) | undefined;
    const usageLineItemId = sub ? getUsageLineItemId(sub) : null;
    const periodEnd = sub?.currentPeriodEnd;
    if (usageLineItemId && periodEnd) {
      const { amountUsd, extraLocations } = calculateUsageAmount(plan, locationsCount);
      if (amountUsd > 0) {
        const idempotencyKey = `usage-${sub.id}-${periodEnd}`;
        const description = `${extraLocations} extra location(s) (${locationsCount} total): $${amountUsd.toFixed(2)}`;
        reportUsageRecord(admin, usageLineItemId, amountUsd, description, idempotencyKey).catch(() => {
          // ローダーの応答をブロックしない。失敗時は次回アクセス時に再試行される
        });
      }
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
          customStoreIdsCount: customStoreIds.length,
        }
      : undefined;

  return {
    distribution,
    plan,
    features,
    locationsCount,
    isDevelopmentStore,
    ...(locationPlanMismatch ? { locationPlanMismatch: true, maxLocationsForPlan } : {}),
    planDebug,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shopPlan = await getShopPlan(admin, session?.shop);
    const storeHandle =
      session?.shop?.replace(/\.myshopify\.com$/i, "") ?? "";

    // ロケーション数とプランが一致していない場合は、ホームと料金プラン以外へはアクセスさせずプラン変更を促す
    if (shopPlan.locationPlanMismatch) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path !== "/app" && path !== "/app/plan" && !path.startsWith("/app/plan?")) {
        return redirect("/app/plan?mismatch=1");
      }
    }

    // eslint-disable-next-line no-undef
    return { apiKey: process.env.SHOPIFY_API_KEY || "", shopPlan, storeHandle };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    if (/syntax\s*error|unexpected\s*end\s*of\s*file/i.test(String(msg))) {
      console.error("SYNTAX_ERROR_ORIGIN [app layout loader] 親レイアウトで発生。上記 stack の先頭が発生箇所:", stack ?? "no stack");
    }
    throw e;
  }
};

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5分（有料プランでも LB/プロキシのアイドル切断を防ぐ）

export default function App() {
  const { apiKey, shopPlan, storeHandle } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const { features, distribution } = shopPlan;
  const keepaliveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const ping = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        fetch("/app/keepalive", { method: "GET", credentials: "same-origin" }).catch(() => {});
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        ping();
        keepaliveIntervalRef.current = setInterval(ping, KEEPALIVE_INTERVAL_MS);
      } else {
        if (keepaliveIntervalRef.current) {
          clearInterval(keepaliveIntervalRef.current);
          keepaliveIntervalRef.current = null;
        }
      }
    };
    if (document.visibilityState === "visible") {
      keepaliveIntervalRef.current = setInterval(ping, KEEPALIVE_INTERVAL_MS);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (keepaliveIntervalRef.current) {
        clearInterval(keepaliveIntervalRef.current);
        keepaliveIntervalRef.current = null;
      }
    };
  }, []);

  return (
    <AppProvider embedded apiKey={apiKey}>
      {isLoading && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            padding: "12px 16px",
            background: "#2563eb",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 500,
            textAlign: "center",
            zIndex: 9999,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
        >
          読み込み中…
        </div>
      )}
      {/* ホーム・設定・機能メニュー・料金プラン（最後） */}
      {/* @ts-expect-error s-app-nav は App Bridge の Web コンポーネント */}
      <s-app-nav>
        {/* @ts-expect-error s-link は App Bridge の Web コンポーネント */}
        <s-link href="/app" rel="home">ホーム</s-link>
        <s-link href="/app/settings">設定</s-link>
        {features.inventoryInfo && <s-link href="/app/inventory-info">在庫情報</s-link>}
        <s-link href="/app/history">入出庫</s-link>
        {features.purchase && <s-link href="/app/purchase">仕入</s-link>}
        {features.order && <s-link href="/app/order">発注</s-link>}
        {features.loss && <s-link href="/app/loss">ロス</s-link>}
        {features.stocktake && <s-link href="/app/inventory-count">棚卸</s-link>}
        {features.adjustment && <s-link href="/app/adjustment">調整</s-link>}
        {distribution === "public" && <s-link href="/app/plan">料金プラン</s-link>}
      {/* @ts-expect-error s-app-nav 閉じタグ */}
      </s-app-nav>
      {/* 上部メニュー（s-app-nav が表示されない環境用・常に表示） */}
      <AppNavBar shopPlan={shopPlan} />
      {shopPlan.locationPlanMismatch && (
        <div
          style={{
            margin: "8px 16px",
            padding: "12px 16px",
            background: "#fff4e5",
            border: "1px solid #e0b252",
            borderRadius: "8px",
            fontSize: "14px",
            color: "#202223",
          }}
        >
          <strong>ロケーション数がプランと一致していません。</strong>
          <span style={{ marginLeft: "4px" }}>
            現在のプランは{shopPlan.maxLocationsForPlan}ロケーションまでです。ストアのロケーション数（{shopPlan.locationsCount}）に合ったプランに変更するまで、設定・在庫・入出庫などの機能をご利用いただけません。
            <a href="/app/plan" style={{ marginLeft: "8px", color: "#2c6ecb", fontWeight: 600 }}>料金プランで変更する</a>
          </span>
        </div>
      )}
      {shopPlan.planDebug && (
        <div
          style={{
            margin: "8px 16px",
            padding: "12px 16px",
            background: "#f6f6f7",
            border: "1px solid #c9cccf",
            borderRadius: "8px",
            fontSize: "13px",
            fontFamily: "monospace",
            color: "#202223",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: "8px" }}>プラン判定の診断（ENABLE_PLAN_DEBUG=1）</div>
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              <tr><td style={{ padding: "2px 12px 2px 0", verticalAlign: "top" }}>shop</td><td>{shopPlan.planDebug.shop ?? "(なし)"}</td></tr>
              <tr><td style={{ padding: "2px 12px 2px 0", verticalAlign: "top" }}>APP_DISTRIBUTION</td><td>{shopPlan.planDebug.appDistributionValue}</td></tr>
              <tr><td style={{ padding: "2px 12px 2px 0", verticalAlign: "top" }}>distribution（結果）</td><td><strong>{shopPlan.planDebug.distributionResult}</strong></td></tr>
              <tr><td style={{ padding: "2px 12px 2px 0", verticalAlign: "top" }}>CUSTOM_APP_STORE_IDS 件数</td><td>{shopPlan.planDebug.customStoreIdsCount}</td></tr>
              <tr><td style={{ padding: "2px 12px 2px 0", verticalAlign: "top" }}>このストアがリストに含まれる</td><td>{shopPlan.planDebug.shopInCustomList ? "はい" : "いいえ"}</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: "8px", fontSize: "12px", color: "#6d7175" }}>
            distribution が public のままなら、APP_DISTRIBUTION=inhouse をこのサーバーの環境変数に設定するか、CUSTOM_APP_STORE_IDS に上記 shop を追加してください。確認後は ENABLE_PLAN_DEBUG を外してください。
          </div>
        </div>
      )}
      <Outlet context={{ shopPlan, storeHandle }} />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
