// 必須コンプライアンス Webhook（App Store 審査で必須）
// https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
// - customers/data_request: 顧客データの開示要求
// - customers/redact: 顧客データの削除要求
// - shop/redact: ショップデータの削除要求（アンインストール 48 時間後）
// HMAC 検証は authenticate.webhook(request) 内で実施され、不正な場合は 401 の Response が投げられる。
// topic の形（"SHOP_REDACT" / "shop/redact"）の違いと消す処理は app/utils/compliance-webhook.ts。
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleComplianceWebhook, type ComplianceDb } from "../utils/compliance-webhook";

export const loader = async () => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let webhook: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    webhook = await authenticate.webhook(request);
  } catch (err) {
    // HMAC が正しくないときなど。ライブラリが投げた Response（401 など）はそのまま返す。
    if (err instanceof Response) return err;
    console.error("[webhooks.compliance] authenticate error:", err);
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { status } = await handleComplianceWebhook({
      topic: webhook.topic,
      shop: webhook.shop,
      payload: webhook.payload,
      // Prisma の deleteMany は引数の型が細かいので、この処理で使う形（ComplianceDb）として渡す。
      db: db as unknown as ComplianceDb,
    });
    return new Response(null, { status });
  } catch (err) {
    // DB の失敗など。500 を返して Shopify にもう一度送ってもらう（消すだけなので何度でも安全）。
    console.error("[webhooks.compliance] handler error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
};
