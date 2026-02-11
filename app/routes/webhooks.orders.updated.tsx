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
    let payload, shop, topic, session;
    try {
      const result = await authenticate.webhook(request);
      payload = result.payload;
      shop = result.shop;
      topic = result.topic;
      session = result.session;
    } catch (authError) {
      console.error(`[orders/updated] Webhook authentication error:`, authError);
      if (authError instanceof Error) {
        console.error(`[orders/updated] Auth error message:`, authError.message);
        console.error(`[orders/updated] Auth error stack:`, authError.stack);
      }
      return new Response("Authentication failed", { status: 401 });
    }

    console.log(`[orders/updated] Webhook received: shop=${shop}, topic=${topic}, hasSession=${!!session}`);

    // topicの形式を正規化（大文字小文字、スラッシュ/アンダースコアの違いに対応）
    const topicStr = String(topic || "").toLowerCase();
    let normalizedTopic = topicStr;
    if (topicStr === "orders_updated") {
      normalizedTopic = "orders/updated";
    } else if (topicStr.includes("_")) {
      // 最後のアンダースコアをスラッシュに変換（例: orders_updated → orders/updated）
      normalizedTopic = topicStr.replace(/_([^_]+)$/, "/$1");
    }

    if (normalizedTopic !== "orders/updated") {
      console.log(`[orders/updated] Invalid topic: ${topic} (normalized: ${normalizedTopic}), returning 400`);
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

    console.log(`[orders/updated] Order details: id=${order.id}, line_items.length=${order.line_items?.length || 0}, fulfillments.length=${order.fulfillments?.length || 0}, cancelled_at=${order.cancelled_at || "null"}`);
    
    if (!order.id || !order.line_items || order.line_items.length === 0) {
      console.log(`[orders/updated] Skipping: no order.id or no line_items. order.id=${order.id}, line_items.length=${order.line_items?.length || 0}`);
      return new Response("OK", { status: 200 }); // 注文に商品がない場合はスキップ
    }

    // セッションからadminクライアントを作成
    if (!session) {
      console.error(`[orders/updated] No session found for webhook: shop=${shop}`);
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
      console.log(`[orders/updated] Skipping cancelled order: order.id=${order.id}, cancelled_at=${order.cancelled_at}`);
      return new Response("OK", { status: 200 });
    }

    // 履行された商品の在庫変動を記録
    // オンラインストアの場合、受注時（fulfillmentsがない時）のみ記録し、
    // フルフィルメント時は記録しない（二重記録を防ぐ）
    console.log(`[orders/updated] Checking fulfillments: fulfillments.length=${order.fulfillments?.length || 0}`);
    if (order.fulfillments && order.fulfillments.length > 0) {
      // fulfillmentsがある場合は、既に受注時に記録されている可能性があるためスキップ
      // （オンラインストアでは受注時に在庫が減り、フルフィルメント時には在庫変動がない）
      // POSアプリからの売上の場合は、api/log-inventory-changeで記録されるため、ここでは記録しない
      console.log(`[orders/updated] Skipping fulfillment processing: fulfillments exist, order.id=${order.id} (online store orders are recorded at order creation time only, POS sales are recorded via api/log-inventory-change)`);
      // fulfillmentsがある場合は処理をスキップ（受注時のみ記録するため）
    } else {
      console.log(`[orders/updated] No fulfillments found: order.id=${order.id}, fulfillments=${order.fulfillments ? "exists but empty" : "null/undefined"}`);
      
      // fulfillmentsがない場合でも、注文確定時に在庫が減っている可能性があるため、
      // 直近のadmin_webhookをorder_salesに上書きする処理を追加
      if (order.line_items && order.line_items.length > 0) {
        console.log(`[orders/updated] Processing order without fulfillments: order.id=${order.id}, line_items.length=${order.line_items.length}`);
        
        // 注文の作成日時を取得（fulfillmentがない場合は注文の作成日時を使用）
        const orderCreatedAt = (payload as any).created_at 
          ? new Date((payload as any).created_at)
          : new Date();
        
        // 注文のデフォルトロケーションを取得
        let orderLocationId: string | null = null;
        try {
          const orderResp = await admin.request({
            data: `
              #graphql
              query GetOrder($id: ID!) {
                order(id: $id) {
                  id
                  fulfillmentOrders(first: 1) {
                    edges {
                      node {
                        assignedLocation {
                          location {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            `,
            variables: { id: `gid://shopify/Order/${order.id}` },
          });
          const orderData = orderResp && typeof orderResp.json === "function" ? await orderResp.json() : orderResp;
          const fulfillmentOrder = orderData?.data?.order?.fulfillmentOrders?.edges?.[0]?.node;
          if (fulfillmentOrder?.assignedLocation?.location?.id) {
            orderLocationId = fulfillmentOrder.assignedLocation.location.id;
          }
        } catch (error) {
          console.error(`[orders/updated] Failed to get order location for order ${order.id}:`, error);
        }
        
        if (!orderLocationId) {
          console.log(`[orders/updated] No location found for order ${order.id}, skipping admin_webhook update`);
        } else {
          // 各line_itemについて、直近のadmin_webhookを検索してorder_salesに上書き
          for (const lineItem of order.line_items) {
            if (!lineItem.variant_id || !lineItem.quantity || lineItem.quantity <= 0) {
              continue;
            }
            
            try {
              const variantId = `gid://shopify/ProductVariant/${lineItem.variant_id}`;
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
              
              if (!inventoryItemId) {
                continue;
              }
              
              // 直近のadmin_webhookを検索（30分前〜5分後）
              const searchFrom = new Date(orderCreatedAt.getTime() - 30 * 60 * 1000);
              const searchTo = new Date(orderCreatedAt.getTime() + 5 * 60 * 1000);
              
              const inventoryItemIdCandidates = [
                inventoryItemId,
                inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, ""),
                `gid://shopify/InventoryItem/${inventoryItemId}`,
              ].filter((id, index, arr) => arr.indexOf(id) === index);
              
              const locationIdCandidates = [
                orderLocationId,
                orderLocationId.replace(/^gid:\/\/shopify\/Location\//, ""),
                `gid://shopify/Location/${orderLocationId}`,
              ].filter((id, index, arr) => arr.indexOf(id) === index);
              
              if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
                const existingAdminLog = await (db as any).inventoryChangeLog.findFirst({
                  where: {
                    shop,
                    inventoryItemId: { in: inventoryItemIdCandidates },
                    locationId: { in: locationIdCandidates },
                    activity: "admin_webhook",
                    timestamp: { gte: searchFrom, lte: searchTo },
                  },
                  orderBy: { timestamp: "desc" },
                });
                
                if (existingAdminLog) {
                  console.log(`[orders/updated] Found admin_webhook log to update (no fulfillments): id=${existingAdminLog.id}, order.id=${order.id}`);
                  const orderId = `order_${order.id}`;
                  const idempotencyKey = `${shop}_order_sales_${inventoryItemId}_${orderLocationId}_${orderId}_${orderCreatedAt.toISOString()}`;
                  
                  // deltaを計算（quantityAfterから前のログのquantityAfterを引く）
                  let delta: number | null = null;
                  try {
                    const prevLog = await (db as any).inventoryChangeLog.findFirst({
                      where: {
                        shop,
                        inventoryItemId: { in: inventoryItemIdCandidates },
                        locationId: { in: locationIdCandidates },
                        timestamp: { lt: existingAdminLog.timestamp },
                      },
                      orderBy: { timestamp: "desc" },
                    });
                    if (prevLog?.quantityAfter !== null && existingAdminLog.quantityAfter !== null) {
                      delta = existingAdminLog.quantityAfter - prevLog.quantityAfter;
                    } else {
                      delta = -(lineItem.quantity || 0);
                    }
                  } catch (error) {
                    delta = -(lineItem.quantity || 0);
                  }
                  
                  await (db as any).inventoryChangeLog.update({
                    where: { id: existingAdminLog.id },
                    data: {
                      activity: "order_sales",
                      delta: delta !== null ? delta : existingAdminLog.delta,
                      sourceType: "order_sales",
                      sourceId: orderId,
                      idempotencyKey,
                      note: `注文: ${order.name || orderId}`,
                    },
                  });
                  console.log(`[orders/updated] Updated admin_webhook log to order_sales (no fulfillments): id=${existingAdminLog.id}`);
                }
              }
            } catch (error) {
              console.error(`[orders/updated] Error processing line_item ${lineItem.id} for order ${order.id}:`, error);
            }
          }
        }
      }
    }

    console.log(`[orders/updated] Webhook processing completed: order.id=${order.id}`);
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[orders/updated] Webhook error:", error);
    // エラーの詳細をログに出力
    if (error instanceof Error) {
      console.error("[orders/updated] Error message:", error.message);
      console.error("[orders/updated] Error stack:", error.stack);
    }
    return new Response("Internal Server Error", { status: 500 });
  }
};
