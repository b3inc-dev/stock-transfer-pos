/**
 * 公開アプリ用 Billing ユーティリティ
 * - サブスクリプション名からプラン（lite/pro）を判定
 * - Managed Pricing（Shopify App Pricing）のプラン選択 URL
 * - 10 loc 超: (ロケーション数−10)×単価を App Events API の使用量で報告（app-events-usage.server.ts）
 * 設計: docs/PUBLIC_APP_PLAN_FEATURES_DESIGN.md
 */

export type PlanType = "lite" | "pro";

/**
 * 公開アプリの App Handle（Managed Pricing / pricing_plans URL 用）。
 * 優先: SHOPIFY_APP_HANDLE → 既定 "pos-stock"（shopify.app.public.toml の公開アプリ）。
 * フォールバックに "app" は使わない（誤 URL → accounts.shopify.com 拒否の原因になる）。
 */
export function getPublicAppHandle(): string {
  const fromEnv = (process.env.SHOPIFY_APP_HANDLE ?? "").trim();
  return fromEnv || "pos-stock";
}

/**
 * Shopify Managed Pricing（App Pricing）のプラン選択ページ URL。
 * 必ず admin.shopify.com を使う（*.myshopify.com だと accounts.shopify.com へ飛び iframe で拒否される）。
 * 埋め込みアプリからは target="_top" で開くこと。
 */
export function buildManagedPricingPlansUrl(shopDomain: string | undefined | null): string | null {
  const shop = String(shopDomain ?? "").trim().toLowerCase();
  if (!shop) return null;
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "").replace(/^https?:\/\//, "").split("/")[0];
  if (!storeHandle || storeHandle.includes(".") || storeHandle === "admin") return null;
  const appHandle = getPublicAppHandle();
  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}

/** アクティブなサブスクリプション（GraphQL 取得結果の型） */
export type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
};

/**
 * アクティブなサブスクリプション一覧からプランを判定する。
 * 名前に "Pro" を含む → pro、"Lite" を含む → lite。
 * 複数ある場合は Pro を優先。
 * 有効な契約はあるが名前から読めないとき → lite（払っている店を「未契約」として止めない。下限の Lite に倒す）。
 * 開発ストアのテスト課金（test: true）も Shopify は ACTIVE で返すので、同じく契約として数える。
 */
export function getPlanFromActiveSubscriptions(subscriptions: ActiveSubscription[]): PlanType | null {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return null;
  const active = subscriptions.filter((s) => String(s?.status || "").toUpperCase() === "ACTIVE");
  if (active.length === 0) return null;
  const hasPro = active.some((s) => /pro/i.test(String(s?.name || "")));
  const hasLite = active.some((s) => /lite/i.test(String(s?.name || "")));
  if (hasPro) return "pro";
  if (hasLite) return "lite";
  console.warn(
    "[billing] active subscription name has neither Pro nor Lite; treating as lite:",
    active.map((s) => String(s?.name || "")).join(", ")
  );
  return "lite";
}

/**
 * この契約がプラン（getPlanFromActiveSubscriptions の結果）を決めた契約か。従量の請求期間をその契約から取るのに使う。
 * Pro は名前に pro を含む契約。Lite は名前に lite を含む契約（名前から読めず Lite に倒したときは、ACTIVE な契約のどれでも）。
 */
export function subscriptionDecidesPlan(
  sub: { name?: string | null; status?: string | null },
  plan: "lite" | "pro",
  allSubscriptions: ReadonlyArray<{ name?: string | null; status?: string | null }>
): boolean {
  const name = String(sub?.name ?? "");
  if (plan === "pro") return /pro/i.test(name);
  if (/lite/i.test(name)) return true;
  const active = allSubscriptions.filter((s) => String(s?.status ?? "").toUpperCase() === "ACTIVE");
  return !active.some((s) => /lite|pro/i.test(String(s?.name ?? "")));
}

/**
 * サブスクリプション名から「3ロケーション用」か「10ロケーション用」かを判定する。
 * パートナーで lite-3 / lite-10 / pro-3 / pro-10（必ずハイフン）のように設定している場合、名前に "10" または "3" が含まれる想定。
 * アンダースコアの handle（lite_3 / pro_10）は受け付けない（console.error を出して null）。
 * 判定できない場合は null（制限しない）。
 */
export function getMaxLocationsFromSubscriptionName(name: string): 3 | 10 | null {
  const n = String(name || "").trim();
  if (!n) return null;
  // プランの handle はハイフン（lite-3 / pro-10）。アンダースコア（lite_3 / pro_10）は受け付けない。
  // そのまま読むと 3/10 が取れず「制限なし」に黙って倒れるので、はっきりログを出す（判定は null のまま）。
  const underscored = findUnderscorePlanHandles(n);
  if (underscored.length > 0) {
    console.error(
      `[billing] plan handle uses underscore (${underscored.join(", ")}); POS Stock plan handles must use hyphens ` +
        `(${underscored.map((h) => h.replace(/_/g, "-")).join(", ")}). Location limit NOT applied for:`,
      n
    );
    return null;
  }
  // 先に 10 を判定（lite-10, "10 locations", "10ロケーション" など）
  if (/-10\b|10ロケーション|10\s*locations?/i.test(n)) return 10;
  if (/\b10\b/.test(n)) return 10;
  // 3 を判定（lite-3, "3 locations", "3ロケーション" など）
  if (/-3\b|3ロケーション|3\s*locations?/i.test(n)) return 3;
  if (/\b3\b/.test(n)) return 3;
  return null;
}

/** 10 loc 超の従量単価（USD）。送るのは app-events-usage.server.ts（App Events API） */
export const USAGE_PRICE_PER_LOCATION = {
  lite: 4,
  pro: 12,
} as const;

/** 基本料金（10ロケーションまで・USD/30日）。料金は Partner Dashboard の App Pricing で決まる（ここは画面の目安） */
export const BASE_PRICE_UP_TO_10 = {
  lite: 40,
  pro: 120,
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

/** トライアル日数（設計書どおり） */
export const TRIAL_DAYS = { lite: 7, pro: 14 } as const;

// 2026-11-21（T の決定）: 料金は Shopify App Pricing。Billing API の
// appSubscriptionCreate（createAppSubscription）と appUsageRecordCreate（reportUsageRecord）は消した。
// App Pricing の契約に Billing API の従量を付けることはできない（App Events API では INVALID_SUBSCRIPTION）。
// 10 か所を超えた分は app/utils/app-events-usage.server.ts が App Events API で送る。

/** アンダースコアで書かれたプランの handle（lite_3 / pro_10 など）を拾う。正しい形はハイフン（lite-3 / pro-10） */
export function findUnderscorePlanHandles(name: string): string[] {
  return Array.from(String(name || "").matchAll(/(?:^|[^a-z0-9])((?:lite|pro)_(?:3|10))(?![a-z0-9])/gi), (m) => m[1]);
}
