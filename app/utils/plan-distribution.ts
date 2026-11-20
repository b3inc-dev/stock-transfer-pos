// 料金プランの判定で「このサーバーは自社用か公開用か」を決める（純粋関数。テストは tests/plan-access.test.mjs）。
//
// 今までの決まり（app.tsx の getShopPlan）をそのまま残し、自社用を守るための条件を 1 つだけ足す。
// - 自社用: APP_DISTRIBUTION=inhouse、または店が CUSTOM_APP_STORE_IDS にある（今まで通り）
// - 公開用: APP_DISTRIBUTION=public がはっきり入っている（今まで通り）
// - 自社用（足した条件）: APP_DISTRIBUTION が空かつ SHOPIFY_API_KEY が公開用アプリの client_id（shopify.app.public.toml）とはっきり違う
//   → 自社用の Render で APP_DISTRIBUTION が抜けても、Ciara の POS と管理画面を止めない
// - それ以外: 公開用（今まで通り。環境変数が無いときは公開用として料金プランを見る）

export type PlanDistribution = "inhouse" | "public";

export function resolvePlanDistribution(
  env: Record<string, string | undefined>,
  shop: string | null | undefined,
  publicClientId: string | null | undefined,
): { distribution: PlanDistribution; forceInhouse: boolean } {
  const shopNormalized = (shop ?? "").trim().toLowerCase();
  const custom = (env.CUSTOM_APP_STORE_IDS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const forceInhouse = Boolean(shopNormalized && custom.includes(shopNormalized));
  const dist = (env.APP_DISTRIBUTION ?? "").trim().toLowerCase();
  if (dist === "inhouse" || forceInhouse) return { distribution: "inhouse", forceInhouse };
  if (dist === "public") return { distribution: "public", forceInhouse };
  const apiKey = (env.SHOPIFY_API_KEY ?? "").trim();
  const publicId = (publicClientId ?? "").trim();
  if (apiKey && publicId && apiKey !== publicId) return { distribution: "inhouse", forceInhouse };
  return { distribution: "public", forceInhouse };
}
