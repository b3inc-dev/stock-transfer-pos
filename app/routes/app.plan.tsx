// app/routes/app.plan.tsx - 料金プランページ（プラン選択＋プラン別機能の紹介）
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopPlan } from "./app";
import { createAppSubscription } from "../utils/billing";

const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "app";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shopPlan = await getShopPlan(admin, session?.shop);

  const storeHandle = session.shop.replace(".myshopify.com", "");
  const pricingPlansUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;

  return { shopPlan, pricingPlansUrl };
}

/** プラン選択ボタン押下: サブスク作成 → Shopify の承認 URL へリダイレクト */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return null;
  const formData = await request.formData();
  const plan = formData.get("plan");
  if (plan !== "lite" && plan !== "pro") return null;

  const { admin, session } = await authenticate.admin(request);
  const shopPlan = await getShopPlan(admin, session?.shop);
  if (shopPlan.distribution === "inhouse") return null;

  const url = new URL(request.url);
  const returnUrl = `${url.origin}${url.pathname}`;
  const { confirmationUrl, userErrors } = await createAppSubscription(admin, plan, returnUrl);
  if (userErrors.length > 0 || !confirmationUrl) {
    return redirect(`${url.pathname}?billingError=1`);
  }
  return redirect(confirmationUrl);
}

