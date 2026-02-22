// 必須コンプライアンス Webhook（App Store 審査で必須）
// https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
// - customers/data_request: 顧客データの開示要求
// - customers/redact: 顧客データの削除要求
// - shop/redact: ショップデータの削除要求（アンインストール 48 時間後）
// HMAC 検証は authenticate.webhook(request) 内で実施され、不正な場合は 401 を返す。
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return new Response("Method Not Allowed", { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { payload, topic, shop } = await authenticate.webhook(request);
    const topicStr = String(topic ?? "");

    if (topicStr === "customers/data_request") {
      // 顧客データの開示要求: ストアオーナーに提供するデータを返す。
      // 本アプリは顧客のメール・電話などを個別に保存していないため、対応不要の旨を記録するのみ。
      // 必要に応じてストアオーナー向けのレポートを生成する処理を追加可能。
      return new Response(null, { status: 200 });
    }

    if (topicStr === "customers/redact") {
      // 顧客データの削除要求: 指定された注文IDに紐づくデータを削除する。
      const body = payload as {
        shop_id?: number;
        shop_domain?: string;
        customer?: { id: number; email?: string; phone?: string };
        orders_to_redact?: number[];
      };
      const shopDomain = body.shop_domain ?? shop;
      const orderIds = (body.orders_to_redact ?? []).map(String);
      if (orderIds.length > 0) {
        await db.orderPendingLocation.deleteMany({
          where: { shop: shopDomain, orderId: { in: orderIds } },
        });
        await db.refundPendingLocation.deleteMany({
          where: { shop: shopDomain, orderId: { in: orderIds } },
        });
      }
      return new Response(null, { status: 200 });
    }

    if (topicStr === "shop/redact") {
      // ショップデータの削除要求: アンインストール 48 時間後に送信される。当該ショップの全データを削除する。
      const body = payload as { shop_id?: number; shop_domain?: string };
      const shopDomain = body.shop_domain ?? shop;
      await db.session.deleteMany({ where: { shop: shopDomain } });
      await db.inventoryChangeLog.deleteMany({ where: { shop: shopDomain } });
      await db.orderPendingLocation.deleteMany({ where: { shop: shopDomain } });
      await db.refundPendingLocation.deleteMany({ where: { shop: shopDomain } });
      return new Response(null, { status: 200 });
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    // HMAC 検証失敗時は authenticate.webhook がエラーを投げる。401 を返す。
    console.error("[webhooks.compliance] Error:", err);
    return new Response("Unauthorized", { status: 401 });
  }
};
