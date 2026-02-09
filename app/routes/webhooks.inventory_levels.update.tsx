// app/routes/webhooks.inventory_levels.update.tsx
// 在庫レベル更新Webhookハンドラー（管理画面での在庫変動検知）
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import shopify from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone } from "../utils/timezone";

// APIバージョン（shopify.server.tsと同じ値を使用）
const API_VERSION = "2025-10";

export const action = async ({ request }: ActionFunctionArgs) => {
  // デバッグ: webhookが到達したかどうかを確認
  console.log(`[inventory_levels/update] Webhook endpoint called: method=${request.method}, url=${request.url}`);
  
  try {
    const { payload, shop, topic, session } = await authenticate.webhook(request);

    console.log(`[inventory_levels/update] Webhook received: shop=${shop}, topic=${topic}`);

    // topicの形式を正規化（大文字小文字、スラッシュ/アンダースコアの違いに対応）
    // INVENTORY_LEVELS_UPDATE → inventory_levels/update
    const topicStr = String(topic || "").toLowerCase();
    // アンダースコア区切りの形式をスラッシュ区切りに変換
    let normalizedTopic = topicStr;
    if (topicStr === "inventory_levels_update") {
      normalizedTopic = "inventory_levels/update";
    } else if (topicStr.includes("_")) {
      // 最後のアンダースコアをスラッシュに変換（例: inventory_levels_update → inventory_levels/update）
      normalizedTopic = topicStr.replace(/_([^_]+)$/, "/$1");
    }
    
    if (normalizedTopic !== "inventory_levels/update") {
      console.log(`[inventory_levels/update] Invalid topic: ${topic} (normalized: ${normalizedTopic})`);
      return new Response("Invalid topic", { status: 400 });
    }

    // Webhookのペイロード全体をログ出力（デバッグ用）
    console.log(`[inventory_levels/update] Full webhook payload:`, JSON.stringify(payload, null, 2));

    // Webhookのペイロードから在庫情報を取得
    const inventoryLevel = payload as {
      inventory_item_id?: string;
      location_id?: string;
      available?: number;
      updated_at?: string;
      inventory_adjustment_group_id?: string; // 在庫調整グループID（存在する場合）
    };

    if (!inventoryLevel.inventory_item_id || !inventoryLevel.location_id) {
      console.error("Missing required fields in inventory_levels/update webhook:", inventoryLevel);
      return new Response("Missing required fields", { status: 400 });
    }

    // inventory_adjustment_group_idが含まれている場合はログ出力
    if (inventoryLevel.inventory_adjustment_group_id) {
      console.log(`[inventory_levels/update] Found inventory_adjustment_group_id: ${inventoryLevel.inventory_adjustment_group_id}`);
    }

    // 元の形式を保持（データベース保存用）
    const inventoryItemIdRaw = String(inventoryLevel.inventory_item_id);
    const locationIdRaw = String(inventoryLevel.location_id);
    const available = Number(inventoryLevel.available ?? 0);
    const updatedAt = inventoryLevel.updated_at ? new Date(inventoryLevel.updated_at) : new Date();
    
    // locationIdをGID形式に変換（数値形式の場合はGID形式に変換、GraphQLクエリ用）
    const locationId = locationIdRaw.startsWith("gid://") 
      ? locationIdRaw 
      : `gid://shopify/Location/${locationIdRaw}`;
    
    // inventoryItemIdもGID形式に変換（数値形式の場合はGID形式に変換、GraphQLクエリ用）
    const inventoryItemId = inventoryItemIdRaw.startsWith("gid://")
      ? inventoryItemIdRaw
      : `gid://shopify/InventoryItem/${inventoryItemIdRaw}`;

    // セッションが無くても最小限の記録は行う（インストール直後・再デプロイ直後に管理画面を開かなくても履歴に残す）
    let shopTimezone = "UTC";
    let locationName = locationIdRaw;
    let sku = "";
    let variantId: string | null = null;
    let activity: "inbound_transfer" | "outbound_transfer" | "loss_entry" | "inventory_count" | "admin_webhook" = "admin_webhook";
    let adjustmentGroupId: string | null = inventoryLevel.inventory_adjustment_group_id || null;
    let sourceId: string | null = null;

    if (session) {
      // adminクライアントを作成（ロケーション名・SKU・種別判定に使用）
      let admin: { request: (options: { data: string; variables?: any }) => Promise<any> };
      if (shopify?.clients?.Graphql) {
        admin = shopify.clients.Graphql({ session });
      } else {
        console.log(`[inventory_levels/update] shopify.clients not available, creating GraphQL client from session`);
        const shopDomain = session.shop;
        const accessToken = session.accessToken;
        admin = {
          request: async (options: { data: string; variables?: any }) => {
            const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({
              query: options.data.replace(/^#graphql\s*/m, "").trim(),
              variables: options.variables || {},
            }),
          });
          return response;
        },
      };
    }

      const shopTimezoneResp = await admin.request({
        data: `
          #graphql
          query GetShopTimezone {
            shop {
              ianaTimezone
            }
          }
        `,
      });
      const shopTimezoneData = await shopTimezoneResp.json();
      shopTimezone = shopTimezoneData?.data?.shop?.ianaTimezone || "UTC";

      // ロケーション名を取得（GraphQL）
      const locationResp = await admin.request({
        data: `
          #graphql
          query GetLocation($id: ID!) {
            location(id: $id) {
              id
              name
            }
          }
        `,
        variables: { id: locationId },
      });
      const locationData = await locationResp.json();
      locationName = locationData?.data?.location?.name || locationIdRaw;

      // SKUを取得（InventoryItemから）
      const itemResp = await admin.request({
        data: `
          #graphql
          query GetInventoryItem($id: ID!) {
            inventoryItem(id: $id) {
              id
              variant {
                id
                sku
              }
            }
          }
        `,
        variables: { id: inventoryItemId },
      });
      const itemData = await itemResp.json();
      sku = itemData?.data?.inventoryItem?.variant?.sku || "";
      variantId = itemData?.data?.inventoryItem?.variant?.id || null;

      // 入庫・出庫・ロス・棚卸・仕入をすべて「同じ処理」にするため、Webhook では種別を判定しない。
      // 常に admin_webhook（管理）で保存し、POS/アプリの api/log-inventory-change が正しい activity で上書きする。
      // （以前は adjustment_group の referenceUri からロス等を判定していたが、ロスだけ記録されて他が「管理」のままになる原因になり得たため廃止。）
      activity = "admin_webhook";
      sourceId = null;
      if (adjustmentGroupId) {
        console.log(`[inventory_levels/update] adjustment_group_id present but not used for activity; recording as admin_webhook. API will overwrite.`);
      } else {
        console.log(`[inventory_levels/update] No adjustment_group_id. Recording as admin_webhook; api/log-inventory-change will overwrite to correct activity.`);
      }
      console.log(`[inventory_levels/update] Final activity: admin_webhook (API overwrites for all: loss, inbound, outbound, stocktake, purchase).`);
    } else {
      console.log(`[inventory_levels/update] No session; saving minimal log (no GraphQL). 管理画面でアプリを開くとロケーション名・SKUが取得されます。`);
    }

    // 日付を取得（YYYY-MM-DD形式）
    const date = getDateInShopTimezone(updatedAt, shopTimezone);

    // 直前の在庫値を取得（delta計算用）
    let prevAvailable: number | null = null;
    let delta: number | null = null;
    let idempotencyKey = "";
    let existingLog = null;

    try {
      if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
        const prevLog = await (db as any).inventoryChangeLog.findFirst({
          where: {
            shop,
            inventoryItemId: inventoryItemIdRaw, // 元の形式を使用
            locationId: locationIdRaw, // 元の形式を使用
          },
          orderBy: {
            timestamp: "desc",
          },
        });

        prevAvailable = prevLog?.quantityAfter ?? null;
        delta = prevAvailable !== null ? available - prevAvailable : null;

        // idempotencyKeyを生成（重複防止、元の形式を使用）
        idempotencyKey = `${shop}:${inventoryItemIdRaw}:${locationIdRaw}:${updatedAt.toISOString()}:${available}`;

        // 既に同じidempotencyKeyのログが存在する場合はスキップ（二重登録防止）
        existingLog = await (db as any).inventoryChangeLog.findUnique({
          where: {
            shop_idempotencyKey: {
              shop,
              idempotencyKey,
            },
          },
        });

        if (existingLog) {
          console.log(`Skipping duplicate webhook: ${idempotencyKey}`);
          return new Response("OK", { status: 200 });
        }
      } else {
        console.warn("InventoryChangeLog model not found in Prisma client. Please restart the dev server.");
        return new Response("OK", { status: 200 }); // Webhookは成功として返す（ログは保存されない）
      }
    } catch (error) {
      console.error("Error checking previous log:", error);
      // エラーが発生しても続行（deltaはnullのまま）
    }

    // 変動がない（delta が 0）場合はログを保存しない（「0」の行が履歴に並ばないようにする）
    if (delta === 0) {
      console.log(`[inventory_levels/update] Skipping log: no change (delta=0), item=${inventoryItemIdRaw}, location=${locationIdRaw}, quantityAfter=${available}`);
      return new Response("OK", { status: 200 });
    }

    // 同一の在庫変動がすでに別の経路で記録されていたら webhook では保存しない。
    // （POS/アプリの api/log-inventory-change、売上 orders.updated、返品 refunds.create で正しい種別が付いている）
    // そうしないと二重に「管理」で保存され、売上・返品・ロス等が「管理」で上書きされたように見える。
    if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
      const knownActivities = [
        "loss_entry", "purchase_entry", "inbound_transfer", "outbound_transfer", "inventory_count",
        "order_sales", "refund", // 売上・返品（orders.updated / refunds.create で記録済み）
      ];
      const recentThreshold = new Date(updatedAt.getTime() - 2 * 60 * 1000); // 2分前
      const duplicateLog = await (db as any).inventoryChangeLog.findFirst({
        where: {
          shop,
          inventoryItemId: inventoryItemIdRaw,
          locationId: locationIdRaw,
          quantityAfter: available,
          activity: { in: knownActivities },
          timestamp: { gte: recentThreshold },
        },
        orderBy: { timestamp: "desc" },
      });
      if (duplicateLog) {
        console.log(`[inventory_levels/update] Skipping webhook log: same change already recorded (activity=${duplicateLog.activity}, id=${duplicateLog.id})`);
        return new Response("OK", { status: 200 });
      }
    }

    // 在庫変動ログを保存（deltaがnullでも記録する）
    try {
      if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
        console.log(`[inventory_levels/update] Saving log: shop=${shop}, item=${inventoryItemIdRaw}, location=${locationIdRaw}, locationName=${locationName}, delta=${delta}, quantityAfter=${available}, date=${date}, activity=${activity}`);
        
        // deltaがnullの場合でも記録する（管理画面からの操作の場合、直前の値が取れないことがある）
        if (delta === null) {
          console.log(`[inventory_levels/update] Warning: delta is null, but saving log anyway`);
        }
        
        await (db as any).inventoryChangeLog.create({
          data: {
            shop,
            timestamp: updatedAt,
            date,
            inventoryItemId: inventoryItemIdRaw, // 元の形式を使用
            variantId,
            sku,
            locationId: locationIdRaw, // 元の形式を使用
            locationName, // ロケーション名は取得済み
            activity,
            delta,
            quantityAfter: available,
            sourceType: activity,
            sourceId,
            adjustmentGroupId,
            idempotencyKey,
            note: null,
          },
        });
        
        console.log(`[inventory_levels/update] Log saved successfully`);
      } else {
        console.warn(`[inventory_levels/update] InventoryChangeLog model not found in Prisma client. Please restart the dev server.`);
      }
    } catch (error) {
      console.error("[inventory_levels/update] Error saving inventory change log:", error);
      // エラーが発生してもWebhookは成功として返す
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("inventory_levels/update webhook error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
};
