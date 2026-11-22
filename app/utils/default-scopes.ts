// SCOPES の環境変数が無いときに使うスコープ（toml の access_scopes と同じ文字列）。
// 自社用（Ciara）と公開用で違う: 公開用は read_orders を持たない（2026-11-22 T の決定・#79・DECISIONS D18）。
// toml と合わないと、Shopify のセッションのスコープと食い違い、毎回トークンを取り直すことになる（推測: ライブラリは
// 設定のスコープとセッションのスコープが同じかを見る）。tests/public-scopes.test.mjs が toml と同じかを確かめる。
import type { PlanDistribution } from "./plan-distribution";

/** shopify.app.toml（自社用・Ciara）の scopes と同じ */
export const INHOUSE_DEFAULT_SCOPES =
  "read_inventory,read_inventory_transfers,read_locations,read_products,write_inventory,write_inventory_shipments,write_inventory_shipments_received_items,write_inventory_transfers,read_orders";

/** shopify.app.public.toml（公開用）の scopes と同じ。read_orders は無い */
export const PUBLIC_DEFAULT_SCOPES =
  "read_inventory,read_inventory_transfers,read_locations,read_products,write_inventory,write_inventory_shipments,write_inventory_shipments_received_items,write_inventory_transfers";

/**
 * 使うスコープを決める。SCOPES があればそれ。無ければ公開用／自社用で選ぶ。
 * 分からないとき（null）は自社用（今までの動きのまま。Ciara を変えない）。
 */
export function resolveAppScopes(scopesEnv: string | undefined, distribution: PlanDistribution | null): string[] {
  const fromEnv = (scopesEnv ?? "").trim();
  const text = fromEnv || (distribution === "public" ? PUBLIC_DEFAULT_SCOPES : INHOUSE_DEFAULT_SCOPES);
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}
