// app/routes/api.inventory-snapshot-daily.tsx
// 日次スナップショット自動保存API（Cronジョブから呼び出し用）
import type { ActionFunctionArgs } from "react-router";
import { sessionStorage } from "../shopify.server";
import shopify from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone } from "../utils/timezone";

const INVENTORY_INFO_NS = "inventory_info";
const DAILY_SNAPSHOTS_KEY = "daily_snapshots";

// 在庫アイテムを取得するGraphQLクエリ
const INVENTORY_ITEMS_QUERY = `#graphql
  query InventoryItemsForSnapshot($first: Int!, $after: String) {
    inventoryItems(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          unitCost {
            amount
            currencyCode
          }
          inventoryLevels(first: 250) {
            edges {
              node {
                id
                quantities(names: ["available"]) {
                  name
                  quantity
                }
                location {
                  id
                  name
                }
              }
            }
          }
          variant {
            id
            sku
            price
            compareAtPrice
            product {
              id
              title
            }
          }
        }
      }
    }
  }
`;

// Metafieldから日次スナップショットを読み取るクエリ
const GET_SNAPSHOTS_QUERY = `#graphql
  query GetInventorySnapshots {
    shop {
      id
      ianaTimezone
      metafield(namespace: "${INVENTORY_INFO_NS}", key: "${DAILY_SNAPSHOTS_KEY}") {
        id
        value
      }
    }
  }
`;

