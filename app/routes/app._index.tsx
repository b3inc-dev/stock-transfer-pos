// app/routes/app._index.tsx - 導入（ホーム）ページ
import type { HeadersFunction } from "react-router";
import { Link, useOutletContext } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ShopPlan } from "./app";

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

type OutletContext = { shopPlan: ShopPlan };

export default function HomePage() {
  const { shopPlan } = useOutletContext<OutletContext>();
  const { distribution, plan, features, locationsCount } = shopPlan;
  const isInhouse = distribution === "inhouse";
  const showPlanStep = !isInhouse; // カスタムのときは料金プランステップを非表示
  const showStep4 = isInhouse || plan === "pro";

  const planLabel =
    plan === "pro"
      ? "Pro"
      : plan === "lite"
        ? "Lite（7日間トライアル中）"
        : "プランが選択されていません";

  return (
    <s-page heading="ホーム">
      <div style={{ padding: "16px", display: "flex", gap: "24px", flexWrap: "wrap", maxWidth: "1200px" }}>
        {/* 左カラム: はじめての設定 */}
        <div style={{ flex: "1 1 60%", minWidth: "280px" }}>
          <div style={{ marginBottom: "16px" }}>
            {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
            <s-text emphasis="bold" size="large">
              はじめての設定
            </s-text>
          </div>

          {showPlanStep && (
            <StepCard
              title="1. 料金プランを選択する"
              description="Lite または Pro を選択し、利用を開始しましょう。"
              buttonLabel="料金プランを選択する"
              to="/app/plan"
              highlight={!plan}
            />
          )}

          <StepCard
            title={showPlanStep ? "2. 設定でロケーション等を確認する" : "1. 設定でロケーション等を確認する"}
            description="出庫元・入庫先に使うロケーションや、出庫・入庫の初期設定を行います。"
            buttonLabel="設定を開く"
            to="/app/settings"
          />

          <StepCard
            title={showPlanStep ? "3. 入出庫の使い方を確認する" : "2. 入出庫の使い方を確認する"}
            description="POS で出庫・入庫を使う前に、管理画面で入出庫履歴の見方を確認しましょう。"
            buttonLabel="入出庫を開く"
            to="/app/history"
          />

          {showStep4 && (
            <StepCard
              title={showPlanStep ? "4. 仕入・ロス・棚卸・発注を使う" : "3. 仕入・ロス・棚卸・発注を使う"}
              description="仕入・ロス・棚卸・発注は Pro プランで利用できます。各メニューから設定や履歴を確認できます。"
              buttonLabel="仕入を開く"
              to="/app/purchase"
            />
          )}
        </div>

        {/* 右カラム: サマリー */}
        <div style={{ flex: "0 1 320px", minWidth: "260px" }}>
          <SummaryCard title="現在の料金プラン" style={{ marginBottom: "16px" }}>
            <div style={{ marginBottom: "8px" }}>
              {/* @ts-expect-error s-text */}
              <s-text emphasis="bold">{planLabel}</s-text>
            </div>
            {!isInhouse && !plan && (
              <Link to="/app/plan" style={{ fontSize: "14px", color: "#2c6ecb" }}>
                料金プランを選択する
              </Link>
            )}
            {!isInhouse && plan === "lite" && (
              <Link to="/app/plan" style={{ fontSize: "14px", color: "#2c6ecb" }}>
                アップグレードして全機能を使いましょう
              </Link>
            )}
            {isInhouse && (
              // @ts-expect-error s-text
              <s-text tone="subdued" size="small">
                全機能をご利用いただけます
              </s-text>
            )}
          </SummaryCard>

          <SummaryCard title="ロケーション数">
            {/* @ts-expect-error s-text */}
            <s-text emphasis="bold">{locationsCount}</s-text>
            <span style={{ marginLeft: "4px" }}>ロケーション</span>
          </SummaryCard>
        </div>
      </div>
    </s-page>
  );
}

function StepCard({
  title,
  description,
  buttonLabel,
  to,
  highlight,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  to: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        marginBottom: "16px",
        padding: "16px",
        background: "#fff",
        borderRadius: "8px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        borderLeft: highlight ? "4px solid #2c6ecb" : undefined,
      }}
    >
      <div style={{ marginBottom: "8px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text emphasis="bold">{title}</s-text>
      </div>
      <div style={{ marginBottom: "12px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text tone="subdued" size="small">
          {description}
        </s-text>
      </div>
      <Link
        to={to}
        style={{
          display: "inline-block",
          padding: "8px 16px",
          background: "#2c6ecb",
          color: "#fff",
          borderRadius: "6px",
          fontSize: "14px",
          textDecoration: "none",
          fontWeight: 500,
        }}
      >
        {buttonLabel}
      </Link>
    </div>
  );
}

function SummaryCard({
  title,
  children,
  style,
}: {
  title: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        padding: "16px",
        background: "#fff",
        borderRadius: "8px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        ...style,
      }}
    >
      <div style={{ marginBottom: "8px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text tone="subdued" size="small">
          {title}
        </s-text>
      </div>
      {children}
    </div>
  );
}
