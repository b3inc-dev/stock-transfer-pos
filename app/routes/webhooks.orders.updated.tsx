// app/routes/webhooks.orders.updated.tsx
// 注文更新Webhookハンドラー（売上時の在庫変動検知）
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import shopify from "../shopify.server";
import db from "../db.server";
import { logInventoryChange, getShopTimezoneAndDate, getLocationName } from "../utils/inventory-change-log";

// APIバージョン（shopify.server.tsと同じ値を使用）
const API_VERSION = "2025-10";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, shop, topic, session } = await authenticate.webhook(request);

    if (topic !== "orders/updated") {
      return new Response("Invalid topic", { status: 400 });
    }

    // Webhookのペイロードから注文情報を取得
    const order = payload as {
      id?: number;
      name?: string;
      line_items?: Array<{
        id?: number;
        variant_id?: number;
        sku?: string;
        quantity?: number;
        fulfillable_quantity?: number;
      }>;
      fulfillments?: Array<{
        id?: number;
        status?: string;
        created_at?: string;
        location_id?: number;
        line_items?: Array<{
          id?: number;
          quantity?: number;
        }>;
      }>;
      cancelled_at?: string | null;
      financial_status?: string;
    };

    if (!order.id || !order.line_items || order.line_items.length === 0) {
      return new Response("OK", { status: 200 }); // 注文に商品がない場合はスキップ
    }

    // セッションからadminクライアントを作成
    if (!session) {
      console.error("No session found for webhook");
      return new Response("No session", { status: 401 });
    }

    // adminクライアントを作成
    // shopify.clientsが存在しない場合、sessionから直接GraphQLクライアントを作成
    let admin: { request: (options: { data: string; variables?: any }) => Promise<any> };
    
    if (shopify?.clients?.Graphql) {
      admin = shopify.clients.Graphql({ session });
    } else {
      // shopify.clientsが存在しない場合、sessionから直接GraphQLクライアントを作成
      console.log(`[orders/updated] shopify.clients not available, creating GraphQL client from session`);
      const shopDomain = session.shop;
      const accessToken = session.accessToken;
      
      // GraphQLクライアントを直接作成
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

    // 注文がキャンセルされている場合はスキップ
    if (order.cancelled_at) {
      return new Response("OK", { status: 200 });
    }

    // 履行された商品の在庫変動を記録
    if (order.fulfillments && order.fulfillments.length > 0) {
      for (const fulfillment of order.fulfillments) {
        // 履行が完了している場合のみ処理
        if (fulfillment.status !== "success" && fulfillment.status !== "open") {
          continue;
        }

        const fulfillmentLocationId = fulfillment.location_id 
          ? `gid://shopify/Location/${fulfillment.location_id}`
          : null;

        if (!fulfillmentLocationId || !fulfillment.line_items || fulfillment.line_items.length === 0) {
          continue;
        }

        const fulfillmentCreatedAt = fulfillment.created_at 
          ? new Date(fulfillment.created_at)
          : new Date();

        // 履行された商品ごとに在庫変動を記録
        for (const fulfillmentLineItem of fulfillment.line_items) {
          // 注文のline_itemsから該当する商品を検索
          const orderLineItem = order.line_items.find(
            (item) => item.id === fulfillmentLineItem.id
          );

          if (!orderLineItem || !orderLineItem.variant_id) {
            continue;
          }

          const variantId = `gid://shopify/ProductVariant/${orderLineItem.variant_id}`;
          const quantity = fulfillmentLineItem.quantity || 0;

          if (quantity <= 0) {
            continue;
          }

          try {
            // variantIdからinventoryItemIdとSKUを取得
            const variantResp = await admin.request({
              data: `
                #graphql
                query GetVariant($id: ID!) {
                  productVariant(id: $id) {
                    id
                    sku
                    inventoryItem {
                      id
                    }
                  }
                }
              `,
              variables: { id: variantId },
            });
            const variantData = variantResp && typeof variantResp.json === "function" ? await variantResp.json() : variantResp;
            const variant = variantData?.data?.productVariant;
            const inventoryItemId = variant?.inventoryItem?.id;
            const sku = variant?.sku || orderLineItem.sku || "";

            if (!inventoryItemId) {
              console.warn(`InventoryItem not found for variant ${variantId}`);
              continue;
            }

            // ロケーション名を取得
            const locationName = await getLocationName(admin, fulfillmentLocationId);

            // タイムゾーンと日付を取得
            const { timezone, date } = await getShopTimezoneAndDate(admin, fulfillmentCreatedAt);

            // 変動後の数量を取得（InventoryLevelから）
            let quantityAfter: number | null = null;
            try {
              const levelResp = await admin.request({
                data: `
                  #graphql
                  query GetInventoryLevel($itemId: ID!) {
                    inventoryItem(id: $itemId) {
                      inventoryLevels(first: 250) {
                        edges {
                          node {
                            location {
                              id
                            }
                            quantities(names: ["available"]) {
                              name
                              quantity
                            }
                          }
                        }
                      }
                    }
                  }
                `,
                variables: { itemId: inventoryItemId },
              });
              const levelData = levelResp && typeof levelResp.json === "function" ? await levelResp.json() : levelResp;
              // 特定のロケーションに一致するInventoryLevelを検索
              const levels = levelData?.data?.inventoryItem?.inventoryLevels?.edges || [];
              const matchingLevel = levels.find(
                (edge: any) => edge?.node?.location?.id === fulfillmentLocationId
              );
              if (matchingLevel?.node?.quantities?.[0]) {
                quantityAfter = matchingLevel.node.quantities[0].quantity;
              }
            } catch (error) {
              console.error("Failed to get inventory level:", error);
            }

            // 直前の在庫値を取得（delta計算用）
            let delta: number | null = null;
            try {
              if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
                const prevLog = await (db as any).inventoryChangeLog.findFirst({
                  where: {
                    shop,
                    inventoryItemId: inventoryItemId,
                    locationId: fulfillmentLocationId,
                  },
                  orderBy: {
                    timestamp: "desc",
                  },
                });

                const prevAvailable = prevLog?.quantityAfter ?? null;
                delta = prevAvailable !== null && quantityAfter !== null 
                  ? quantityAfter - prevAvailable 
                  : -quantity; // 直前値が取れない場合は、履行数量をマイナスとして記録
              }
            } catch (error) {
              console.error("Error checking previous log:", error);
              delta = -quantity; // エラー時は履行数量をマイナスとして記録
            }

            // 二重登録防止用キーを生成
            const orderId = `order_${order.id}`;
            const fulfillmentId = fulfillment.id ? `fulfillment_${fulfillment.id}` : "";
            const lineItemId = fulfillmentLineItem.id ? `line_item_${fulfillmentLineItem.id}` : "";
            const idempotencyKey = `${shop}_order_sales_${inventoryItemId}_${fulfillmentLocationId}_${orderId}_${fulfillmentId}_${lineItemId}_${fulfillmentCreatedAt.toISOString()}`;

            // 既に同じidempotencyKeyのログが存在する場合はスキップ（二重登録防止）
            try {
              if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
                const existingLog = await (db as any).inventoryChangeLog.findUnique({
                  where: {
                    shop_idempotencyKey: {
                      shop,
                      idempotencyKey,
                    },
                  },
                });

                if (existingLog) {
                  console.log(`Skipping duplicate order fulfillment log: ${idempotencyKey}`);
                  continue;
                }
              }
            } catch (error) {
              console.error("Error checking existing log:", error);
            }

            // 在庫変動ログを保存（date はショップタイムゾーンで統一）
            await logInventoryChange({
              shop,
              timestamp: fulfillmentCreatedAt,
              date,
              inventoryItemId: inventoryItemId,
              variantId: variantId,
              sku: sku,
              locationId: fulfillmentLocationId,
              locationName,
              activity: "order_sales",
              delta,
              quantityAfter,
              sourceType: "order_sales",
              sourceId: orderId,
              adjustmentGroupId: null,
              idempotencyKey,
              note: `注文: ${order.name || orderId}`,
            });
          } catch (error) {
            console.error(`Error logging inventory change for order ${order.id}, fulfillment ${fulfillment.id}:`, error);
            // エラーが発生しても続行
          }
        }
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("orders/updated webhook error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
};
