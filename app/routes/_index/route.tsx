import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { OpenFromShopifyAdmin } from "../../components/OpenFromShopifyAdmin";
import { appEntryRedirectPath } from "../../utils/app-entry";

// アプリの URL（ルート）。Shopify 管理画面から開かれたら埋め込みのアプリ画面（/app）へ移す。
// 店が分からないときは、ドメインを入れさせずに「管理画面から開いてください」の案内だけを出す。
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const to = appEntryRedirectPath(new URL(request.url));
  if (to) throw redirect(to);
  return null;
};

export default function Index() {
  return <OpenFromShopifyAdmin />;
}