// Metafieldに日次スナップショットを保存するmutation
const SAVE_SNAPSHOTS_MUTATION = `#graphql
  mutation SaveInventorySnapshots($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export type DailyInventorySnapshot = {
  date: string;
  locationId: string;
  locationName: string;
  totalQuantity: number;
  totalRetailValue: number;
  totalCompareAtPriceValue: number;
  totalCostValue: number;
};

export type InventorySnapshotsData = {
  version: 1;
  snapshots: DailyInventorySnapshot[];
};

export async function action({ request }: ActionFunctionArgs) {
  try {
    // APIキーで認証（Cronジョブからの呼び出し用）
    const authHeader = request.headers.get("Authorization");
    const expectedApiKey = process.env.INVENTORY_SNAPSHOT_API_KEY;
    
    if (!expectedApiKey || authHeader !== `Bearer ${expectedApiKey}`) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 全ショップのセッションを取得（オフラインアクセストークン）
    const sessions = await db.session.findMany({
      where: {
        isOnline: false, // オフラインアクセストークンのみ
      },
    });

    if (sessions.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "No shops to process", processed: 0 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    let processedCount = 0;
    const errors: string[] = [];

    // 各ショップのスナップショットを保存
    for (const sessionRecord of sessions) {
      try {
        // セッションを読み込む
        const session = await sessionStorage.loadSession(sessionRecord.id);
        if (!session) {
          errors.push(`${sessionRecord.shop}: Session not found`);
          continue;
        }

        // セッションからadminクライアントを作成
        const admin = shopify.clients.Graphql({ session });
        
        // 既存のスナップショットを読み取る
        const snapshotsResp = await admin.request({ data: GET_SNAPSHOTS_QUERY });
        const snapshotsData = await snapshotsResp.json();
        
        if (snapshotsData.errors) {
          errors.push(`${sessionRecord.shop}: ${snapshotsData.errors.map((e: any) => e.message).join(", ")}`);
          continue;
        }
        
        const shopId = snapshotsData?.data?.shop?.id;
        const shopTimezone = snapshotsData?.data?.shop?.ianaTimezone || "UTC"; // デフォルトはUTC
        const metafieldValue = snapshotsData?.data?.shop?.metafield?.value;

        let savedSnapshots: InventorySnapshotsData = { version: 1, snapshots: [] };
        if (typeof metafieldValue === "string" && metafieldValue) {
          try {
            const parsed = JSON.parse(metafieldValue);
            if (parsed?.version === 1 && Array.isArray(parsed?.snapshots)) {
              savedSnapshots = parsed;
            }
          } catch {
            // ignore
          }
        }

        // 前日のスナップショットを保存（ショップのタイムゾーンに基づく）
        const yesterdayDate = new Date();
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterdayStr = getDateInShopTimezone(yesterdayDate, shopTimezone);
        
        // 既に前日のスナップショットが存在する場合はスキップ
        const yesterdaySnapshotExists = savedSnapshots.snapshots.some((s) => s.date === yesterdayStr);
        if (yesterdaySnapshotExists) {
          continue; // 既に保存済みの場合はスキップ
        }

        // 前日の在庫情報を取得
        const allItems: any[] = [];
        let hasNextPage = true;
        let cursor: string | null = null;

        while (hasNextPage) {
          const resp = await admin.request({ data: INVENTORY_ITEMS_QUERY, variables: { first: 50, after: cursor } });
          const data = await resp.json();
          
          if (data.errors) {
            errors.push(`${sessionRecord.shop}: ${data.errors.map((e: any) => e.message).join(", ")}`);
            break;
          }
          
          const edges = data?.data?.inventoryItems?.edges ?? [];
          const nodes = edges.map((e: any) => e.node);
          allItems.push(...nodes);

          hasNextPage = data?.data?.inventoryItems?.pageInfo?.hasNextPage ?? false;
          cursor = data?.data?.inventoryItems?.pageInfo?.endCursor ?? null;
        }

        // ロケーション別に集計
        const locationMap = new Map<string, DailyInventorySnapshot>();
        
        for (const item of allItems) {
          const unitCost = parseFloat(item.unitCost?.amount ?? "0");
          const variant = item.variant;
          const retailPrice = parseFloat(variant?.price ?? "0");
          const compareAtPrice = parseFloat(variant?.compareAtPrice ?? "0");
          
          const levels = item.inventoryLevels?.edges ?? [];
          for (const levelEdge of levels) {
            const level = levelEdge.node;
            const locationId = level.location?.id;
            const locationName = level.location?.name ?? "";
            const quantity = level.quantities?.find((q: any) => q.name === "available")?.quantity ?? 0;
            
            if (!locationId) continue;

            if (!locationMap.has(locationId)) {
              locationMap.set(locationId, {
                date: yesterdayStr,
                locationId,
                locationName,
                totalQuantity: 0,
                totalRetailValue: 0,
                totalCompareAtPriceValue: 0,
                totalCostValue: 0,
              });
            }

            const snapshot = locationMap.get(locationId)!;
            snapshot.totalQuantity += quantity;
            snapshot.totalRetailValue += quantity * retailPrice;
            snapshot.totalCompareAtPriceValue += quantity * (compareAtPrice || retailPrice);
            snapshot.totalCostValue += quantity * unitCost;
          }
        }

        const yesterdaySnapshots = Array.from(locationMap.values());

        // 既存のスナップショットから前日の日付のものを削除して、新しいものを追加
        const updatedSnapshots = savedSnapshots.snapshots.filter((s) => s.date !== yesterdayStr);
        updatedSnapshots.push(...yesterdaySnapshots);

        // Metafieldに保存
        const saveResp = await admin.request({
          data: SAVE_SNAPSHOTS_MUTATION,
          variables: {
            metafields: [
              {
                ownerId: shopId,
                namespace: INVENTORY_INFO_NS,
                key: DAILY_SNAPSHOTS_KEY,
                type: "json",
                value: JSON.stringify({
                  version: 1,
                  snapshots: updatedSnapshots,
                }),
              },
            ],
          },
        });

        const saveData = await saveResp.json();
        const userErrors = saveData?.data?.metafieldsSet?.userErrors ?? [];

        if (userErrors.length > 0) {
          errors.push(`${sessionRecord.shop}: ${userErrors.map((e: any) => e.message).join(", ")}`);
        } else {
          processedCount++;
          console.log(`Auto-saved snapshot for ${sessionRecord.shop} (${yesterdayStr})`);
        }
      } catch (error) {
        errors.push(`${sessionRecord.shop}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`Error processing ${sessionRecord.shop}:`, error);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        message: `Processed ${processedCount} shops`,
        processed: processedCount,
        total: sessions.length,
        errors: errors.length > 0 ? errors : undefined,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Daily snapshot API error:", error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save snapshots",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
