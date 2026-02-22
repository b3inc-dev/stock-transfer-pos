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
  const { distribution, plan, features, locationsCount, isDevelopmentStore } = shopPlan;
  const isInhouse = distribution === "inhouse";
  const showPlanStep = !isInhouse;
  const showBillingNote = !isInhouse && isDevelopmentStore;
  const isPro = isInhouse || plan === "pro";

  const planLabel =
    plan === "pro"
      ? "Pro"
      : plan === "lite"
        ? "Lite（7日間トライアル中）"
        : "プランが選択されていません";

  // 導入ステップ: 1.料金 2.アプリ設定 3.出庫 4.入庫 [Lite: 10.POS] [Pro: 5〜9 仕入・発注・ロス・棚卸・調整] 10.POS
  const steps: Array<{ num: number; title: string; description: string; to: string; buttonLabel: string; highlight?: boolean }> = [];
  let num = 0;
  if (showPlanStep) {
    num++;
    steps.push({
      num,
      title: "料金プランを選択する",
      description: "Lite または Pro を選択し、利用を開始しましょう。",
      to: "/app/plan",
      buttonLabel: "料金プランを選択する",
      highlight: !plan,
    });
  }
  num++;
  steps.push({
    num,
    title: "アプリ設定",
    description: "設定できる項目：表示ロケーションの選択、履歴一覧の表示件数、商品リスト・検索リストの表示件数。",
    to: "/app/settings",
    buttonLabel: "設定を開く",
  });
  num++;
  steps.push({
    num,
    title: "出庫設定",
    description: "設定できる項目：出庫履歴の初回件数、配送情報の必須/任意、配送業者プリセット、到着予定日ボタン（日数・ラベル）、「その他（配送会社入力）」の表示、強制キャンセル許可。",
    to: "/app/settings?tab=outbound",
    buttonLabel: "出庫設定を開く",
  });
  num++;
  steps.push({
    num,
    title: "入庫設定",
    description: "設定できる項目：入出庫履歴のCSV出力項目（並び・ON/OFF）、過剰入庫許可、予定外入庫許可、入庫リストの初回件数。",
    to: "/app/settings?tab=inbound",
    buttonLabel: "入庫設定を開く",
  });
  if (isPro) {
    num++;
    steps.push({
      num,
      title: "仕入設定",
      description: "設定できる項目：仕入先マスタ（名称・コード・並び順）、「その他（仕入先入力）」の表示、仕入履歴のCSV出力項目。",
      to: "/app/settings?tab=purchase",
      buttonLabel: "仕入設定を開く",
    });
    num++;
    steps.push({
      num,
      title: "発注設定",
      description: "設定できる項目：発注先マスタ（名称・コード・並び順）、希望納品日の表示ON/OFF、希望納品日ボタンの日数・ラベル、発注履歴のCSV出力項目。",
      to: "/app/settings?tab=order",
      buttonLabel: "発注設定を開く",
    });
    num++;
    steps.push({
      num,
      title: "ロス設定",
      description: "設定できる項目：ロス区分（破損・紛失など）の登録・並び順、「その他（理由入力）」の表示、ロス履歴のCSV出力項目。",
      to: "/app/settings?tab=loss",
      buttonLabel: "ロス設定を開く",
    });
    num++;
    steps.push({
      num,
      title: "棚卸設定",
      description: "設定できる項目：棚卸履歴のCSV出力項目（並び・ON/OFF）、予定外棚卸の許可/不許可。",
      to: "/app/settings?tab=stocktake",
      buttonLabel: "棚卸設定を開く",
    });
    num++;
    steps.push({
      num,
      title: "調整設定",
      description: "設定できる項目：調整（簡易棚卸）履歴のCSV出力項目（並び・ON/OFF、差分列など）。",
      to: "/app/settings?tab=adjustment",
      buttonLabel: "調整設定を開く",
    });
  }
  num++;
  steps.push({
    num,
    title: "POSアプリタイル追加",
    description: "POSで出庫・入庫・ロス・棚卸などのタイルを使うには、Shopify管理画面のPOSチャネルでアプリを追加してください。設定画面の「アプリ設定」からも案内を確認できます。",
    to: "/app/settings",
    buttonLabel: "設定を開く",
  });

  return (
    <s-page heading="ホーム">
      <div style={{ padding: "16px", display: "flex", gap: "24px", flexWrap: "wrap", maxWidth: "1200px" }}>
        {/* 左カラム: 導入ステップ */}
        <div style={{ flex: "1 1 60%", minWidth: "280px" }}>
          {steps.map((step) => (
            <StepCard
              key={step.num}
              title={`${step.num}. ${step.title}`}
              description={step.description}
              buttonLabel={step.buttonLabel}
              to={step.to}
              highlight={step.highlight}
            />
          ))}
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
            {showBillingNote && (
              // @ts-expect-error s-text
              <s-text tone="subdued" size="small">
                開発ストアのため課金は発生しません
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
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント。カードタイトルは太字 */}
        <s-text emphasis="bold">{title}</s-text>
      </div>
      {children}
    </div>
  );
}
