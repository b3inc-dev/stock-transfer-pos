// app/routes/webhooks.refunds.create.tsx
// 返品作成Webhookハンドラー（返品時の在庫変動検知）
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { withGraphQLRetry } from "../utils/graphql-with-retry";
import shopify from "../shopify.server";
import db from "../db.server";
import { logInventoryChange } from "../utils/inventory-change-log";
import { getDateInShopTimezone } from "../utils/timezone";
import { findWithAdminWebhookRetry } from "../utils/admin-webhook-retry";
import type { AdminGraphQLRequestClient } from "../types";

// APIバージョン（shopify.server.tsと同じ値を使用）
const API_VERSION = "2026-01";

/**
 * line_item_id 検索失敗時のフォールバック: GraphQL Refund API で inventory_item_id を取得
 */
async function getInventoryItemFromRefundGraphQL(
  admin: AdminGraphQLRequestClient,
  refundId: number,
  refundLineItem: { line_item_id?: number; quantity?: number; location_id?: number; restock_type?: string }
): Promise<{ variantId: string; inventoryItemId: string; sku: string } | null> {
  try {
    const refundResp = await admin.request({
      data: `
        #graphql
        query GetRefund($id: ID!) {
          refund(id: $id) {
            id
            refundLineItems(first: 50) {
              edges {
                node {
                  lineItem {
                    variant {
                      id
                      sku
                      inventoryItem { id }
                    }
                  }
                  quantity
                  restockType
                  location { id }
                }
              }
            }
          }
        }
      `,
      variables: { id: `gid://shopify/Refund/${refundId}` },
    });
    const refundData = refundResp && typeof refundResp.json === "function" ? await refundResp.json() : refundResp;
    if (refundData?.errors?.length) {
      console.error("[refunds/create] GraphQL refund query errors:", refundData.errors);
      return null;
    }
    const refundNode = refundData?.data?.refund;
    const edges = refundNode?.refundLineItems?.edges || [];
    const items = edges.map((e: { node?: unknown }) => e?.node).filter(Boolean);
    const qty = refundLineItem.quantity ?? 1;
    const locId = refundLineItem.location_id ? `gid://shopify/Location/${refundLineItem.location_id}` : null;
    const restock = (refundLineItem.restock_type || "").toLowerCase();
    if (restock === "no_restock" || !locId) return null;
    for (const it of items) {
      if (it.restockType?.toLowerCase() === "no_restock") continue;
      const qtyMatch = (it.quantity ?? 0) === qty;
      const locMatch = it.location?.id === locId || it.location?.id === String(refundLineItem.location_id);
      if (qtyMatch && locMatch && it.lineItem?.variant?.inventoryItem?.id) {
        return {
          variantId: it.lineItem.variant.id,
          inventoryItemId: it.lineItem.variant.inventoryItem.id,
          sku: it.lineItem.variant.sku ?? "",
        };
      }
    }
    return null;
  } catch (e) {
    console.error(`[refunds/create] GraphQL Refund fallback error:`, e);
    return null;
  }
}

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
    let admin: AdminGraphQLRequestClient;

    if (shopify?.clients?.Graphql) {
      admin = shopify.clients.Graphql({ session });
    } else {
      // shopify.clientsが存在しない場合、sessionから直接GraphQLクライアントを作成
      console.log(`[refunds/create] shopify.clients not available, creating GraphQL client from session`);
      const shopDomain = session.shop;
      const accessToken = session.accessToken;
      
      // GraphQLクライアントを直接作成
      admin = {
        request: async (options: { data: string; variables?: Record<string, unknown> }) => {
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
    admin = withGraphQLRetry(admin);

    // 返品作成日時を取得
    const refundCreatedAt = refund.created_at ? new Date(refund.created_at) : new Date();

    // タイムゾーンと日付を取得（admin は .request() インターフェースのため直接取得）
    let shopTimezone = "UTC";
    try {
      const tzResp = await admin.request({ data: `#graphql query GetShopTimezone { shop { ianaTimezone } }` });
      const tzData = tzResp && typeof tzResp.json === "function" ? await tzResp.json() : tzResp;
      if (!tzData?.errors?.length) {
        shopTimezone = tzData?.data?.shop?.ianaTimezone || "UTC";
      }
    } catch { /* UTC にフォールバック */ }
    const date = getDateInShopTimezone(refundCreatedAt, shopTimezone);

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
        if (orderData?.errors?.length) {
          console.warn("[refunds/create] GraphQL order query errors:", orderData.errors);
          continue;
        }
        const order = orderData?.data?.order;

        if (!order || !order.lineItems || !order.lineItems.edges) {
          console.warn(`Order not found or has no line items: ${refund.order_id}`);
          continue;
        }

        // line_item_idに一致するline_itemを検索（複数ID形式で試す：GID・数値のみ）
        const lineItemIdCandidates = refundLineItem.line_item_id
          ? [
              `gid://shopify/OrderLineItem/${refundLineItem.line_item_id}`,
              `gid://shopify/OrderLineItem/${String(refundLineItem.line_item_id)}`,
            ]
          : [];
        const matchingLineItem = lineItemIdCandidates.length > 0
          ? order.lineItems.edges.find((edge: { node: { id?: string } }) =>
              lineItemIdCandidates.includes(edge.node.id) ||
              (edge.node.id && String(edge.node.id).endsWith(String(refundLineItem.line_item_id)))
            )
          : null;

        let variantId: string;
        let inventoryItemId: string;
        let sku: string;

        if (matchingLineItem?.node?.variant) {
          variantId = matchingLineItem.node.variant.id;
          inventoryItemId = matchingLineItem.node.variant.inventoryItem?.id;
          sku = matchingLineItem.node.variant.sku || "";
        } else {
          // フォールバック: GraphQL Refund API で inventory_item_id を取得
          const fallback = await getInventoryItemFromRefundGraphQL(admin, refund.id, refundLineItem);
          if (!fallback) {
            console.warn(`Line item not found for refund line item: ${refundLineItem.line_item_id}; GraphQL Refund fallback also failed`);
            continue;
          }
          variantId = fallback.variantId;
          inventoryItemId = fallback.inventoryItemId;
          sku = fallback.sku || "";
        }

        if (!inventoryItemId) {
          console.warn(`InventoryItem not found for variant ${variantId}`);
          continue;
        }

        const rawItemId = inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, "") || inventoryItemId;
        const rawLocId = String(refundLineItem.location_id ?? "");

        // 売上と同様: RefundPendingLocation を先に登録（inventory_levels/update が先に届いた場合のマッチ用）
        if (db) {
          try {
            await db.refundPendingLocation.upsert({
              where: {
                shop_refundId_inventoryItemId_locationId: {
                  shop,
                  refundId: String(refund.id),
                  inventoryItemId: rawItemId,
                  locationId: rawLocId,
                },
              },
              create: {
                shop,
                refundId: String(refund.id),
                orderId: String(refund.order_id),
                refundCreatedAt,
                inventoryItemId: rawItemId,
                locationId: rawLocId,
                quantity,
              },
              update: { refundCreatedAt, quantity },
            });
          } catch (e) {
            console.error(`[refunds/create] Failed to upsert RefundPendingLocation:`, e);
          }
        }

        // ロケーション名を取得（admin は .request() インターフェースのため直接取得）
        let locationName = locationId;
        try {
          const locResp = await admin.request({
            data: `#graphql query GetLocation($id: ID!) { location(id: $id) { id name } }`,
            variables: { id: locationId },
          });
          const locData = locResp && typeof locResp.json === "function" ? await locResp.json() : locResp;
          if (!locData?.errors?.length) {
            locationName = locData?.data?.location?.name || locationId;
          }
        } catch { /* locationId をフォールバックとして使用 */ }

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
          if (levelData?.errors?.length) {
            console.warn("[refunds/create] GraphQL inventoryLevels errors:", levelData.errors);
          }
          const levels = levelData?.data?.inventoryItem?.inventoryLevels?.edges || [];
          const locIdAlt = locationId.startsWith("gid://") ? locationId.replace(/^gid:\/\/shopify\/Location\//, "") : `gid://shopify/Location/${locationId}`;
          const matchingLevel = levels.find(
            (edge: { node?: { location?: { id?: string }; quantities?: Array<{ quantity?: number }> } }) => {
              const id = edge?.node?.location?.id;
              return id === locationId || id === locIdAlt;
            }
          );
          if (matchingLevel?.node?.quantities?.[0]) {
            quantityAfter = matchingLevel.node.quantities[0].quantity;
          }
        } catch (error) {
          console.error("Failed to get inventory level:", error);
        }

        // 直前の在庫値を取得（delta計算用）。inventory_levels/update は数値IDで保存するため、GID/数値両形式を候補にする。
        // 時間範囲を最近30日に限定: 長期間変動がないアイテムで古いログを「直前」として扱い、
        // 誤ったdeltaが計算されることを防ぐ。
        let delta: number | null = null;
        try {
          if (db) {
            const prevItemCandidates = [inventoryItemId, rawItemId, `gid://shopify/InventoryItem/${rawItemId}`].filter((id, i, arr) => arr.indexOf(id) === i);
            const prevLocCandidates = [locationId, rawLocId, rawLocId ? `gid://shopify/Location/${rawLocId}` : null].filter(Boolean);
            const thirtyDaysAgo = new Date(refundCreatedAt.getTime() - 30 * 24 * 60 * 60 * 1000);
            const prevLog = await db.inventoryChangeLog.findFirst({
              where: {
                shop,
                inventoryItemId: { in: prevItemCandidates },
                locationId: { in: prevLocCandidates },
                timestamp: { gte: thirtyDaysAgo, lte: refundCreatedAt },
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
          if (db) {
            const existingLog = await db.inventoryChangeLog.findUnique({
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
          if (db) {
            // inventoryItemIdとlocationIdの候補を準備（GID形式と数値形式の両方を考慮）
            // 二重GIDを防ぐため、先に生IDを取り出してからGID形式を構築する
            const rawItemIdForCand = inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, "");
            const inventoryItemIdCandidates = [rawItemIdForCand, `gid://shopify/InventoryItem/${rawItemIdForCand}`]
              .filter((id, index, arr) => arr.indexOf(id) === index);

            const rawLocIdForCand = locationId.replace(/^gid:\/\/shopify\/Location\//, "");
            const locationIdCandidates = [rawLocIdForCand, `gid://shopify/Location/${rawLocIdForCand}`]
              .filter((id, index, arr) => arr.indexOf(id) === index);

            // 検索範囲: 30分前〜「返品作成+5分」と「現在+2分」の遅い方（inventory_levels/update が先に届いた場合を拾う）
            const searchFrom = new Date(refundCreatedAt.getTime() - 30 * 60 * 1000); // 30分前
            const searchTo = new Date(Math.max(refundCreatedAt.getTime() + 5 * 60 * 1000, Date.now() + 2 * 60 * 1000)); // 5分後 または 現在+2分

            const existingAdminLog = await findWithAdminWebhookRetry(
              () =>
                db.inventoryChangeLog.findFirst({
                  where: {
                    shop,
                    inventoryItemId: { in: inventoryItemIdCandidates },
                    locationId: { in: locationIdCandidates },
                    activity: "admin_webhook",
                    timestamp: { gte: searchFrom, lte: searchTo },
                  },
                  orderBy: { timestamp: "desc" },
                }),
              "[refunds/create]"
            );

            if (existingAdminLog) {
              console.log(
                `[refunds/create] Found existing admin_webhook log to update: id=${existingAdminLog.id}, timestamp=${existingAdminLog.timestamp}, quantityAfter=${existingAdminLog.quantityAfter} -> ${quantityAfter}`
              );
              // 既存のadmin_webhookログをrefundに更新（救済時は idempotencyKey を変更しない＝P2002 防止）
              await db.inventoryChangeLog.update({
                where: { id: existingAdminLog.id },
                data: {
                  activity: "refund",
                  delta: delta !== null ? delta : existingAdminLog.delta, // deltaが計算できている場合はそれを使用
                  quantityAfter: quantityAfter !== null ? quantityAfter : existingAdminLog.quantityAfter,
                  sourceType: "refund",
                  sourceId: `order_${refund.order_id}`,
                  note: `返品: 注文 #${refund.order_id}`,
                },
              });
              console.log(`[refunds/create] Updated admin_webhook log to refund: id=${existingAdminLog.id}`);
              updatedExistingAdminLog = true;
              if (db) {
                await db.refundPendingLocation.deleteMany({
                  where: { shop, refundId: String(refund.id), inventoryItemId: rawItemId, locationId: rawLocId },
                });
              }
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
          if (db) {
            await db.refundPendingLocation.deleteMany({
              where: { shop, refundId: String(refund.id), inventoryItemId: rawItemId, locationId: rawLocId },
            });
          }
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
