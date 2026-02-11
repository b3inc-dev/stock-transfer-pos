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
    let payload, shop, topic, session;
    try {
      const result = await authenticate.webhook(request);
      payload = result.payload;
      shop = result.shop;
      topic = result.topic;
      session = result.session;
    } catch (authError) {
      console.error(`[refunds.create] Webhook authentication error:`, authError);
      if (authError instanceof Error) {
        console.error(`[refunds.create] Auth error message:`, authError.message);
        console.error(`[refunds.create] Auth error stack:`, authError.stack);
      }
      return new Response("Authentication failed", { status: 401 });
    }

    console.log(`[refunds.create] Webhook received: shop=${shop}, topic=${topic}, hasSession=${!!session}`);

    // topicの形式を正規化（大文字小文字、スラッシュ/アンダースコアの違いに対応）
    const topicStr = String(topic || "").toLowerCase();
    let normalizedTopic = topicStr;
    if (topicStr === "refunds_create") {
      normalizedTopic = "refunds/create";
    } else if (topicStr.includes("_")) {
      // 最後のアンダースコアをスラッシュに変換（例: refunds_create → refunds/create）
      normalizedTopic = topicStr.replace(/_([^_]+)$/, "/$1");
    }

    if (normalizedTopic !== "refunds/create") {
      console.log(`[refunds.create] Invalid topic: ${topic} (normalized: ${normalizedTopic}), returning 400`);
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
            // deltaの計算: quantityAfterが取得できている場合はそれを使用、できていない場合は返品数量を使用
            if (prevAvailable !== null && quantityAfter !== null) {
              delta = quantityAfter - prevAvailable;
            } else if (quantityAfter !== null) {
              // quantityAfterは取得できているが、直前のログがない場合
              // quantityAfterから返品数量を引いてdeltaを計算（quantityAfterは既に変動後の値なので、返品数量分をプラス）
              delta = quantity || 0;
            } else {
              // quantityAfterが取得できていない場合、返品数量をプラスとして記録
              delta = quantity || 0;
            }
            console.log(`[refunds.create] Calculated delta: quantity=${quantity}, quantityAfter=${quantityAfter}, prevAvailable=${prevAvailable}, delta=${delta}`);
          } else {
            // dbがundefinedの場合でも、返品数量をプラスとして記録
            delta = quantity || 0;
            console.log(`[refunds.create] db undefined, using quantity for delta: quantity=${quantity}, delta=${delta}`);
          }
        } catch (error) {
          console.error("Error checking previous log:", error);
          delta = quantity; // エラー時は返品数量をプラスとして記録
        }

        // 二重登録防止用キーを生成
        // refundCreatedAtは秒単位に丸めて使用（ミリ秒の違いで重複チェックが失敗するのを防ぐ）
        const refundCreatedAtRounded = new Date(Math.floor(refundCreatedAt.getTime() / 1000) * 1000);
        const refundId = `refund_${refund.id}`;
        const lineItemIdStr = refundLineItem.line_item_id ? `line_item_${refundLineItem.line_item_id}` : "";
        const idempotencyKey = `${shop}_refund_${inventoryItemId}_${locationId}_${refundId}_${lineItemIdStr}_${refundCreatedAtRounded.toISOString()}`;

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
              console.log(`[refunds/create] Skipping duplicate refund log: ${idempotencyKey}`);
              continue;
            }
          }
        } catch (error) {
          console.error("[refunds/create] Error checking existing log:", error);
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
              locationId,
              locationId.replace(/^gid:\/\/shopify\/Location\//, ""),
              `gid://shopify/Location/${locationId}`,
            ].filter((id, index, arr) => arr.indexOf(id) === index); // 重複を除去

            // 検索範囲を30分前〜5分後に拡大（inventory_levels/updateとのタイムスタンプのずれを考慮）
            const searchFrom = new Date(refundCreatedAt.getTime() - 30 * 60 * 1000); // 30分前
            const searchTo = new Date(refundCreatedAt.getTime() + 5 * 60 * 1000); // 5分後

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
                `[refunds/create] Found existing admin_webhook log to update: id=${existingAdminLog.id}, timestamp=${existingAdminLog.timestamp}, quantityAfter=${existingAdminLog.quantityAfter} -> ${quantityAfter}`
              );
              // 既存のadmin_webhookログをrefundに更新
              await (db as any).inventoryChangeLog.update({
                where: { id: existingAdminLog.id },
                data: {
                  activity: "refund",
                  delta: delta !== null ? delta : existingAdminLog.delta, // deltaが計算できている場合はそれを使用
                  quantityAfter: quantityAfter !== null ? quantityAfter : existingAdminLog.quantityAfter,
                  sourceType: "refund",
                  sourceId: `order_${refund.order_id}`,
                  idempotencyKey,
                  note: `返品: 注文 #${refund.order_id}`,
                },
              });
              console.log(`[refunds/create] Updated admin_webhook log to refund: id=${existingAdminLog.id}`);
              updatedExistingAdminLog = true;
            }
          }
        } catch (error) {
          console.error("[refunds/create] Error checking/updating existing admin_webhook log:", error);
          // エラーが発生しても続行（新規作成に進む）
        }

        // 既存のadmin_webhookログを更新した場合は新規作成をスキップ
        if (!updatedExistingAdminLog) {
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
        }
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
