// app/routes/app.plan.tsx - 料金プランページ（プラン選択＋プラン別機能の紹介）
// 公開アプリは Managed Pricing（Shopify App Pricing）の pricing_plans へ target="_top" で遷移する。
// appSubscriptionCreate → confirmationUrl の iframe 内リダイレクトは accounts.shopify.com で拒否されるため使わない。
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, data } from "react-router";
import { authenticate } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import { getShopPlan } from "./app";
import { buildManagedPricingPlansUrl } from "../utils/billing";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    let { admin, session } = await authenticate.admin(request);
    admin = withGraphQLRetry(admin);
    const shopPlan = await getShopPlan(admin, session?.shop);
    const pricingPlansUrl = buildManagedPricingPlansUrl(session?.shop);
    return data(
      { shopPlan, pricingPlansUrl },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    if (e instanceof Response) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * プラン選択: Managed Pricing のプラン選択ページへ top-level リダイレクト。
 * authenticate.admin の redirect（target: "_top"）を使い、埋め込み iframe 外へ出す。
 * 再インストール後の approve / decline / re-approve は Shopify 側の pricing_plans で行う。
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return null;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "select-plan");
  if (intent !== "select-plan" && intent !== "change-plan") return null;

  const auth = await authenticate.admin(request);
  const admin = withGraphQLRetry(auth.admin);
  const shopPlan = await getShopPlan(admin, auth.session?.shop);
  if (shopPlan.distribution === "inhouse") return null;

  const pricingPlansUrl = buildManagedPricingPlansUrl(auth.session?.shop);
  if (!pricingPlansUrl) {
    return data({ billingError: true }, { status: 400 });
  }
  // myshopify.com や accounts.shopify.com へは飛ばさない。admin.shopify.com + _top のみ。
  return auth.redirect(pricingPlansUrl, { target: "_top" });
}

