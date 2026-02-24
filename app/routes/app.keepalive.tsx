// 管理画面を開いたままにしたときの 502 防止用。有料プランでも LB/プロキシのアイドル切断を防ぐため、
// クライアントから定期的に GET し、セッションを維持する。
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
