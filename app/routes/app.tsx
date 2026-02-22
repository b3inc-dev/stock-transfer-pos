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
    const data = await resp.json();
    locationsCount = data?.data?.locations?.nodes?.length ?? 0;
    isDevelopmentStore = data?.data?.shop?.plan?.partnerDevelopment === true;
    activeSubscriptions = data?.data?.currentAppInstallation?.activeSubscriptions ?? [];
    planFromBilling = getPlanFromActiveSubscriptions(activeSubscriptions);
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

  return { distribution, plan, features, locationsCount, isDevelopmentStore, planDebug };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopPlan = await getShopPlan(admin, session?.shop);
  const storeHandle =
    session?.shop?.replace(/\.myshopify\.com$/i, "") ?? "";

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shopPlan, storeHandle };
};

export default function App() {
  const { apiKey, shopPlan, storeHandle } = useLoaderData<typeof loader>();
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
