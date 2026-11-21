import type { LoaderFunctionArgs } from "react-router";

import { login } from "../../shopify.server";
import { OpenFromShopifyAdmin } from "../../components/OpenFromShopifyAdmin";

// ライブラリが店を特定できないときにここへ来る。
// ?shop= があれば login() が Shopify のインストール／認証へ移す（throw redirect）。
// 無いとき・正しくないときは、ドメインの入力欄は出さずに案内だけを出す（App Store 要件 2.3.1）。
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    await login(request);
  }
  return null;
};

export default function AuthLogin() {
  return <OpenFromShopifyAdmin />;
}
