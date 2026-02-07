import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/**
 * スプラットルート: どのルートにもマッチしなかったパス用。
 * Shopify 管理画面からアプリを開くとき、App URL にパスが含まれている
 * （例: /embed, /app）と、このルートに来て "Not Found" になっていたため、
 * shop または host クエリがある場合は /app へリダイレクトする。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");

  if (shop || host) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  // それ以外は 404 として扱う（React Router のデフォルト）
  throw new Response("Not Found", { status: 404 });
};

export default function SplatFallback() {
  return (
    <div style={{ padding: "2rem", textAlign: "center", fontFamily: "sans-serif" }}>
      <h1>Not Found</h1>
      <p>お探しのページは存在しません。</p>
    </div>
  );
}
