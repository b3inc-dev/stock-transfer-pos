// app/utils/inventory-change-log.ts
// 在庫変動履歴を記録する共通ユーティリティ関数

import db from "../db.server";
import { getDateInShopTimezone, getShopTimezone } from "./timezone";
import type { InventoryActivity } from "../types";

export type InventoryChangeLogData = {
  shop: string;
  timestamp: Date;
  inventoryItemId: string;
  variantId?: string | null;
  sku: string;
  locationId: string;
  locationName: string;
  activity: InventoryActivity;
  delta: number | null;
  quantityAfter: number | null;
  sourceType: string;
  sourceId?: string | null;
  adjustmentGroupId?: string | null;
  idempotencyKey: string;
  note?: string | null;
  /** ショップタイムゾーンで計算した日付（YYYY-MM-DD）。渡すとUTCフォールバックを使わず一貫した日付になる */
  date?: string | null;
};

const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * ProductVariantからInventoryItem IDとSKUを取得する
 */
export async function getVariantInfo(
  admin: { graphql: (q: string, v?: Record<string, unknown>) => Promise<Response> },
  variantId: string
): Promise<{ inventoryItemId: string | null; sku: string; variantId: string }> {
  try {
    const resp = await admin.graphql(
      `#graphql
      query GetVariant($id: ID!) {
        productVariant(id: $id) {
          id
          sku
          inventoryItem { id }
        }
      }`,
      { variables: { id: variantId } }
    );
    const { data } = await resp.json() as { data?: { productVariant?: { id: string; sku: string; inventoryItem?: { id: string } } } };
    const variant = data?.productVariant;
    return {
      inventoryItemId: variant?.inventoryItem?.id ?? null,
      sku: variant?.sku ?? "",
      variantId: variant?.id ?? variantId,
    };
  } catch (error) {
    console.error("[getVariantInfo] Failed:", error);
    return { inventoryItemId: null, sku: "", variantId };
  }
}

/**
 * 在庫変動履歴を記録する共通関数
 */
export async function logInventoryChange(data: InventoryChangeLogData): Promise<boolean> {
  try {
    const date = data.date ?? getDateInShopTimezone(data.timestamp, "UTC");

    if (IS_DEV) {
      console.log(`[logInventoryChange] shop=${data.shop} activity=${data.activity} item=${data.inventoryItemId} location=${data.locationId} delta=${data.delta} date=${date}`);
    }

    await db.inventoryChangeLog.create({
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

    return true;
  } catch (error) {
    console.error("[logInventoryChange] Error:", error);
    return false;
  }
}

/**
 * ショップのタイムゾーンを取得して日付を計算する
 */
export async function getShopTimezoneAndDate(
  admin: { graphql: (q: string, v?: Record<string, unknown>) => Promise<Response> },
  timestamp: Date
): Promise<{ timezone: string; date: string }> {
  const timezone = await getShopTimezone(admin);
  const date = getDateInShopTimezone(timestamp, timezone);
  return { timezone, date };
}

/**
 * InventoryItemからSKUとvariantIdを取得する
 */
export async function getInventoryItemInfo(
  admin: { graphql: (q: string, v?: Record<string, unknown>) => Promise<Response> },
  inventoryItemId: string
): Promise<{ sku: string; variantId: string | null }> {
  try {
    const resp = await admin.graphql(
      `#graphql
      query GetInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          id
          variant { id sku }
        }
      }`,
      { variables: { id: inventoryItemId } }
    );
    const { data } = await resp.json() as { data?: { inventoryItem?: { variant?: { id: string; sku: string } } } };
    const variant = data?.inventoryItem?.variant;
    return {
      sku: variant?.sku ?? "",
      variantId: variant?.id ?? null,
    };
  } catch (error) {
    console.error("[getInventoryItemInfo] Failed:", error);
    return { sku: "", variantId: null };
  }
}

/**
 * Locationからロケーション名を取得する
 */
export async function getLocationName(
  admin: { graphql: (q: string, v?: Record<string, unknown>) => Promise<Response> },
  locationId: string
): Promise<string> {
  try {
    const resp = await admin.graphql(
      `#graphql
      query GetLocation($id: ID!) {
        location(id: $id) { id name }
      }`,
      { variables: { id: locationId } }
    );
    const { data } = await resp.json() as { data?: { location?: { name: string } } };
    return data?.location?.name ?? locationId;
  } catch (error) {
    console.error("[getLocationName] Failed:", error);
    return locationId;
  }
}

/**
 * 在庫調整の結果から変動履歴を記録する（複数商品対応）
 */
export async function logInventoryChangesFromAdjustment(
  admin: { graphql: (q: string, v?: Record<string, unknown>) => Promise<Response> },
  shop: string,
  changes: Array<{ inventoryItemId: string; locationId: string; delta: number }>,
  activity: InventoryActivity,
  sourceId?: string | null,
  adjustmentGroupId?: string | null,
  note?: string | null
): Promise<number> {
  if (!changes || changes.length === 0) return 0;

  const { date: baseDate } = await getShopTimezoneAndDate(admin, new Date());
  let successCount = 0;

  for (const change of changes) {
    try {
      const [itemInfo, locationName] = await Promise.all([
        getInventoryItemInfo(admin, change.inventoryItemId),
        getLocationName(admin, change.locationId),
      ]);

      // 変動後の数量を取得
      let quantityAfter: number | null = null;
      try {
        const levelResp = await admin.graphql(
          `#graphql
          query GetInventoryLevel($itemId: ID!) {
            inventoryItem(id: $itemId) {
              inventoryLevels(first: 250) {
                edges {
                  node {
                    location { id }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }`,
          { variables: { itemId: change.inventoryItemId } }
        );
        const levelJson = await levelResp.json() as {
          data?: {
            inventoryItem?: {
              inventoryLevels?: {
                edges: Array<{
                  node: {
                    location: { id: string };
                    quantities: Array<{ name: string; quantity: number }>;
                  };
                }>;
              };
            };
          };
        };
        const levels = levelJson.data?.inventoryItem?.inventoryLevels?.edges ?? [];
        const matchingLevel = levels.find((edge) => edge.node.location.id === change.locationId);
        if (matchingLevel?.node.quantities[0]) {
          quantityAfter = matchingLevel.node.quantities[0].quantity;
        }
      } catch (error) {
        console.error("[logInventoryChangesFromAdjustment] Failed to get inventory level:", error);
      }

      // sourceId がある場合は決定論的なキー、ない場合は分単位に丸めたタイムスタンプで冪等ウィンドウを1分に拡大
      // （秒単位だと1秒以内のリトライで別キーになり二重記録が発生する可能性があるため）
      const timestampRounded = new Date(Math.floor(Date.now() / 60000) * 60000);
      const idempotencyKey = sourceId
        ? `${shop}_${activity}_${change.inventoryItemId}_${change.locationId}_${sourceId}`
        : `${shop}_${activity}_${change.inventoryItemId}_${change.locationId}_${timestampRounded.toISOString()}`;

      const logData: InventoryChangeLogData = {
        shop,
        timestamp: new Date(),
        date: baseDate,
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

      if (await logInventoryChange(logData)) successCount++;
    } catch (error) {
      console.error(`[logInventoryChangesFromAdjustment] Error for item ${change.inventoryItemId}:`, error);
    }
  }

  return successCount;
}
