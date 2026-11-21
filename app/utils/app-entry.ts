// アプリの URL（ルート）や /auth/login を直接開いたときの行き先を決める。
// Shopify 管理画面から開くと ?shop= / ?host= / ?embedded= が付くので、そのまま /app へ渡す
// （/app の authenticate.admin が埋め込み画面への移動と OAuth を受け持つ）。
// どれも無いときは店が分からないので null を返し、呼び出し側は「Shopify 管理画面から開いてください」の案内を出す。
// 店のドメインを手で入れさせる欄は出さない（App Store 要件 2.3.1）。

const ENTRY_PARAMS = ["shop", "host", "embedded", "id_token"];

export function appEntryRedirectPath(url: URL): string | null {
  const hasEntryParam = ENTRY_PARAMS.some((key) => {
    const value = url.searchParams.get(key);
    return typeof value === "string" && value.trim() !== "";
  });
  if (!hasEntryParam) return null;
  const query = url.searchParams.toString();
  return query ? `/app?${query}` : "/app";
}
