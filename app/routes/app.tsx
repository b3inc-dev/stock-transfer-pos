import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

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
      {/* App Bridge ナビゲーション（在庫情報・入出庫・仕入・ロス・発注・棚卸） */}
      {/* @ts-expect-error s-app-nav は App Bridge の Web コンポーネント */}
      <s-app-nav>
        {/* @ts-expect-error s-link は App Bridge の Web コンポーネント */}
        <s-link href="/app" rel="home">設定</s-link>
        <s-link href="/app/inventory-info">在庫情報</s-link>
        <s-link href="/app/history">入出庫</s-link>
        <s-link href="/app/purchase">仕入</s-link>
        <s-link href="/app/loss">ロス</s-link>
        <s-link href="/app/order">発注</s-link>
        <s-link href="/app/inventory-count">棚卸</s-link>
      {/* @ts-expect-error s-app-nav 閉じタグ */}
      </s-app-nav>
      <Outlet />
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
