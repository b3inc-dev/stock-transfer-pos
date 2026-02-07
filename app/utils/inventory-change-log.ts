// app/utils/inventory-change-log.ts
// 在庫変動履歴を記録する共通ユーティリティ関数

import db from "../db.server";
import { getDateInShopTimezone } from "./timezone";
export type InventoryChangeLogData = {
  shop: string;
  timestamp: Date;
  inventoryItemId: string;
  variantId?: string | null;
  sku: string;
  locationId: string;
  locationName: string;
  activity: "inbound_transfer" | "outbound_transfer" | "loss_entry" | "inventory_count" | "purchase_entry" | "purchase_cancel" | "order_sales" | "refund" | "admin_webhook";
  delta: number | null; // 変動量（+/-、nullの場合は直前値が取れなかった）
  quantityAfter: number | null; // 変動後数量（取れない場合はnull）
  sourceType: string; // 変動の原因種別（activityと同じ値）
  sourceId?: string | null; // 参照元ID（Transfer ID、loss_...、count_...、purchase_...、order_...等）
  adjustmentGroupId?: string | null; // InventoryAdjustmentGroup ID（取れる場合）
  idempotencyKey: string; // 二重登録防止用キー
  note?: string | null; // 備考（アプリ実行分で取れる場合のみ）
};

/**
 * ProductVariantからInventoryItem IDとSKUを取得する
 * @param admin Shopify Admin APIクライアント
 * @param variantId ProductVariant ID（GID形式）
 * @returns InventoryItem ID、SKU、variantIdのタプル
 */
