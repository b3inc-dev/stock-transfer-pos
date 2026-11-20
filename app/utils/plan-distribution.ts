// 「このサーバーは自社用か公開用か」を決める、ただ 1 つの決まり（純粋関数）。
// 料金プランの門番（shop-plan.server.ts）と、shop/redact で消してよいかの判断（shop-install-probe）が同じものを使う。
// テストは tests/plan-access.test.mjs と tests/compliance-webhook.test.mjs。
//
// 上から順に見て、最初に当たったもので決める。
// 1. SHOPIFY_API_KEY が自社用アプリの client_id（shopify.app.toml）と同じ → 自社用（ほかの値に関係なく。Ciara を止めない）
// 2. APP_DISTRIBUTION=inhouse、または店が CUSTOM_APP_STORE_IDS にある → 自社用
// 3. APP_DISTRIBUTION=public → 公開用
// 4. SHOPIFY_API_KEY が公開用アプリの client_id（shopify.app.public.toml）と同じ → 公開用
// 5. SHOPIFY_API_KEY があって、公開用の client_id とはっきり違う → 自社用
// 6. それ以外（環境変数が無い・つづりが違う・toml が読めない）→ 分からない（null）
//
// 分からないときだけ、使う側の目的で倒す向きが違う（決まりそのものは同じ）。
// - 料金プラン（resolvePlanDistribution）: 公開用（今まで通り。公開用の Render は APP_DISTRIBUTION 未設定でもよいと docs にある）
// - shop/redact（resolveServerDistribution）: 自社用（元に戻せない削除をしない）

export type PlanDistribution = "inhouse" | "public";

export type DistributionReason =
  | "inhouse_client_id"
  | "app_distribution_inhouse"
  | "custom_app_store"
  | "app_distribution_public"
  | "public_client_id"
  | "api_key_not_public"
  | "unknown";

export function detectServerDistribution(
  env: Record<string, string | undefined>,
  shop: string | null | undefined,
  publicClientId: string | null | undefined,
  inhouseClientId?: string | null,
): { distribution: PlanDistribution | null; forceInhouse: boolean; reason: DistributionReason } {
  const shopNormalized = (shop ?? "").trim().toLowerCase();
  const custom = (env.CUSTOM_APP_STORE_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const forceInhouse = Boolean(shopNormalized && custom.includes(shopNormalized));
  const apiKey = (env.SHOPIFY_API_KEY ?? "").trim();
  const publicId = (publicClientId ?? "").trim();
  const inhouseId = (inhouseClientId ?? "").trim();
  const dist = (env.APP_DISTRIBUTION ?? "").trim().toLowerCase();
  if (apiKey && inhouseId && apiKey === inhouseId) return { distribution: "inhouse", forceInhouse, reason: "inhouse_client_id" };
  if (dist === "inhouse") return { distribution: "inhouse", forceInhouse, reason: "app_distribution_inhouse" };
  if (forceInhouse) return { distribution: "inhouse", forceInhouse, reason: "custom_app_store" };
  if (dist === "public") return { distribution: "public", forceInhouse, reason: "app_distribution_public" };
  if (apiKey && publicId && apiKey === publicId) return { distribution: "public", forceInhouse, reason: "public_client_id" };
  if (apiKey && publicId && apiKey !== publicId) return { distribution: "inhouse", forceInhouse, reason: "api_key_not_public" };
  return { distribution: null, forceInhouse, reason: "unknown" };
}

/** 料金プランの門番用。分からないときは公開用（料金プランを見る）。 */
export function resolvePlanDistribution(
  env: Record<string, string | undefined>,
  shop: string | null | undefined,
  publicClientId: string | null | undefined,
  inhouseClientId?: string | null,
): { distribution: PlanDistribution; forceInhouse: boolean } {
  const detected = detectServerDistribution(env, shop, publicClientId, inhouseClientId);
  return { distribution: detected.distribution ?? "public", forceInhouse: detected.forceInhouse };
}

/**
 * shop/redact で消してよいか（公開用か）の判断用。元に戻せない処理なので、分からないときは自社用（消さない）。
 * （POS 拡張の APP_MODE は extensions/common/appUrl.js の中の値で、サーバーの環境変数ではないので見ない）
 */
export function resolveServerDistribution(
  env: Record<string, string | undefined>,
  shop: string | null | undefined,
  publicClientId: string | null | undefined,
  inhouseClientId?: string | null,
): PlanDistribution {
  return detectServerDistribution(env, shop, publicClientId, inhouseClientId).distribution ?? "inhouse";
}