export default function PlanPage() {
  const { shopPlan, pricingPlansUrl } = useLoaderData<typeof loader>();
  const { plan, locationsCount, distribution, isDevelopmentStore } = shopPlan;
  const isInhouse = distribution === "inhouse";

  if (isInhouse) {
    return (
      // @ts-expect-error s-page は App Bridge の Web コンポーネント
      <s-page heading="料金プラン">
        <div style={{ padding: "16px", maxWidth: "600px", margin: "0 16px" }}>
          <div
            style={{
              padding: "16px",
              background: "#fff",
              borderRadius: "8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
            }}
          >
            {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
            <s-text emphasis="bold">全機能をご利用いただけます</s-text>
            <div style={{ marginTop: "8px" }}>
              {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
              <s-text tone="subdued" size="small">
                このアプリでは料金プランの選択はありません。
              </s-text>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    // @ts-expect-error s-page は App Bridge の Web コンポーネント
    <s-page heading="料金プラン">
      <div style={{ padding: "16px", maxWidth: "900px" }}>
        {isDevelopmentStore && (
          <div
            style={{
              marginBottom: "16px",
              padding: "12px 16px",
              background: "#e3f1df",
              borderRadius: "8px",
              borderLeft: "4px solid #008060",
            }}
          >
            {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
            <s-text emphasis="bold">開発ストアのため課金は発生しません</s-text>
            <div style={{ marginTop: "4px" }}>
              {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
              <s-text tone="subdued" size="small">
                全機能をご利用いただけます。本番ストアでは下記の料金が適用されます。
              </s-text>
            </div>
          </div>
        )}

        {/* プラン選択セクション */}
        <div style={{ marginBottom: "32px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" }}>
            <span style={{ fontSize: "18px", fontWeight: 700, color: "#202223" }}>料金プラン</span>
            <span style={{ fontSize: "14px", color: "#6d7175" }}>ロケーション数: {locationsCount}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }}>
            <PlanCard
              planKey="lite"
              name="Lite"
              priceSummary="$20/月〜"
              priceDetail="3ロケーション: $20 / 10ロケーション: $40 / 10以上: 1ロケーションあたり$4"
              trial="7日間無料"
              summary="入出庫（POS・管理画面）、入出庫履歴・CSV"
              isCurrent={plan === "lite"}
              pricingPlansUrl={pricingPlansUrl}
            />
            <PlanCard
              planKey="pro"
              name="Pro"
              priceSummary="$60/月〜"
              priceDetail="3ロケーション: $60 / 10ロケーション: $100 / 10以上: 1ロケーションあたり$10"
              trial="14日間無料"
              summary="在庫情報・入出庫・仕入・ロス・発注・棚卸・調整（全機能）"
              isCurrent={plan === "pro"}
              pricingPlansUrl={pricingPlansUrl}
            />
          </div>
        </div>

        {/* プラン別機能の紹介 */}
        <div style={{ marginBottom: "24px" }}>
          <div style={{ marginBottom: "12px", fontSize: "18px", fontWeight: 700, color: "#202223" }}>
            全てのプランで利用可能な機能
          </div>
          <div style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
            <FeatureCard title="出庫" description="POS で出庫登録。管理画面で履歴・CSV。" />
            <FeatureCard title="入庫" description="POS で入庫受領。管理画面で履歴・CSV。" />
            <FeatureCard title="入出庫履歴" description="フィルター・ページネーション・CSV 出力。" />
          </div>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <span style={{ fontSize: "18px", fontWeight: 700, color: "#202223" }}>Pro プランで利用可能な機能</span>
            <span
              style={{
                fontSize: "12px",
                padding: "2px 8px",
                background: "#2c6ecb",
                color: "#fff",
                borderRadius: "4px",
              }}
            >
              Pro
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
            <FeatureCard title="在庫情報" description="在庫高・在庫変動履歴。" pro />
            <FeatureCard title="仕入" description="仕入登録・履歴・CSV。" pro />
            <FeatureCard title="ロス" description="ロス登録・履歴・CSV。" pro />
            <FeatureCard title="発注" description="発注・履歴・CSV。" pro />
            <FeatureCard title="棚卸" description="棚卸 ID 発行・カウント・履歴。" pro />
            <FeatureCard title="調整" description="簡易棚卸（調整）・履歴。" pro />
          </div>
          {plan !== "pro" && (
            <div style={{ marginTop: "16px" }}>
              <a
                href={pricingPlansUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "14px", color: "#2c6ecb" }}
              >
                アップグレードして全機能を使う →
              </a>
            </div>
          )}
        </div>
      </div>
    </s-page>
  );
}

function PlanCard({
  planKey,
  name,
  priceSummary,
  priceDetail,
  trial,
  summary,
  isCurrent,
  pricingPlansUrl,
}: {
  planKey: "lite" | "pro";
  name: string;
  priceSummary: string;
  priceDetail: string;
  trial: string;
  summary: string;
  isCurrent: boolean;
  pricingPlansUrl: string;
}) {
  return (
    <div
      style={{
        padding: "20px",
        background: "#fff",
        borderRadius: "8px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        border: isCurrent ? "2px solid #2c6ecb" : "1px solid #e1e3e5",
      }}
    >
      {/* カードタイトル（プラン名） */}
      <div style={{ marginBottom: "12px", fontSize: "20px", fontWeight: 700 }}>
        {name}
      </div>
      {/* メイン料金 */}
      <div style={{ marginBottom: "6px", fontSize: "18px", fontWeight: 700, color: "#202223" }}>
        {priceSummary}
      </div>
      {/* 料金の内訳 */}
      <div style={{ marginBottom: "6px", fontSize: "12px", color: "#6d7175", lineHeight: 1.4 }}>
        {priceDetail}
      </div>
      {/* トライアル */}
      <div style={{ marginBottom: "12px", fontSize: "13px", color: "#6d7175" }}>
        {trial}
      </div>
      {/* 機能の要約 */}
      <div style={{ marginBottom: "16px", fontSize: "14px", color: "#6d7175", lineHeight: 1.4 }}>
        {summary}
      </div>
      {isCurrent ? (
        <div
          style={{
            display: "inline-block",
            padding: "8px 16px",
            background: "#e1e3e5",
            color: "#414f3b",
            borderRadius: "6px",
            fontSize: "14px",
            fontWeight: 500,
          }}
        >
          このプランを利用中
        </div>
      ) : (
        <form method="post" style={{ display: "inline-block" }}>
          <input type="hidden" name="plan" value={planKey} />
          <button
            type="submit"
            style={{
              padding: "8px 16px",
              background: "#2c6ecb",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            このプランを選択する
          </button>
        </form>
      )}
    </div>
  );
}

function FeatureCard({
  title,
  description,
  pro,
}: {
  title: string;
  description: string;
  pro?: boolean;
}) {
  return (
    <div
      style={{
        padding: "16px",
        background: "#fff",
        borderRadius: "8px",
        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
        border: "1px solid #e1e3e5",
      }}
    >
      {/* カードタイトル */}
      <div style={{ marginBottom: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{ fontSize: "15px", fontWeight: 700, color: "#202223" }}>{title}</span>
        {pro && (
          <span
            style={{
              fontSize: "10px",
              padding: "2px 6px",
              background: "#2c6ecb",
              color: "#fff",
              borderRadius: "4px",
            }}
          >
            Pro
          </span>
        )}
      </div>
      <div style={{ fontSize: "13px", color: "#6d7175", lineHeight: 1.4 }}>
        {description}
      </div>
    </div>
  );
}
