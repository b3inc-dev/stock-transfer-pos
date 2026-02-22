import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";

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
};

export async function getShopPlan(admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> }): Promise<ShopPlan> {
  const distribution = (process.env.APP_DISTRIBUTION === "inhouse" ? "inhouse" : "public") as "inhouse" | "public";

  let locationsCount = 0;
  try {
    const locResp = await admin.graphql(
      `#graphql
        query LocationsCount($first: Int!) {
          locations(first: $first) { nodes { id } }
        }
      `,
      { variables: { first: 250 } }
    );
    const locData = await locResp.json();
    locationsCount = locData?.data?.locations?.nodes?.length ?? 0;
  } catch {
    // ignore
  }

  // プラン: 未実装時は stub。inhouse は常に全機能、public は null なら Lite 相当
  let plan: "lite" | "pro" | null = null;
  if (distribution === "inhouse") {
    plan = "pro"; // カスタムは常に全機能
  }
  // public では将来 Billing API で取得。ここでは null（Lite 相当）のまま

  const features: ShopPlanFeatures = {
    inventoryInfo: distribution === "inhouse" || plan === "pro",
    history: true,
    purchase: distribution === "inhouse" || plan === "pro",
    loss: distribution === "inhouse" || plan === "pro",
    order: distribution === "inhouse" || plan === "pro",
    stocktake: distribution === "inhouse" || plan === "pro",
    adjustment: distribution === "inhouse" || plan === "pro",
  };

  return { distribution, plan, features, locationsCount };
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
      {/* ホーム・設定・料金プラン・プラン別メニュー */}
      {/* @ts-expect-error s-app-nav は App Bridge の Web コンポーネント */}
      <s-app-nav>
        {/* @ts-expect-error s-link は App Bridge の Web コンポーネント */}
        <s-link href="/app" rel="home">ホーム</s-link>
        <s-link href="/app/settings">設定</s-link>
        {distribution === "public" && <s-link href="/app/plan">料金プラン</s-link>}
        {features.inventoryInfo && <s-link href="/app/inventory-info">在庫情報</s-link>}
        <s-link href="/app/history">入出庫</s-link>
        {features.purchase && <s-link href="/app/purchase">仕入</s-link>}
        {features.loss && <s-link href="/app/loss">ロス</s-link>}
        {features.order && <s-link href="/app/order">発注</s-link>}
        {features.stocktake && <s-link href="/app/inventory-count">棚卸</s-link>}
        {features.adjustment && <s-link href="/app/adjustment">調整</s-link>}
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
