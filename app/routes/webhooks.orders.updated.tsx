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
    // REST Webhookでは line_items に quantity が含まれない場合があるため current_quantity も参照する
    const order = payload as {
      id?: number;
      name?: string;
      line_items?: Array<{
        id?: number;
        variant_id?: number;
        sku?: string;
        quantity?: number;
        current_quantity?: number;
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

    // 注文がキャンセルされている場合: 在庫戻りを「キャンセル戻り」として確実に記録する
    if (order.cancelled_at) {
      console.log(`[orders/updated] Processing cancelled order (inventory restore): order.id=${order.id}, cancelled_at=${order.cancelled_at}`);
      const cancelledAt = new Date(order.cancelled_at);
      let orderLocationId: string | null = null;
      const locationIdRawFromFulfillment = order.fulfillments?.[0]?.location_id != null
        ? String(order.fulfillments[0].location_id)
        : null;
      if (locationIdRawFromFulfillment) {
        orderLocationId = locationIdRawFromFulfillment.startsWith("gid://")
          ? locationIdRawFromFulfillment
          : `gid://shopify/Location/${locationIdRawFromFulfillment}`;
      }
      if (!orderLocationId) {
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
          const fo = orderData?.data?.order?.fulfillmentOrders?.edges?.[0]?.node;
          if (fo?.assignedLocation?.location?.id) {
            orderLocationId = fo.assignedLocation.location.id;
          }
        } catch (e) {
          console.error(`[orders/updated] Failed to get location for cancelled order ${order.id}:`, e);
        }
      }
      const locationIdRaw = orderLocationId?.replace(/^gid:\/\/shopify\/Location\//, "") ?? orderLocationId;
      if (orderLocationId && order.line_items && order.line_items.length > 0 && db && typeof (db as any).inventoryChangeLog !== "undefined") {
        const { date: cancelDate } = await getShopTimezoneAndDate(admin, cancelledAt);
        const locationName = await getLocationName(admin, orderLocationId);
        for (const lineItem of order.line_items) {
          const lineItemQty = lineItem.quantity ?? lineItem.current_quantity ?? 1;
          if (!lineItem.variant_id || lineItemQty <= 0) continue;
          try {
            const variantId = `gid://shopify/ProductVariant/${lineItem.variant_id}`;
            const variantResp = await admin.request({
              data: `
                #graphql
                query GetVariant($id: ID!) {
                  productVariant(id: $id) { id sku inventoryItem { id } }
                }
              `,
              variables: { id: variantId },
            });
            const variantData = variantResp && typeof variantResp.json === "function" ? await variantResp.json() : variantResp;
            const variant = variantData?.data?.productVariant;
            const inventoryItemId = variant?.inventoryItem?.id;
            const sku = variant?.sku ?? "";
            if (!inventoryItemId) continue;
            const rawItemId = inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, "") || inventoryItemId;
            const idempotencyKey = `${shop}_order_cancel_${order.id}_${rawItemId}_${locationIdRaw ?? orderLocationId}`;
            const existing = await (db as any).inventoryChangeLog.findFirst({
              where: { shop, idempotencyKey },
            });
            if (existing) {
              console.log(`[orders/updated] Skipping duplicate order_cancel: order.id=${order.id}, item=${rawItemId}`);
              continue;
            }
            // inventory_levels/update が先に届いて admin_webhook で保存されている場合は、その行を order_cancel に更新して二重を防ぐ
            const cancelSearchFrom = new Date(cancelledAt.getTime() - 30 * 60 * 1000);
            const cancelSearchTo = new Date(cancelledAt.getTime() + 5 * 60 * 1000);
            const itemIdCandidates = [inventoryItemId, rawItemId, `gid://shopify/InventoryItem/${rawItemId}`];
            const locIdCandidates = [orderLocationId, locationIdRaw, `gid://shopify/Location/${locationIdRaw}`].filter(Boolean);
            const existingAdminForCancel = await (db as any).inventoryChangeLog.findFirst({
              where: {
                shop,
                inventoryItemId: { in: itemIdCandidates },
                locationId: { in: locIdCandidates },
                activity: "admin_webhook",
                timestamp: { gte: cancelSearchFrom, lte: cancelSearchTo },
              },
              orderBy: { timestamp: "desc" },
            });
            if (existingAdminForCancel) {
              const orderIdRef = `order_${order.id}`;
              const delta = lineItemQty;
              // quantityAfter は inventory_levels/update で既に「戻り後」が入っているのでそのまま
              await (db as any).inventoryChangeLog.update({
                where: { id: existingAdminForCancel.id },
                data: {
                  activity: "order_cancel",
                  sourceType: "order_cancel",
                  sourceId: orderIdRef,
                  delta,
                  idempotencyKey,
                  note: `注文キャンセル: #${order.id}`,
                },
              });
              console.log(`[orders/updated] Updated admin_webhook to order_cancel (avoid duplicate): id=${existingAdminForCancel.id}, order.id=${order.id}, item=${rawItemId}`);
              continue;
            }
            const orderIdRef = `order_${order.id}`;
            const delta = lineItemQty; // 在庫戻りは正の数
            const success = await logInventoryChange({
              shop,
              timestamp: cancelledAt,
              inventoryItemId,
              variantId,
              sku,
              locationId: orderLocationId,
              locationName,
              activity: "order_cancel",
              delta,
              quantityAfter: null, // 直前ログからは算出可能だが、確実性のため null 許容
              sourceType: "order_cancel",
              sourceId: orderIdRef,
              idempotencyKey,
              date: cancelDate,
              note: `注文キャンセル: #${order.id}`,
            });
            if (success) {
              console.log(`[orders/updated] Recorded order_cancel: order.id=${order.id}, item=${rawItemId}, delta=+${lineItemQty}`);
            }
          } catch (err) {
            console.error(`[orders/updated] Error recording order_cancel for order ${order.id} line_item ${lineItem.id}:`, err);
          }
        }
      } else if (!orderLocationId) {
        console.log(`[orders/updated] Cancelled order has no location; skipping inventory restore log: order.id=${order.id}`);
      }
      return new Response("OK", { status: 200 });
    }

    // 履行された商品の在庫変動を記録
    // オンライン：受注時(fulfillments=0)と配送完了時(fulfillments>0)の2段階で在庫変動が起きうる。
    // POS：売上時に即履行のため fulfillments>0 で届くことが多い。
    // 変動数はオーダー情報(line_items)を正とするため、fulfillments ありのときも
    // 直近の admin_webhook を order_sales に救済する（delta = -line_item.quantity）。
    console.log(`[orders/updated] Checking fulfillments: fulfillments.length=${order.fulfillments?.length || 0}`);
    if (order.fulfillments && order.fulfillments.length > 0) {
      // 受注時を優先：この注文で order_sales が1件でも既にあれば配送完了時の救済は行わない（オンラインは別日に配送完了になるため）
      const orderIdRef = `order_${order.id}`;
      const orderCreatedAt = (payload as any).created_at
        ? new Date((payload as any).created_at)
        : new Date();
      const searchFrom = new Date(orderCreatedAt.getTime() - 30 * 60 * 1000);
      const searchTo = new Date(Math.max(orderCreatedAt.getTime() + 5 * 60 * 1000, Date.now() + 2 * 60 * 1000));
      let alreadyRecordedAtOrder: { id: number } | null = null;
      if (db && typeof (db as any).inventoryChangeLog !== "undefined") {
        alreadyRecordedAtOrder = await (db as any).inventoryChangeLog.findFirst({
          where: {
            shop,
            activity: "order_sales",
            sourceId: orderIdRef,
            timestamp: { gte: searchFrom, lte: searchTo },
          },
        });
        if (alreadyRecordedAtOrder) {
          console.log(`[orders/updated] Skipping fulfillment remediation: order_sales already exists for order.id=${order.id} (recorded at 受注時)`);
        }
      }

      if (!alreadyRecordedAtOrder) {
        // fulfillments あり：救済のみ行う（注文の line_items で admin_webhook を order_sales に更新）
        const fulfillmentLocationId = order.fulfillments[0]?.location_id != null
          ? String(order.fulfillments[0].location_id)
          : null;
        const locationIdRaw = fulfillmentLocationId;
        const locationIdGid = fulfillmentLocationId?.startsWith("gid://")
          ? fulfillmentLocationId
          : fulfillmentLocationId
            ? `gid://shopify/Location/${fulfillmentLocationId}`
            : null;

        if (locationIdRaw && order.line_items && order.line_items.length > 0 && db && typeof (db as any).inventoryChangeLog !== "undefined") {
          for (const lineItem of order.line_items) {
            const lineItemQty = lineItem.quantity ?? lineItem.current_quantity ?? 1;
            if (!lineItem.variant_id || lineItemQty <= 0) continue;
            try {
            const variantId = `gid://shopify/ProductVariant/${lineItem.variant_id}`;
            const variantResp = await admin.request({
              data: `
                #graphql
                query GetVariant($id: ID!) {
                  productVariant(id: $id) { id inventoryItem { id } }
                }
              `,
              variables: { id: variantId },
            });
            const variantData = variantResp && typeof variantResp.json === "function" ? await variantResp.json() : variantResp;
            const inventoryItemId = variantData?.data?.productVariant?.inventoryItem?.id;
            if (!inventoryItemId) continue;
            const rawItemId = inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, "") || inventoryItemId;
            const itemIdCandidates = [
              inventoryItemId,
              rawItemId,
              `gid://shopify/InventoryItem/${rawItemId}`,
            ].filter((id, i, arr) => arr.indexOf(id) === i);
            const locationIdCandidates = [
              locationIdRaw,
              locationIdGid,
              locationIdRaw?.startsWith("gid://") ? locationIdRaw : null,
            ].filter(Boolean) as string[];

            // 既にこの order で order_sales が記録されていればスキップ（二重救済防止）
            const existingOrderSales = await (db as any).inventoryChangeLog.findFirst({
              where: {
                shop,
                inventoryItemId: { in: itemIdCandidates },
                locationId: { in: locationIdCandidates },
                activity: "order_sales",
                sourceId: orderIdRef,
                timestamp: { gte: searchFrom, lte: searchTo },
              },
            });
            if (existingOrderSales) continue;

            // 時間窓内で最も古い admin_webhook を1件だけ order_sales に更新（販売可能・手持ちの2回更新のうち1件だけ救済）
            const adminWebhookToUpdate = await (db as any).inventoryChangeLog.findFirst({
              where: {
                shop,
                inventoryItemId: { in: itemIdCandidates },
                locationId: { in: locationIdCandidates },
                activity: "admin_webhook",
                timestamp: { gte: searchFrom, lte: searchTo },
              },
              orderBy: { timestamp: "asc" },
            });

            if (adminWebhookToUpdate) {
              const orderDelta = -lineItemQty;
              const idempotencyKey = `${shop}_order_sales_${rawItemId}_${locationIdRaw}_${orderIdRef}_${orderCreatedAt.toISOString()}`;
              await (db as any).inventoryChangeLog.update({
                where: { id: adminWebhookToUpdate.id },
                data: {
                  activity: "order_sales",
                  delta: orderDelta,
                  sourceType: "order_sales",
                  sourceId: orderIdRef,
                  idempotencyKey,
                  note: `注文: #${order.id}`,
                },
              });
              console.log(`[orders/updated] Remediated admin_webhook to order_sales (fulfillments exist): id=${adminWebhookToUpdate.id}, order.id=${order.id}, delta=${orderDelta}`);
            } else if (db && typeof (db as any).orderPendingLocation !== "undefined") {
              // POS等で orders/updated が inventory_levels/update より先に届いた場合：admin_webhook がまだ無いので OrderPendingLocation に登録し、後から届く inventory_levels/update で order_sales にマッチさせる
              await (db as any).orderPendingLocation.upsert({
                where: {
                  shop_orderId_inventoryItemId: { shop, orderId: String(order.id), inventoryItemId: rawItemId },
                },
                create: {
                  shop,
                  orderId: String(order.id),
                  orderCreatedAt: orderCreatedAt,
                  inventoryItemId: rawItemId,
                  quantity: lineItemQty,
                },
                update: { orderCreatedAt: orderCreatedAt, quantity: lineItemQty },
              });
              console.log(`[orders/updated] OrderPendingLocation upserted: orderId=${order.id}, inventoryItemId=${rawItemId}, quantity=${lineItemQty}`);
            }
            } catch (err) {
              console.error(`[orders/updated] Error remediating line_item for order ${order.id}:`, err);
            }
          }
        }
      }
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
        // 救済の時間窓は「注文の更新日時」基準にする（注文編集は作成から時間が経っていても、編集直後の admin_webhook を拾うため）
        const orderUpdatedAt = (payload as any).updated_at
          ? new Date((payload as any).updated_at)
          : new Date();
        const searchFrom = new Date(orderUpdatedAt.getTime() - 30 * 60 * 1000);
        const searchTo = new Date(orderUpdatedAt.getTime() + 5 * 60 * 1000);
        
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

        // 到着順に依存しないよう、受注時は常に OrderPendingLocation を登録する（後から届く inventory_levels/update がマッチできる）
        if (db && typeof (db as any).orderPendingLocation !== "undefined") {
          for (const lineItem of order.line_items) {
            const lineItemQty = lineItem.quantity ?? lineItem.current_quantity ?? 1;
            if (!lineItem.variant_id || lineItemQty <= 0) continue;
            try {
              const variantId = `gid://shopify/ProductVariant/${lineItem.variant_id}`;
              const variantResp = await admin.request({
                data: `
                  #graphql
                  query GetVariant($id: ID!) {
                    productVariant(id: $id) { id inventoryItem { id } }
                  }
                `,
                variables: { id: variantId },
              });
              const variantData = variantResp && typeof variantResp.json === "function" ? await variantResp.json() : variantResp;
              const inventoryItemId = variantData?.data?.productVariant?.inventoryItem?.id;
              if (!inventoryItemId) continue;
              const rawItemId = inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, "") || inventoryItemId;
              await (db as any).orderPendingLocation.upsert({
                where: {
                  shop_orderId_inventoryItemId: { shop, orderId: String(order.id), inventoryItemId: rawItemId },
                },
                create: {
                  shop,
                  orderId: String(order.id),
                  orderCreatedAt: orderCreatedAt,
                  inventoryItemId: rawItemId,
                  quantity: lineItemQty,
                },
                update: { orderCreatedAt: orderCreatedAt, quantity: lineItemQty },
              });
            } catch (e) {
              console.error(`[orders/updated] Failed to save OrderPendingLocation for line_item ${lineItem.id}:`, e);
            }
          }
        }

        if (!orderLocationId) {
          // 受注直後は FulfillmentOrder.assignedLocation が null になりロケーションが取れない。OrderPendingLocation は上で登録済み。
          // ロケーション不明のときは admin_webhook 救済をスキップする（item のみで検索すると他ロケーションの行を誤って order_sales に更新するリスクがあるため）。
          // 後から届く inventory_levels/update が OrderPendingLocation とマッチして order_sales で記録する。
          console.log(`[orders/updated] No location found for order ${order.id}; OrderPendingLocation recorded, remediation skipped to avoid wrong-location update`);
        } else {
          // 各line_itemについて、直近のadmin_webhookを検索してorder_salesに上書き
          for (const lineItem of order.line_items) {
            const lineItemQty = lineItem.quantity ?? lineItem.current_quantity ?? 1;
            if (!lineItem.variant_id || lineItemQty <= 0) {
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
              
              // 直近のadmin_webhookを検索（注文更新日時を基準に30分前〜5分後。注文編集で作成が古くても編集直後の行を拾う）
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
                  // 売上はオーダー数量を変動数に反映（-数量）。履歴に売上点数を表示するため
                  const orderDelta = -lineItemQty;
                  const rawItemIdForPending = inventoryItemId.replace(/^gid:\/\/shopify\/InventoryItem\//, "") || inventoryItemId;

                  await (db as any).inventoryChangeLog.update({
                    where: { id: existingAdminLog.id },
                    data: {
                      activity: "order_sales",
                      delta: orderDelta,
                      sourceType: "order_sales",
                      sourceId: orderId,
                      idempotencyKey,
                      note: `注文: ${order.name || orderId}`,
                    },
                  });
                  console.log(`[orders/updated] Updated admin_webhook log to order_sales (no fulfillments): id=${existingAdminLog.id}`);
                  // 救済したため OrderPendingLocation を削除し、後の inventory_levels/update で二重記録にならないようにする
                  if (typeof (db as any).orderPendingLocation !== "undefined") {
                    await (db as any).orderPendingLocation.deleteMany({
                      where: { shop, orderId: String(order.id), inventoryItemId: rawItemIdForPending },
                    });
                  }
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
