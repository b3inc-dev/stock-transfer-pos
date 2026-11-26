import { outboundRequestsEnabled } from "../utils/outbound-requests.server";
import { useEffect, useRef } from "react";
import type { HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { Outlet, redirect, useLoaderData, useNavigation, useRouteError, data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import "@shopify/polaris/build/esm/styles.css";

import { reservationPrivacyAvailable, reservationsEnabled } from "../utils/reservations.server";
import { authenticate } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { isInventoryCountReadOnlySubmission } from "../utils/inventory-count-revalidation";
import { AppNavBar } from "../components/AppNavBar";
import type { ShopPlan } from "../utils/shop-plan.server";
import { accessForShopPlan, fallbackShopPlan, getShopPlan } from "../utils/shop-plan.server";
import { featureForAdminPath } from "../../extensions/common/planAccess.js";

export type { ShopPlan, ShopPlanFeatures } from "../utils/shop-plan.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const adminApi = withGraphQLRetry(admin);
    let shopPlan: ShopPlan;
    try {
      shopPlan = await getShopPlan(adminApi, session?.shop);
    } catch (planErr) {
      // getShopPlan 失敗で設定・全 /app が 500 にならないようフォールバック（審査 2.1.1）。公開用は「読めなかった」として止める
      console.error("[app layout] getShopPlan failed:", planErr instanceof Error ? planErr.message : planErr);
      shopPlan = fallbackShopPlan(session?.shop);
    }
    const storeHandle =
      session?.shop?.replace(/\.myshopify\.com$/i, "") ?? "";

    // ロケーション数とプランが一致していない場合は、ホームと料金プラン以外へはアクセスさせずプラン変更を促す
    if (shopPlan.locationPlanMismatch) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path !== "/app/reservations/customer-data" && path !== "/app/reservation-privacy" && path !== "/app/reservations/privacy" && path !== "/app" && path !== "/app/plan" && !path.startsWith("/app/plan?")) {
        return redirect("/app/plan?mismatch=1");
      }
    }

    // 公開用で、この画面の機能を今のプランで使えないときは料金プランへ回す（未契約・Lite で Pro の画面・契約を読めなかった）。
    // 画面の action は親の loader を通らないので、各 action でも adminPlanRedirect（app/utils/plan-gate.server.ts）で止めている。
    const url = new URL(request.url);
    const feature = featureForAdminPath(url.pathname);
    if (feature && accessForShopPlan(shopPlan, feature) !== "allowed") {
      return redirect(`/app/plan?required=${encodeURIComponent(feature)}`);
    }

    // eslint-disable-next-line no-undef
    return data(
      { apiKey: process.env.SHOPIFY_API_KEY || "", shopPlan, storeHandle, reservationsEnabled: reservationsEnabled(), outboundRequestsEnabled: outboundRequestsEnabled(), showReservationPrivacy: await reservationPrivacyAvailable(session.shop) },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    // OAuth / App Bridge 用 Response はそのまま伝播（設定クリック時に 500 化しない）
    if (e instanceof Response) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    if (/syntax\s*error|unexpected\s*end\s*of\s*file/i.test(String(msg))) {
      console.error("SYNTAX_ERROR_ORIGIN [app layout loader] 親レイアウトで発生。上記 stack の先頭が発生箇所:", stack ?? "no stack");
    }
    // クラッシュを防ぎ、エラーレスポンスを返す（ErrorBoundary で捕捉可能に）
    throw new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5分（有料プランでも LB/プロキシのアイドル切断を防ぐ）

export default function App() {
  const { apiKey, shopPlan, storeHandle, reservationsEnabled: showReservations, showReservationPrivacy, outboundRequestsEnabled: showOutboundRequests } = useLoaderData<typeof loader>();
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
        {features.settings && <s-link href="/app/settings">設定</s-link>}
        {features.inventoryInfo && <s-link href="/app/inventory-info">在庫情報</s-link>}
        {features.history && <s-link href="/app/history">入出庫</s-link>}
        {showOutboundRequests && features.outboundRequest && <s-link href="/app/outbound-requests">出庫依頼</s-link>}
        {features.purchase && <s-link href="/app/purchase">仕入</s-link>}
        {features.order && <s-link href="/app/order">発注</s-link>}
        {features.loss && <s-link href="/app/loss">ロス</s-link>}
        {features.stocktake && <s-link href="/app/inventory-count">棚卸</s-link>}
        {((showReservations && features.reservation) || showReservationPrivacy) && <s-link href={showReservations && features.reservation ? "/app/reservations" : "/app/reservations/customer-data"}>取置</s-link>}
        {features.adjustment && <s-link href="/app/adjustment">調整</s-link>}
        {((showReservations && features.reservation) || (showOutboundRequests && features.outboundRequest)) && <s-link href="/app/receipts">レシート編集</s-link>}
        {distribution === "public" && <s-link href="/app/plan">料金プラン</s-link>}
      {/* @ts-expect-error s-app-nav 閉じタグ */}
      </s-app-nav>
      {/* 上部メニュー（s-app-nav が表示されない環境用・常に表示） */}
      <AppNavBar shopPlan={shopPlan} showReservations={showReservations} showOutboundRequests={showOutboundRequests} showReservationPrivacy={showReservationPrivacy} />
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
      <Outlet context={{ shopPlan, storeHandle, reservationsEnabled: showReservations }} />
    </AppProvider>
  );
}

/** 棚卸画面の読み取り専用 POST（検索・明細取得）ではレイアウト loader（プラン判定）を再実行しない。他画面は既定どおり */
export const shouldRevalidate: ShouldRevalidateFunction = (args) => {
  if (isInventoryCountReadOnlySubmission(args)) return false;
  return args.defaultShouldRevalidate;
};

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
