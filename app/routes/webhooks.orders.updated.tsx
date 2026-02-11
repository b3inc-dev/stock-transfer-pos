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
    console.log(`[orders/updated] Checking fulfillments: fulfillments.length=${order.fulfillments?.length || 0}`);
    if (order.fulfillments && order.fulfillments.length > 0) {
      for (const fulfillment of order.fulfillments) {
        console.log(`[orders/updated] Processing fulfillment: id=${fulfillment.id}, status=${fulfillment.status}, location_id=${fulfillment.location_id}, line_items.length=${fulfillment.line_items?.length || 0}`);
        // 履行が完了している場合のみ処理
        if (fulfillment.status !== "success" && fulfillment.status !== "open") {
          console.log(`[orders/updated] Skipping fulfillment: status=${fulfillment.status} (not success or open)`);
          continue;
        }

        // fulfillment.location_idがnullの場合、注文のデフォルトロケーションを取得
        let fulfillmentLocationId: string | null = null;
        if (fulfillment.location_id) {
          fulfillmentLocationId = `gid://shopify/Location/${fulfillment.location_id}`;
        } else {
          // location_idがnullの場合、注文のデフォルトロケーションを取得
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
              fulfillmentLocationId = fulfillmentOrder.assignedLocation.location.id;
            }
          } catch (error) {
            console.error(`[orders.updated] Failed to get order location for order ${order.id}:`, error);
          }
        }

        if (!fulfillmentLocationId || !fulfillment.line_items || fulfillment.line_items.length === 0) {
          console.log(`[orders.updated] Skipping fulfillment: locationId=${fulfillmentLocationId}, hasLineItems=${!!fulfillment.line_items && fulfillment.line_items.length > 0}`);
          continue;
        }

        const fulfillmentCreatedAt = fulfillment.created_at 
          ? new Date(fulfillment.created_at)
          : new Date();

        // 履行された商品ごとに在庫変動を記録
        console.log(`[orders/updated] Processing fulfillment.line_items: fulfillment.id=${fulfillment.id}, line_items.length=${fulfillment.line_items?.length || 0}`);
        for (const fulfillmentLineItem of fulfillment.line_items) {
          console.log(`[orders/updated] Processing fulfillmentLineItem: id=${fulfillmentLineItem.id}, quantity=${fulfillmentLineItem.quantity}`);
          // 注文のline_itemsから該当する商品を検索
          const orderLineItem = order.line_items.find(
            (item) => item.id === fulfillmentLineItem.id
          );

          if (!orderLineItem || !orderLineItem.variant_id) {
            console.log(`[orders/updated] Skipping fulfillmentLineItem: orderLineItem=${!!orderLineItem}, variant_id=${orderLineItem?.variant_id || "null"}, fulfillmentLineItem.id=${fulfillmentLineItem.id}`);
            continue;
          }
          console.log(`[orders/updated] Found orderLineItem: id=${orderLineItem.id}, variant_id=${orderLineItem.variant_id}`);

          const variantId = `gid://shopify/ProductVariant/${orderLineItem.variant_id}`;
          const quantity = fulfillmentLineItem.quantity || 0;

          console.log(`[orders/updated] Processing variant: variantId=${variantId}, quantity=${quantity}`);
          if (quantity <= 0) {
            console.log(`[orders/updated] Skipping fulfillmentLineItem: quantity=${quantity} <= 0`);
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

            console.log(`[orders/updated] Variant query result: variant=${!!variant}, inventoryItemId=${inventoryItemId || "null"}, sku=${sku}`);
            if (!inventoryItemId) {
              console.warn(`[orders/updated] InventoryItem not found for variant ${variantId}, skipping`);
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
                // deltaの計算: quantityAfterが取得できている場合はそれを使用、できていない場合は履行数量を使用
                if (prevAvailable !== null && quantityAfter !== null) {
                  delta = quantityAfter - prevAvailable;
                } else if (quantityAfter !== null) {
                  // quantityAfterは取得できているが、直前のログがない場合
                  // quantityAfterから履行数量を引いてdeltaを計算（quantityAfterは既に変動後の値なので、履行数量分をマイナス）
                  delta = -(quantity || 0);
                } else {
                  // quantityAfterが取得できていない場合、履行数量をマイナスとして記録
                  delta = -(quantity || 0);
                }
                console.log(`[orders.updated] Calculated delta: quantity=${quantity}, quantityAfter=${quantityAfter}, prevAvailable=${prevAvailable}, delta=${delta}`);
              } else {
                // dbがundefinedの場合でも、履行数量をマイナスとして記録
                delta = -(quantity || 0);
                console.log(`[orders.updated] db undefined, using quantity for delta: quantity=${quantity}, delta=${delta}`);
              }
            } catch (error) {
              console.error("Error checking previous log:", error);
              delta = -quantity; // エラー時は履行数量をマイナスとして記録
            }

            // 二重登録防止用キーを生成
            // fulfillmentCreatedAtは秒単位に丸めて使用（ミリ秒の違いで重複チェックが失敗するのを防ぐ）
            const fulfillmentCreatedAtRounded = new Date(Math.floor(fulfillmentCreatedAt.getTime() / 1000) * 1000);
            const orderId = `order_${order.id}`;
            const fulfillmentId = fulfillment.id ? `fulfillment_${fulfillment.id}` : "";
            const lineItemId = fulfillmentLineItem.id ? `line_item_${fulfillmentLineItem.id}` : "";
            const idempotencyKey = `${shop}_order_sales_${inventoryItemId}_${fulfillmentLocationId}_${orderId}_${fulfillmentId}_${lineItemId}_${fulfillmentCreatedAtRounded.toISOString()}`;

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
                  console.log(`[orders/updated] Skipping duplicate order fulfillment log: ${idempotencyKey}`);
                  continue;
                }
              }
            } catch (error) {
              console.error("[orders/updated] Error checking existing log:", error);
            }

            // 既存のadmin_webhookログを検索して更新（inventory_levels/updateが先に来た場合の二重登録を防ぐ）
            let updatedExistingAdminLog = false;
            try {
              if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
                // inventoryItemIdとlocationIdの候補を準備（GID形式と数値形式の両方を考慮）
                const inventoryItemIdCandidates = [
                  inventoryItemId,
                  inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, ""),
                  `gid://shopify/InventoryItem/${inventoryItemId}`,
                ].filter((id, index, arr) => arr.indexOf(id) === index); // 重複を除去

                const locationIdCandidates = [
                  fulfillmentLocationId,
                  fulfillmentLocationId.replace(/^gid:\/\/shopify\/Location\//, ""),
                  `gid://shopify/Location/${fulfillmentLocationId}`,
                ].filter((id, index, arr) => arr.indexOf(id) === index); // 重複を除去

                // 検索範囲を30分前〜5分後に拡大（inventory_levels/updateとのタイムスタンプのずれを考慮）
                const searchFrom = new Date(fulfillmentCreatedAt.getTime() - 30 * 60 * 1000); // 30分前
                const searchTo = new Date(fulfillmentCreatedAt.getTime() + 5 * 60 * 1000); // 5分後

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
                  console.log(
                    `[orders/updated] Found existing admin_webhook log to update: id=${existingAdminLog.id}, timestamp=${existingAdminLog.timestamp}, quantityAfter=${existingAdminLog.quantityAfter} -> ${quantityAfter}`
                  );
                  // 既存のadmin_webhookログをorder_salesに更新
                  await (db as any).inventoryChangeLog.update({
                    where: { id: existingAdminLog.id },
                    data: {
                      activity: "order_sales",
                      delta: delta !== null ? delta : existingAdminLog.delta, // deltaが計算できている場合はそれを使用
                      quantityAfter: quantityAfter !== null ? quantityAfter : existingAdminLog.quantityAfter,
                      sourceType: "order_sales",
                      sourceId: orderId,
                      idempotencyKey,
                      note: `注文: ${order.name || orderId}`,
                    },
                  });
                  console.log(`[orders/updated] Updated admin_webhook log to order_sales: id=${existingAdminLog.id}`);
                  updatedExistingAdminLog = true;
                }
              }
            } catch (error) {
              console.error("[orders/updated] Error checking/updating existing admin_webhook log:", error);
              // エラーが発生しても続行（新規作成に進む）
            }

            // 既存のadmin_webhookログを更新した場合は新規作成をスキップ
            if (!updatedExistingAdminLog) {
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
            }
          } catch (error) {
            console.error(`Error logging inventory change for order ${order.id}, fulfillment ${fulfillment.id}:`, error);
            // エラーが発生しても続行
          }
        }
      }
    } else {
      console.log(`[orders/updated] No fulfillments found: order.id=${order.id}, fulfillments=${order.fulfillments ? "exists but empty" : "null/undefined"}`);
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