export async function getVariantInfo(
  admin: { request: (options: { data: string; variables?: any }) => Promise<any> },
  variantId: string
): Promise<{ inventoryItemId: string | null; sku: string; variantId: string }> {
  try {
    const resp = await admin.request({
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
    // shopify.clients.GraphqlのrequestメソッドはJSONを直接返す
    const data = resp && typeof resp.json === "function" ? await resp.json() : resp;
    const variant = data?.data?.productVariant;
    return {
      inventoryItemId: variant?.inventoryItem?.id || null,
      sku: variant?.sku || "",
      variantId: variant?.id || variantId,
    };
  } catch (error) {
    console.error("Failed to get variant info:", error);
    return { inventoryItemId: null, sku: "", variantId };
  }
}

/**
 * 在庫変動履歴を記録する共通関数
 * @param data 在庫変動履歴のデータ
 * @returns 成功した場合true、失敗した場合false
 */
export async function logInventoryChange(data: InventoryChangeLogData): Promise<boolean> {
  try {
    if (!db || typeof (db as any).inventoryChangeLog === "undefined") {
      console.warn("[logInventoryChange] InventoryChangeLog model not found in Prisma client. Please restart the dev server.");
      return false;
    }

    // タイムゾーンを取得して日付を計算（adminが必要な場合は呼び出し元で取得済みのはず）
    // ここではとりあえずUTCで計算（後で修正する可能性がある）
    const date = getDateInShopTimezone(data.timestamp, "UTC");
    
    console.log(`[logInventoryChange] Saving log: shop=${data.shop}, activity=${data.activity}, item=${data.inventoryItemId}, location=${data.locationId}, delta=${data.delta}, date=${date}`);

    await (db as any).inventoryChangeLog.create({
      data: {
        shop: data.shop,
        timestamp: data.timestamp,
        date,
        inventoryItemId: data.inventoryItemId,
        variantId: data.variantId,
        sku: data.sku,
        locationId: data.locationId,
        locationName: data.locationName,
        activity: data.activity,
        delta: data.delta,
        quantityAfter: data.quantityAfter,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        adjustmentGroupId: data.adjustmentGroupId,
        idempotencyKey: data.idempotencyKey,
        note: data.note,
      },
    });

    console.log(`[logInventoryChange] Log saved successfully`);
    return true;
  } catch (error) {
    console.error("[logInventoryChange] Error logging inventory change:", error);
    return false;
  }
}

/**
 * ショップのタイムゾーンを取得して日付を計算する
 * @param admin Shopify Admin APIクライアント
 * @param timestamp タイムスタンプ
 * @returns タイムゾーンと日付のタプル
 */
export async function getShopTimezoneAndDate(
  admin: { request: (options: { data: string; variables?: any }) => Promise<any> },
  timestamp: Date
): Promise<{ timezone: string; date: string }> {
  try {
    const resp = await admin.request({
      data: `
        #graphql
        query GetShopTimezone {
          shop {
            ianaTimezone
          }
        }
      `,
    });
    // shopify.clients.GraphqlのrequestメソッドはJSONを直接返す
    const data = resp && typeof resp.json === "function" ? await resp.json() : resp;
    const timezone = data?.data?.shop?.ianaTimezone || "UTC";
    const date = getDateInShopTimezone(timestamp, timezone);
    return { timezone, date };
  } catch (error) {
    console.error("Failed to get shop timezone:", error);
    return { timezone: "UTC", date: getDateInShopTimezone(timestamp, "UTC") };
  }
}

/**
 * InventoryItemからSKUとvariantIdを取得する
 * @param admin Shopify Admin APIクライアント
 * @param inventoryItemId InventoryItem ID（GID形式）
 * @returns SKUとvariantIdのタプル
 */
export async function getInventoryItemInfo(
  admin: { request: (options: { data: string; variables?: any }) => Promise<any> },
  inventoryItemId: string
): Promise<{ sku: string; variantId: string | null }> {
  try {
    const resp = await admin.request({
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
    // shopify.clients.GraphqlのrequestメソッドはJSONを直接返す
    const data = resp && typeof resp.json === "function" ? await resp.json() : resp;
    const variant = data?.data?.inventoryItem?.variant;
    return {
      sku: variant?.sku || "",
      variantId: variant?.id || null,
    };
  } catch (error) {
    console.error("Failed to get inventory item info:", error);
    return { sku: "", variantId: null };
  }
}

/**
 * Locationからロケーション名を取得する
 * @param admin Shopify Admin APIクライアント
 * @param locationId Location ID（GID形式）
 * @returns ロケーション名
 */
export async function getLocationName(
  admin: { request: (options: { data: string; variables?: any }) => Promise<any> },
  locationId: string
): Promise<string> {
  try {
    const resp = await admin.request({
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
    // shopify.clients.GraphqlのrequestメソッドはJSONを直接返す
    const data = resp && typeof resp.json === "function" ? await resp.json() : resp;
    return data?.data?.location?.name || locationId;
  } catch (error) {
    console.error("Failed to get location name:", error);
    return locationId;
  }
}

/**
 * 在庫調整の結果から変動履歴を記録する（複数商品対応）
 * @param admin Shopify Admin APIクライアント
 * @param shop ショップ識別子
 * @param changes 在庫変更の配列
 * @param activity アクティビティ種別
 * @param sourceId 参照元ID
 * @param adjustmentGroupId InventoryAdjustmentGroup ID（取れる場合）
 * @param note 備考
 * @returns 成功した件数
 */
export async function logInventoryChangesFromAdjustment(
  admin: { request: (options: { data: string; variables?: any }) => Promise<any> },
  shop: string,
  changes: Array<{ inventoryItemId: string; locationId: string; delta: number }>,
  activity: InventoryChangeLogData["activity"],
  sourceId?: string | null,
  adjustmentGroupId?: string | null,
  note?: string | null
): Promise<number> {
  if (!changes || changes.length === 0) return 0;

  const { timezone, date: baseDate } = await getShopTimezoneAndDate(admin, new Date());
  let successCount = 0;

  // 各変更に対してログを記録
  for (const change of changes) {
    try {
      // 商品情報とロケーション情報を並列取得
      const [itemInfo, locationName] = await Promise.all([
        getInventoryItemInfo(admin, change.inventoryItemId),
        getLocationName(admin, change.locationId),
      ]);

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
          variables: { itemId: change.inventoryItemId },
        });
        // shopify.clients.GraphqlのrequestメソッドはJSONを直接返す
        const levelData = levelResp && typeof levelResp.json === "function" ? await levelResp.json() : levelResp;
        // 特定のロケーションに一致するInventoryLevelを検索
        const levels = levelData?.data?.inventoryItem?.inventoryLevels?.edges || [];
        const matchingLevel = levels.find(
          (edge: any) => edge?.node?.location?.id === change.locationId
        );
        if (matchingLevel?.node?.quantities?.[0]) {
          quantityAfter = matchingLevel.node.quantities[0].quantity;
        }
      } catch (error) {
        console.error("Failed to get inventory level:", error);
        // quantityAfterはnullのまま続行
      }

      // 二重登録防止用キーを生成
      const idempotencyKey = `${shop}_${activity}_${change.inventoryItemId}_${change.locationId}_${sourceId || "unknown"}_${Date.now()}`;

      const logData: InventoryChangeLogData = {
        shop,
        timestamp: new Date(),
        inventoryItemId: change.inventoryItemId,
        variantId: itemInfo.variantId,
        sku: itemInfo.sku,
        locationId: change.locationId,
        locationName,
        activity,
        delta: change.delta,
        quantityAfter,
        sourceType: activity,
        sourceId,
        adjustmentGroupId,
        idempotencyKey,
        note,
      };

      const success = await logInventoryChange(logData);
      if (success) successCount++;
    } catch (error) {
      console.error(`Error logging inventory change for item ${change.inventoryItemId}:`, error);
    }
  }

  return successCount;
}
