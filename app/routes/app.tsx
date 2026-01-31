import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
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

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* App Bridge ナビゲーション（location-stock-indicator と同じ s-app-nav / s-link） */}
      {/* @ts-expect-error s-app-nav は App Bridge の Web コンポーネント */}
      <s-app-nav>
        {/* @ts-expect-error s-link は App Bridge の Web コンポーネント */}
        <s-link href="/app" rel="home">設定</s-link>
        <s-link href="/app/history">入出庫履歴</s-link>
        <s-link href="/app/loss">ロス履歴</s-link>
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