export default function PlanPage() {
  const { shopPlan, pricingPlansUrl } = useLoaderData<typeof loader>();
  const { plan, locationsCount, distribution, isDevelopmentStore, locationPlanMismatch, maxLocationsForPlan } = shopPlan;
  const isInhouse = distribution === "inhouse";
  const canOpenPricing = Boolean(pricingPlansUrl) && !isInhouse;

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
            <s-text type="strong">全機能をご利用いただけます</s-text>
            <div style={{ marginTop: "8px" }}>
              {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
              <s-text color="subdued">
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
        {locationPlanMismatch && maxLocationsForPlan != null && (
          <div
            style={{
              marginBottom: "16px",
              padding: "16px",
              background: "#fff4e5",
              border: "1px solid #e0b252",
              borderRadius: "8px",
            }}
          >
            <div style={{ fontSize: "16px", fontWeight: 700, color: "#202223", marginBottom: "8px" }}>
              ロケーション数がプランと一致していません
            </div>
            <div style={{ fontSize: "14px", color: "#202223", marginBottom: "12px", lineHeight: 1.5 }}>
              現在のプランは<strong>{maxLocationsForPlan}ロケーション</strong>までです。ストアのロケーション数は<strong>{locationsCount}</strong>のため、プラン変更が必要です。変更が反映されるまで設定・在庫・入出庫などの機能はご利用いただけません。
            </div>
            {canOpenPricing && pricingPlansUrl ? (
              <a
                href={pricingPlansUrl}
                target="_top"
                rel="noopener noreferrer"
                style={{
                  display: "inline-block",
                  padding: "10px 20px",
                  background: "#2c6ecb",
                  color: "#fff",
                  borderRadius: "6px",
                  fontSize: "14px",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                Shopify でプランを変更する
              </a>
            ) : null}
            <div style={{ marginTop: "8px", fontSize: "13px", color: "#6d7175" }}>
              プラン変更後、このページを再読み込みしてください。承認・辞退・再承認は Shopify の画面で行えます。
            </div>
          </div>
        )}

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
            <s-text type="strong">開発ストアのため課金は発生しません</s-text>
            <div style={{ marginTop: "4px" }}>
              {/* @ts-expect-error s-text は App Bridge の Web コンポーネント */}
              <s-text color="subdued">
                全機能をご利用いただけます。本番ストアでは下記の料金が適用されます。
              </s-text>
            </div>
          </div>
        )}

        {!pricingPlansUrl && (
          <div
            style={{
              marginBottom: "16px",
              padding: "12px 16px",
              background: "#fff4e5",
              border: "1px solid #e0b252",
              borderRadius: "8px",
              fontSize: "14px",
              color: "#202223",
            }}
          >
            プラン選択ページの URL を組み立てられませんでした。店舗ドメインを確認するか、サポートにお問い合わせください。
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
              name="Lite"
              priceSummary="$20/月〜"
              priceDetail="3ロケーション: $20 / 10ロケーション: $40 / 10以上: 1ロケーションあたり$4"
              trial="7日間無料"
              summary="入出庫（POS・管理画面）、入出庫履歴・CSV"
              isCurrent={plan === "lite"}
              pricingPlansUrl={pricingPlansUrl}
            />
            <PlanCard
              name="Pro"
              priceSummary="$60/月〜"
              priceDetail="3ロケーション: $60 / 10ロケーション: $120 / 10以上: 1ロケーションあたり$12"
              trial="14日間無料"
              summary="在庫情報・入出庫・仕入・ロス・発注・棚卸・調整（全機能）"
              isCurrent={plan === "pro"}
              pricingPlansUrl={pricingPlansUrl}
            />
          </div>
          <div style={{ marginTop: "12px", fontSize: "13px", color: "#6d7175", lineHeight: 1.5 }}>
            プランの選択・承認・辞退・再インストール後の再承認は Shopify の料金プラン画面で行います。アプリの再インストールは不要です。
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
          {plan !== "pro" && pricingPlansUrl && (
            <div style={{ marginTop: "16px" }}>
              <a
                href={pricingPlansUrl}
                target="_top"
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
  priceSummary,
  priceDetail,
  trial,
  summary,
  isCurrent,
  pricingPlansUrl,
}: {
  name: string;
  priceSummary: string;
  priceDetail: string;
  trial: string;
  summary: string;
  isCurrent: boolean;
  pricingPlansUrl: string | null;
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
      <div style={{ marginBottom: "12px", fontSize: "20px", fontWeight: 700 }}>
        {name}
      </div>
      <div style={{ marginBottom: "6px", fontSize: "18px", fontWeight: 700, color: "#202223" }}>
        {priceSummary}
      </div>
      <div style={{ marginBottom: "6px", fontSize: "12px", color: "#6d7175", lineHeight: 1.4 }}>
        {priceDetail}
      </div>
      <div style={{ marginBottom: "12px", fontSize: "13px", color: "#6d7175" }}>
        {trial}
      </div>
      <div style={{ marginBottom: "16px", fontSize: "14px", color: "#6d7175", lineHeight: 1.4 }}>
        {summary}
      </div>
      {isCurrent ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
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
          {pricingPlansUrl && (
            <a
              href={pricingPlansUrl}
              target="_top"
              rel="noopener noreferrer"
              style={{ fontSize: "13px", color: "#2c6ecb" }}
            >
              Shopify でプラン・請求を変更する
            </a>
          )}
        </div>
      ) : pricingPlansUrl ? (
        <a
          href={pricingPlansUrl}
          target="_top"
          rel="noopener noreferrer"
          style={{
            display: "inline-block",
            padding: "8px 16px",
            background: "#2c6ecb",
            color: "#fff",
            borderRadius: "6px",
            fontSize: "14px",
            fontWeight: 500,
            textDecoration: "none",
          }}
        >
          このプランを選択する
        </a>
      ) : (
        <span style={{ fontSize: "13px", color: "#6d7175" }}>プラン選択 URL を準備できません</span>
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
