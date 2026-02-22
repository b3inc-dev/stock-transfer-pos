// app/routes/app.plan.tsx - 料金プランページ（プラン選択＋プラン別機能の紹介）
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getShopPlan } from "./app";

const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "app";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shopPlan = await getShopPlan(admin);

  const storeHandle = session.shop.replace(".myshopify.com", "");
  const pricingPlansUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;

  return { shopPlan, pricingPlansUrl };
}

export default function PlanPage() {
  const { shopPlan, pricingPlansUrl } = useLoaderData<typeof loader>();
  const { plan, locationsCount, distribution } = shopPlan;
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
        {/* プラン選択セクション */}
        <div style={{ marginBottom: "32px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" }}>
            {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
            <s-text emphasis="bold" size="large">
              料金プラン
            </s-text>
            <span style={{ fontSize: "14px", color: "#6d7175" }}>ロケーション数: {locationsCount}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "16px" }}>
            <PlanCard
              name="Lite"
              price="$19/月〜"
              trial="7日間無料"
              summary="入出庫（POS・管理画面）、入出庫履歴・CSV"
              isCurrent={plan === "lite"}
              pricingPlansUrl={pricingPlansUrl}
            />
            <PlanCard
              name="Pro"
              price="$59/月〜"
              trial="14日間無料"
              summary="在庫情報・入出庫・仕入・ロス・発注・棚卸・調整（全機能）"
              isCurrent={plan === "pro"}
              pricingPlansUrl={pricingPlansUrl}
            />
          </div>
        </div>

        {/* プラン別機能の紹介 */}
        <div style={{ marginBottom: "24px" }}>
          {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
          <s-text emphasis="bold" size="large">
            全てのプランで利用可能な機能
          </s-text>
          <div style={{ marginTop: "12px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
            <FeatureCard title="出庫" description="POS で出庫登録。管理画面で履歴・CSV。" />
            <FeatureCard title="入庫" description="POS で入庫受領。管理画面で履歴・CSV。" />
            <FeatureCard title="入出庫履歴" description="フィルター・ページネーション・CSV 出力。" />
          </div>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
            <s-text emphasis="bold" size="large">
              Pro プランで利用可能な機能
            </s-text>
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
  name,
  price,
  trial,
  summary,
  isCurrent,
  pricingPlansUrl,
}: {
  name: string;
  price: string;
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
      <div style={{ marginBottom: "8px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text emphasis="bold" size="large">
          {name}
        </s-text>
      </div>
      <div style={{ marginBottom: "4px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text tone="subdued" size="small">
          {price}
        </s-text>
      </div>
      <div style={{ marginBottom: "12px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text tone="subdued" size="small">
          {trial}
        </s-text>
      </div>
      <div style={{ marginBottom: "16px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text tone="subdued" size="small">
          {summary}
        </s-text>
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
        <a
          href={pricingPlansUrl}
          target="_blank"
          rel="noopener noreferrer"
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
          このプランを選択する
        </a>
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
      <div style={{ marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text emphasis="bold">{title}</s-text>
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
      <div>
        {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
        <s-text tone="subdued" size="small">
          {description}
        </s-text>
      </div>
    </div>
  );
}
