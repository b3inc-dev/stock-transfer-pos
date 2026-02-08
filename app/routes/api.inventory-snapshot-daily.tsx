// app/routes/api.inventory-snapshot-daily.tsx
// 日次スナップショット自動保存API（Cronジョブから呼び出し用）
import type { ActionFunctionArgs } from "react-router";
import { sessionStorage } from "../shopify.server";
import db from "../db.server";
import { getDateInShopTimezone, getHourInShopTimezone } from "../utils/timezone";

const API_VERSION = "2025-10";

const INVENTORY_INFO_NS = "inventory_info";
const DAILY_SNAPSHOTS_KEY = "daily_snapshots";

// 在庫アイテムを取得するGraphQLクエリ
// variant は deprecated のため variants(first:1) も取得し、価格が取れない場合のフォールバックにする
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
          variants(first: 1) {
            edges {
              node {
                price
                compareAtPrice
              }
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

        // セッションからGraphQLクライアントを作成（shopify.clients は React Router 環境で undefined のため手動で fetch）
        const shopDomain = session.shop;
        const accessToken = session.accessToken || "";
        const admin = {
          request: async (queryOrOpts: string | { data?: string; variables?: any }, maybeVars?: any) => {
            const queryStr = typeof queryOrOpts === "string" ? queryOrOpts : (queryOrOpts.data || "");
            const variables = typeof queryOrOpts === "string" ? (maybeVars?.variables ?? maybeVars ?? {}) : (queryOrOpts.variables || {});
            const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": accessToken,
              },
              body: JSON.stringify({
                query: queryStr.replace(/^#graphql\s*/m, "").trim(),
                variables: variables || {},
              }),
            });
            return res;
          },
        };

        // 既存のスナップショットを読み取る
        // request の正しい形式: 第1引数＝クエリ文字列、第2引数＝{ variables }。{ data, variables } だと query がオブジェクトになり API が variant/unitCost を返さない
        const snapshotsResp = await admin.request(GET_SNAPSHOTS_QUERY);
        const snapshotsData = snapshotsResp && typeof snapshotsResp.json === "function" ? await snapshotsResp.json() : snapshotsResp;

        if (snapshotsData?.errors) {
          const errList = Array.isArray(snapshotsData.errors)
            ? snapshotsData.errors.map((e: any) => e?.message ?? String(e))
            : [String(snapshotsData.errors)];
          errors.push(`${sessionRecord.shop}: ${errList.join(", ")}`);
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

        // 保存する日付: 23:00-23:59 に実行されたら「今日」、それ以外（0:00 実行など）は「前日」。前日分＝その日の終了時点の在庫。
        const now = new Date();
        const hourInShop = getHourInShopTimezone(now, shopTimezone);
        const isEndOfDayRun = hourInShop === 23; // 23:59 実行 → その日の終了時点を「今日」の日付で保存
        const yesterdayDate = new Date(now);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const dateToSaveStr = isEndOfDayRun
          ? getDateInShopTimezone(now, shopTimezone)   // 今日
          : getDateInShopTimezone(yesterdayDate, shopTimezone); // 前日

        // 既にその日付のスナップショットが存在する場合はスキップ（1日1回だけ保存、二重実行防止）
        const existingForDate = savedSnapshots.snapshots.some((s) => s.date === dateToSaveStr);
        if (existingForDate) {
          continue;
        }

        // その日付の在庫情報を取得
        const allItems: any[] = [];
        let hasNextPage = true;
        let cursor: string | null = null;

        while (hasNextPage) {
          const resp = await admin.request(INVENTORY_ITEMS_QUERY, { variables: { first: 50, after: cursor } });
          const data = resp && typeof resp.json === "function" ? await resp.json() : resp;

          if (data?.errors) {
            const errList = Array.isArray(data.errors)
              ? data.errors.map((e: any) => e?.message ?? String(e))
              : [String(data.errors)];
            errors.push(`${sessionRecord.shop}: ${errList.join(", ")}`);
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
        
        // 価格を取得（Money は文字列 "123.45" のことも、オブジェクト { amount } のこともある）
        const toAmount = (v: unknown): number => {
          if (v == null) return 0;
          if (typeof v === "string") return parseFloat(v) || 0;
          if (typeof v === "object" && v !== null && "amount" in v) return parseFloat((v as { amount?: string }).amount ?? "0") || 0;
          return 0;
        };

        for (const item of allItems) {
          // 金額が0になる要因: unitCost未設定/権限不足→原価0。variant が null（deprecated や削除済み）→ variants(first:1) で補完。詳細は docs/INVENTORY_SNAPSHOT_ZERO_VALUES_ANALYSIS.md
          const unitCost = toAmount(item.unitCost?.amount ?? item.unitCost);
          const variant = item.variant ?? item.variants?.edges?.[0]?.node ?? null;
          const retailPrice = toAmount(variant?.price);
          const compareAtPrice = toAmount(variant?.compareAtPrice);
          
          const levels = item.inventoryLevels?.edges ?? [];
          for (const levelEdge of levels) {
            const level = levelEdge.node;
            const locationId = level.location?.id;
            const locationName = level.location?.name ?? "";
            const quantity = level.quantities?.find((q: any) => q.name === "available")?.quantity ?? 0;
            
            if (!locationId) continue;

            if (!locationMap.has(locationId)) {
              locationMap.set(locationId, {
                date: dateToSaveStr,
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

        const newSnapshots = Array.from(locationMap.values());

        // 既存のスナップショットから同じ日付のものを削除して、新しいものを追加
        const updatedSnapshots = savedSnapshots.snapshots.filter((s) => s.date !== dateToSaveStr);
        updatedSnapshots.push(...newSnapshots);

        // Metafieldに保存
        const saveResp = await admin.request(SAVE_SNAPSHOTS_MUTATION, {
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

        const saveData = saveResp && typeof saveResp.json === "function" ? await saveResp.json() : saveResp;
        const userErrors = saveData?.data?.metafieldsSet?.userErrors ?? [];

        if (userErrors.length > 0) {
          errors.push(`${sessionRecord.shop}: ${userErrors.map((e: any) => e.message).join(", ")}`);
        } else {
          processedCount++;
          console.log(`Auto-saved snapshot for ${sessionRecord.shop} (${dateToSaveStr}${isEndOfDayRun ? ", 23:59 run" : ", 0:00 run"})`);
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
