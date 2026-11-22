// app/routes/app._index.tsx - 導入（ホーム）ページ
import type { HeadersFunction } from "react-router";
import { useOutletContext } from "react-router";
import { PrimaryLink, SecondaryLink } from "../components/admin-ui";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ShopPlan } from "../utils/shop-plan.server";

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
  /** 公開用で契約が無い（または読めない）。料金プラン以外の手順は、契約するまで開けないので出さない */
  const isLocked = !isInhouse && !plan;

  const planLabel =
    plan === "pro"
      ? "Pro"
      : plan === "lite"
        ? "Lite"
        : shopPlan.planCheckFailed
          ? "確認できませんでした"
          : "未契約";

  // 導入ステップ: 1.料金 2.アプリ設定 3.出庫 4.入庫 [Lite: 10.POS] [Pro: 5〜9 仕入・発注・ロス・棚卸・調整] 10.POS
  const steps: Array<{ num: number; title: string; description: string; to: string; buttonLabel: string; highlight?: boolean; stepId?: "pos" }> = [];
  let num = 0;
  if (showPlanStep) {
    num++;
    steps.push({
      num,
      title: "料金プランを選択する",
      description: isLocked
        ? "プランを選ぶまで、設定・入出庫・POS のタイルは使えません。Lite か Pro を選んでください。"
        : "Lite または Pro を選択し、利用を開始しましょう。",
      to: "/app/plan",
      buttonLabel: "料金プランを選択する",
      highlight: !plan,
    });
  }
  if (!isLocked) {
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
  }

  const summaryBlock = (
    <div className="Admin-home-side">
      <SummaryCard title="現在の料金プラン">
        <div className="Admin-figure" style={{ marginBottom: "8px" }}>
          {planLabel}
        </div>
        {/* 文字だけのリンクにせず、白いボタンにする（UI ルール v1.1 4章） */}
        {!isInhouse && !plan && (
          <div className="Admin-actions" style={{ marginTop: 0 }}>
            <SecondaryLink to="/app/plan">料金プランを選ぶ</SecondaryLink>
          </div>
        )}
        {!isInhouse && plan === "lite" && (
          <>
            <p className="Admin-note" style={{ margin: "0 0 8px" }}>アップグレードすると全機能を使えます。</p>
            <div className="Admin-actions" style={{ marginTop: 0 }}>
              <SecondaryLink to="/app/plan">料金プランを見る</SecondaryLink>
            </div>
          </>
        )}
        {isInhouse && (
          <span className="Admin-note">
            全機能をご利用いただけます
          </span>
        )}
        {showBillingNote && (
          <span className="Admin-note">
            開発ストアはテスト課金のため請求されません
          </span>
        )}
      </SummaryCard>

      <SummaryCard title="ロケーション数">
        <span className="Admin-figure">{locationsCount}</span>
        <span className="Admin-note" style={{ marginLeft: "4px" }}>ロケーション</span>
      </SummaryCard>
    </div>
  );

  const stepsBlock = (
    <div className="Admin-home-main">
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
      {/* 画面の形2（左に主な内容、右に要約。スマホは要約が上）。UI ルール v1.1 2章 */}
      <div className="Admin-body">
        <div className="Admin-home">
          {stepsBlock}
          {summaryBlock}
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
      className="Admin-home-card"
      style={{ borderLeft: highlight ? "4px solid #2c6ecb" : undefined }}
    >
      <div className="Admin-kicker">{title}</div>
      <p className="Admin-note" style={{ margin: "0 0 12px", fontSize: "14px" }}>{description}</p>
      {/* 主ボタン（黒）は今やる手順の1つだけ。ほかは白いボタン（UI ルール v1.1 4章） */}
      {highlight ? <PrimaryLink to={to}>{buttonLabel}</PrimaryLink> : <SecondaryLink to={to}>{buttonLabel}</SecondaryLink>}
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
  return (
    <div className="Admin-home-card">
      <div className="Admin-kicker">
        {step.num}. {step.title}
      </div>
      <p className="Admin-note" style={{ margin: "0 0 12px", fontSize: "14px" }}>{step.description}</p>
      {/* Shopify 管理画面の別の画面を開くので、ふつうの a のままボタンの見た目にする（文字だけのリンクにしない） */}
      <div className="Admin-actions" style={{ marginTop: 0 }}>
        <a href={posUrl} target="_blank" rel="noopener noreferrer" className="Admin-secondary">
          POSの設定を開く
        </a>
        <a href={channelsUrl} target="_blank" rel="noopener noreferrer" className="Admin-secondary">
          販売チャネル一覧を開く
        </a>
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="Admin-home-card">
      <div className="Admin-kicker">{title}</div>
      {children}
    </div>
  );
}
