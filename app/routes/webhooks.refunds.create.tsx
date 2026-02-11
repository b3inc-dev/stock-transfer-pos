// app/routes/webhooks.refunds.create.tsx
// 返品作成Webhookハンドラー（返品時の在庫変動検知）
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import shopify from "../shopify.server";
import db from "../db.server";
import { logInventoryChange, getShopTimezoneAndDate, getLocationName, getInventoryItemInfo } from "../utils/inventory-change-log";

// APIバージョン（shopify.server.tsと同じ値を使用）
const API_VERSION = "2025-10";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, shop, topic, session } = await authenticate.webhook(request);

    if (topic !== "refunds/create") {
      return new Response("Invalid topic", { status: 400 });
    }

    // Webhookのペイロードから返品情報を取得
    const refund = payload as {
      id?: number;
      order_id?: number;
      created_at?: string;
      refund_line_items?: Array<{
        id?: number;
        line_item_id?: number;
        quantity?: number;
        restock_type?: string; // "no_restock" | "cancel" | "return" | "legacy_restock"
        location_id?: number;
      }>;
    };

    if (!refund.id || !refund.order_id || !refund.refund_line_items || refund.refund_line_items.length === 0) {
      return new Response("OK", { status: 200 }); // 返品に商品がない場合はスキップ
    }

    // セッションからadminクライアントを作成
    if (!session) {
      console.error("No session found for refund webhook");
      return new Response("No session", { status: 401 });
    }

    // adminクライアントを作成
    // shopify.clientsが存在しない場合、sessionから直接GraphQLクライアントを作成
    let admin: { request: (options: { data: string; variables?: any }) => Promise<any> };
    
    if (shopify?.clients?.Graphql) {
      admin = shopify.clients.Graphql({ session });
    } else {
      // shopify.clientsが存在しない場合、sessionから直接GraphQLクライアントを作成
      console.log(`[refunds/create] shopify.clients not available, creating GraphQL client from session`);
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

    // 返品作成日時を取得
    const refundCreatedAt = refund.created_at ? new Date(refund.created_at) : new Date();

    // タイムゾーンと日付を取得
    const { timezone, date } = await getShopTimezoneAndDate(admin, refundCreatedAt);

    // 返品された商品ごとに在庫変動を記録
    for (const refundLineItem of refund.refund_line_items) {
      // 返品で在庫に戻される場合のみ処理（restock_typeが"no_restock"の場合はスキップ）
      if (refundLineItem.restock_type === "no_restock" || !refundLineItem.location_id) {
        continue;
      }

      const locationId = `gid://shopify/Location/${refundLineItem.location_id}`;
      const quantity = refundLineItem.quantity || 0;

      if (quantity <= 0) {
        continue;
      }

      try {
        // line_item_idから注文のline_itemを取得してvariant_idを取得
        // 注: REST APIのwebhookではline_item_idが含まれているが、variant_idは含まれていないため、
        // GraphQL APIで注文を取得してvariant_idを取得する必要がある
        const orderResp = await admin.request({
          data: `
            #graphql
            query GetOrder($id: ID!) {
              order(id: $id) {
                id
                lineItems(first: 250) {
                  edges {
                    node {
                      id
                      variant {
                        id
                        sku
                        inventoryItem {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: { id: `gid://shopify/Order/${refund.order_id}` },
        });
        const orderData = orderResp && typeof orderResp.json === "function" ? await orderResp.json() : orderResp;
        const order = orderData?.data?.order;

        if (!order || !order.lineItems || !order.lineItems.edges) {
          console.warn(`Order not found or has no line items: ${refund.order_id}`);
          continue;
        }

        // line_item_idに一致するline_itemを検索
        const lineItemId = refundLineItem.line_item_id 
          ? `gid://shopify/OrderLineItem/${refundLineItem.line_item_id}`
          : null;

        const matchingLineItem = lineItemId
          ? order.lineItems.edges.find((edge: any) => edge.node.id === lineItemId)
          : null;

        if (!matchingLineItem || !matchingLineItem.node.variant) {
          console.warn(`Line item not found for refund line item: ${refundLineItem.line_item_id}`);
          continue;
        }

        const variantId = matchingLineItem.node.variant.id;
        const inventoryItemId = matchingLineItem.node.variant.inventoryItem?.id;
        const sku = matchingLineItem.node.variant.sku || "";

        if (!inventoryItemId) {
          console.warn(`InventoryItem not found for variant ${variantId}`);
          continue;
        }

        // ロケーション名を取得
        const locationName = await getLocationName(admin, locationId);

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
            (edge: any) => edge?.node?.location?.id === locationId
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
                locationId: locationId,
              },
              orderBy: {
                timestamp: "desc",
              },
            });

            const prevAvailable = prevLog?.quantityAfter ?? null;
            delta = prevAvailable !== null && quantityAfter !== null 
              ? quantityAfter - prevAvailable 
              : quantity; // 直前値が取れない場合は、返品数量をプラスとして記録
          } else {
            // dbがundefinedの場合でも、返品数量をプラスとして記録
            delta = quantity;
          }
        } catch (error) {
          console.error("Error checking previous log:", error);
          delta = quantity; // エラー時は返品数量をプラスとして記録
        }

        // 二重登録防止用キーを生成
        const refundId = `refund_${refund.id}`;
        const lineItemIdStr = refundLineItem.line_item_id ? `line_item_${refundLineItem.line_item_id}` : "";
        const idempotencyKey = `${shop}_refund_${inventoryItemId}_${locationId}_${refundId}_${lineItemIdStr}_${refundCreatedAt.toISOString()}`;

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
              console.log(`Skipping duplicate refund log: ${idempotencyKey}`);
              continue;
            }
          }
        } catch (error) {
          console.error("Error checking existing log:", error);
        }

        // 在庫変動ログを保存（date はショップタイムゾーンで統一）
        await logInventoryChange({
          shop,
          timestamp: refundCreatedAt,
          date,
          inventoryItemId: inventoryItemId,
          variantId: variantId,
          sku: sku,
          locationId: locationId,
          locationName,
          activity: "refund",
          delta,
          quantityAfter,
          sourceType: "refund",
          sourceId: `order_${refund.order_id}`,
          adjustmentGroupId: null,
          idempotencyKey,
          note: `返品: 注文 #${refund.order_id}`,
        });
      } catch (error) {
        console.error(`Error logging inventory change for refund ${refund.id}, line item ${refundLineItem.line_item_id}:`, error);
        // エラーが発生しても続行
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("refunds/create webhook error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
};
