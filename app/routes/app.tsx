import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";
import type { ActiveSubscription } from "../utils/billing";
import {
  getPlanFromActiveSubscriptions,
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
};

export async function getShopPlan(admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> }): Promise<ShopPlan> {
  const distribution = (process.env.APP_DISTRIBUTION === "inhouse" ? "inhouse" : "public") as "inhouse" | "public";

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
    const data = await resp.json();
    locationsCount = data?.data?.locations?.nodes?.length ?? 0;
    isDevelopmentStore = data?.data?.shop?.plan?.partnerDevelopment === true;
    activeSubscriptions = data?.data?.currentAppInstallation?.activeSubscriptions ?? [];
    planFromBilling = getPlanFromActiveSubscriptions(activeSubscriptions);
  } catch {
    // ignore
  }

  // プラン: inhouse は常に全機能、開発ストアは請求しないで全機能、public 本番は Billing から取得
  let plan: "lite" | "pro" | null = null;
  if (distribution === "inhouse") {
    plan = "pro"; // カスタムは常に全機能
  } else if (isDevelopmentStore) {
    plan = "pro"; // 開発ストアには請求しない。全機能を利用可能にする
  } else {
    plan = planFromBilling; // 公開アプリ本番: activeSubscriptions から判定。未課金なら null（Lite 相当）
  }

  const features: ShopPlanFeatures = {
    inventoryInfo: distribution === "inhouse" || plan === "pro",
    history: true,
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

  return { distribution, plan, features, locationsCount, isDevelopmentStore };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const shopPlan = await getShopPlan(admin);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shopPlan };
};

export default function App() {
  const { apiKey, shopPlan } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const { features, distribution } = shopPlan;

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
      <Outlet context={{ shopPlan }} />
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
