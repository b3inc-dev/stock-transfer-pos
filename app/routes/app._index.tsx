// app/routes/app._index.tsx - 導入（ホーム）ページ
import type { HeadersFunction } from "react-router";
import { Link, useOutletContext } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ShopPlan } from "./app";

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

type OutletContext = { shopPlan: ShopPlan; storeHandle?: string };

/** 販売チャネルPOSの設定画面（POSアプリの追加はここ）。ストアによっては販売チャネル一覧に誘導される場合あり */
const getPosChannelUrl = (storeHandle: string) =>
  `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/apps/point-of-sale-channel`;
/** 販売チャネル一覧（POSがまだない場合はここから「Point of Sale」を追加） */
const getChannelsUrl = (storeHandle: string) =>
  `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/settings/channels`;

export default function HomePage() {
  const { shopPlan, storeHandle } = useOutletContext<OutletContext>();
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
  const steps: Array<{ num: number; title: string; description: string; to: string; buttonLabel: string; highlight?: boolean; stepId?: "pos" }> = [];
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
    description: "POSで出庫・入庫・ロス・棚卸などのタイルを使うには、Shopify管理画面の「販売チャネル」の「Point of Sale」でアプリを追加してください。POSチャネルがまだない場合は販売チャネル一覧から追加できます。",
    to: "/app/settings",
    buttonLabel: "POSの設定を開く",
    stepId: "pos",
  });

  const summaryBlock = (
    <div className="HomePage-summary">
      <SummaryCard title="現在の料金プラン" style={{ marginBottom: "16px" }}>
        <div style={{ marginBottom: "8px", fontSize: "18px", fontWeight: 700, color: "#202223" }}>
          {planLabel}
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
          <span style={{ fontSize: "14px", color: "#6d7175" }}>
            全機能をご利用いただけます
          </span>
        )}
        {showBillingNote && (
          <span style={{ fontSize: "14px", color: "#6d7175" }}>
            開発ストアのため課金は発生しません
          </span>
        )}
      </SummaryCard>

      <SummaryCard title="ロケーション数">
        <span style={{ fontSize: "18px", fontWeight: 700, color: "#202223" }}>{locationsCount}</span>
        <span style={{ marginLeft: "4px", fontSize: "14px", color: "#6d7175" }}>ロケーション</span>
      </SummaryCard>
    </div>
  );

  const stepsBlock = (
    <div className="HomePage-steps">
      {steps.map((step) =>
        step.stepId === "pos" && storeHandle ? (
          <StepCardPos
            key={step.num}
            step={step}
            storeHandle={storeHandle}
          />
        ) : (
          <StepCard
            key={step.num}
            title={`${step.num}. ${step.title}`}
            description={step.description}
            buttonLabel={step.buttonLabel}
            to={step.to}
            highlight={step.highlight}
          />
        )
      )}
    </div>
  );

  return (
    <s-page heading="ホーム">
      <style>{`
        .HomePage-layout {
          padding: 16px;
          display: flex;
          gap: 24px;
          flex-wrap: wrap;
          max-width: 1200px;
        }
        .HomePage-summary { flex: 0 1 320px; min-width: 260px; }
        .HomePage-steps { flex: 1 1 60%; min-width: 280px; }
        @media (max-width: 767px) {
          .HomePage-layout { flex-direction: column; }
          .HomePage-summary { order: 1; flex: 1 1 100%; min-width: 0; width: 100%; }
          .HomePage-steps { order: 2; flex: 1 1 100%; min-width: 0; width: 100%; }
        }
        @media (min-width: 768px) {
          .HomePage-steps { order: 1; }
          .HomePage-summary { order: 2; }
        }
      `}</style>
      <div className="HomePage-layout">
        {summaryBlock}
        {stepsBlock}
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
      <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: 600, color: "#6d7175" }}>
        {title}
      </div>
      <div style={{ marginBottom: "12px", fontSize: "14px", color: "#6d7175", lineHeight: 1.4 }}>
        {description}
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

/** POSアプリタイル追加用：販売チャネルPOSの設定／販売チャネル一覧を管理画面で開く */
function StepCardPos({
  step,
  storeHandle,
}: {
  step: { num: number; title: string; description: string };
  storeHandle: string;
}) {
  const posUrl = getPosChannelUrl(storeHandle);
  const channelsUrl = getChannelsUrl(storeHandle);
  const linkStyle = {
    display: "inline-block",
    padding: "8px 16px",
    background: "#2c6ecb",
    color: "#fff",
    borderRadius: "6px",
    fontSize: "14px",
    textDecoration: "none" as const,
    fontWeight: 500,
  };
  const secondaryStyle = { fontSize: "14px", color: "#2c6ecb", marginLeft: "12px" };
  return (
    <div
      style={{
        marginBottom: "16px",
        padding: "16px",
        background: "#fff",
        borderRadius: "8px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
      }}
    >
      <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: 600, color: "#6d7175" }}>
        {step.num}. {step.title}
      </div>
      <div style={{ marginBottom: "12px", fontSize: "14px", color: "#6d7175", lineHeight: 1.4 }}>
        {step.description}
      </div>
      <a href={posUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
        POSの設定を開く
      </a>
      <a href={channelsUrl} target="_blank" rel="noopener noreferrer" style={secondaryStyle}>
        販売チャネル一覧を開く
      </a>
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
      <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: 600, color: "#6d7175" }}>
        {title}
      </div>
      {children}
    </div>
  );
}
