/**
 * 公開アプリ用 Billing ユーティリティ
 * - サブスクリプション名からプラン（lite/pro）を判定
 * - Usage-based: 基本料金＋(ロケーション数−10)×単価（10 loc 超）
 * 設計: docs/PUBLIC_APP_PLAN_FEATURES_DESIGN.md
 */

export type PlanType = "lite" | "pro";

/** アクティブなサブスクリプション（GraphQL 取得結果の型） */
export type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
  lineItems?: Array<{
    id: string;
    plan?: {
      pricingDetails?: { __typename?: string };
    };
  }>;
};

/**
 * アクティブなサブスクリプション一覧からプランを判定する。
 * 名前に "Pro" を含む → pro、"Lite" を含む → lite。
 * 複数ある場合は Pro を優先。
 */
export function getPlanFromActiveSubscriptions(subscriptions: ActiveSubscription[]): PlanType | null {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return null;
  const active = subscriptions.filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE");
  if (active.length === 0) return null;
  const hasPro = active.some((s) => /pro/i.test(String(s?.name || "")));
  const hasLite = active.some((s) => /lite/i.test(String(s?.name || "")));
  if (hasPro) return "pro";
  if (hasLite) return "lite";
  return null;
}

/** 10 loc 超の従量単価（USD） */
export const USAGE_PRICE_PER_LOCATION = {
  lite: 4,
  pro: 10,
} as const;

/** 基本料金（10ロケーションまで・USD/30日） */
export const BASE_PRICE_UP_TO_10 = {
  lite: 40,
  pro: 100,
} as const;

/**
 * 10ロケーション超の従量料金を計算する。
 * 基本料金＋(ロケーション数−10)×単価。10以下は 0。
 */
export function calculateUsageAmount(
  plan: PlanType,
  locationsCount: number
): { amountUsd: number; extraLocations: number } {
  const extra = Math.max(0, locationsCount - 10);
  const unit = USAGE_PRICE_PER_LOCATION[plan];
  return { amountUsd: extra * unit, extraLocations: extra };
}

/** クエリで取得するサブスクに currentPeriodEnd を含める場合の型 */
export type ActiveSubscriptionWithPeriod = ActiveSubscription & {
  currentPeriodEnd?: string | null;
};

/**
 * Usage 用の LineItem（AppUsagePricing の __typename を持つ行）の id を取得する。
 * appUsageRecordCreate の subscriptionLineItemId に渡す。
 */
export function getUsageLineItemId(subscription: ActiveSubscription): string | null {
  const items = subscription?.lineItems ?? [];
  for (const item of items) {
    const typename = item?.plan?.pricingDetails?.__typename ?? "";
    if (typename === "AppUsagePricing") {
      return item.id ?? null;
    }
  }
  return null;
}

/**
 * 10ロケーション超の従量課金を 1 件報告する。
 * 同一請求期間に複数回呼ばれないよう、idempotencyKey で 1 回だけ請求される。
 * @param admin - GraphQL を実行する admin オブジェクト
 * @param subscriptionLineItemId - Usage 用 line item の ID（AppUsagePricing）
 * @param amountUsd - 請求する金額（USD）
 * @param description - 説明（例: "11+ locations (15 loc): $50.00"）
 * @param idempotencyKey - 同一期間の重複報告を防ぐキー（例: "usage-{subscriptionId}-{currentPeriodEnd}"）
 */
export async function reportUsageRecord(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  subscriptionLineItemId: string,
  amountUsd: number,
  description: string,
  idempotencyKey: string
): Promise<{ success: boolean; userErrors?: Array<{ message: string }> }> {
  if (amountUsd <= 0) return { success: true };
  const mutation = `#graphql
    mutation AppUsageRecordCreate(
      $subscriptionLineItemId: ID!,
      $price: MoneyInput!,
      $description: String!,
      $idempotencyKey: String
    ) {
      appUsageRecordCreate(
        subscriptionLineItemId: $subscriptionLineItemId,
        price: $price,
        description: $description,
        idempotencyKey: $idempotencyKey
      ) {
        userErrors { message }
        appUsageRecord { id }
      }
    }
  `;
  const resp = await admin.graphql(mutation, {
    variables: {
      subscriptionLineItemId,
      price: { amount: amountUsd.toFixed(2), currencyCode: "USD" },
      description,
      idempotencyKey,
    },
  });
  const data = await resp.json();
  const payload = data?.data?.appUsageRecordCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { success: false, userErrors };
  }
  return { success: true };
}

/** トライアル日数（設計書どおり） */
export const TRIAL_DAYS = { lite: 7, pro: 14 } as const;

/** Usage 従量の上限（USD/月）。11 loc 目以降の合計がこの値を超えないようにする目安 */
export const USAGE_CAP_USD = { lite: 200, pro: 500 } as const;

/**
 * サブスクリプションを作成し、承認用 URL を返す。
 * 基本料金（Recurring）＋10 loc 超用の従量（Usage、キャップ付き）の 2 本立て。
 * 開発ストアでは呼ばない想定（呼んでも test: true にはしていない。呼び出し側で制御すること）。
 */
export async function createAppSubscription(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  plan: PlanType,
  returnUrl: string
): Promise<{ confirmationUrl: string | null; userErrors: Array<{ message: string }> }> {
  const name = plan === "pro" ? "Pro - up to 10 locations + usage" : "Lite - up to 10 locations + usage";
  const basePrice = BASE_PRICE_UP_TO_10[plan];
  const trialDays = TRIAL_DAYS[plan];
  const usageCap = USAGE_CAP_USD[plan];
  const terms = plan === "pro" ? "$10 per location for 11+ locations" : "$4 per location for 11+ locations";

  const mutation = `#graphql
    mutation AppSubscriptionCreate(
      $name: String!,
      $returnUrl: URL!,
      $lineItems: [AppSubscriptionLineItemInput!]!,
      $trialDays: Int
    ) {
      appSubscriptionCreate(
        name: $name,
        returnUrl: $returnUrl,
        lineItems: $lineItems,
        trialDays: $trialDays
      ) {
        userErrors { message }
        confirmationUrl
        appSubscription { id }
      }
    }
  `;
  const lineItems = [
    {
      plan: {
        appUsagePricingDetails: {
          terms,
          cappedAmount: { amount: String(usageCap), currencyCode: "USD" },
        },
      },
    },
    {
      plan: {
        appRecurringPricingDetails: {
          price: { amount: String(basePrice), currencyCode: "USD" },
          interval: "EVERY_30_DAYS",
        },
      },
    },
  ];
  const resp = await admin.graphql(mutation, {
    variables: { name, returnUrl, lineItems, trialDays },
  });
  const data = await resp.json();
  const payload = data?.data?.appSubscriptionCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { confirmationUrl: null, userErrors };
  }
  return { confirmationUrl: payload?.confirmationUrl ?? null, userErrors: [] };
}
