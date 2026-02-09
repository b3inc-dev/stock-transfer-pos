// app/utils/inventory-snapshot.ts
// 日次在庫スナップショットの取得・集計・保存の共通ロジック（在庫高タブ・Cron API・前日フォールバックで共有）

export const INVENTORY_INFO_NS = "inventory_info";
export const DAILY_SNAPSHOTS_KEY = "daily_snapshots";

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

/** GraphQL の Money 型や文字列から数値を取得 */
export function toAmount(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return parseFloat(v) || 0;
  if (typeof v === "object" && v !== null && "amount" in v)
    return parseFloat((v as { amount?: string }).amount ?? "0") || 0;
  return 0;
}

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

const GET_SNAPSHOTS_QUERY = `#graphql
  query GetInventorySnapshots {
    shop {
      id
      name
      ianaTimezone
      metafield(namespace: "${INVENTORY_INFO_NS}", key: "${DAILY_SNAPSHOTS_KEY}") {
        id
        value
      }
    }
  }
`;

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

export type AdminRequest = (opts: { data: string; variables?: Record<string, unknown> }) => Promise<{ json(): Promise<any> }>;

/** admin.request の戻り値を JSON に変換するヘルパー */
async function requestJson(admin: { request: AdminRequest }, data: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await admin.request({ data, variables });
  return typeof res?.json === "function" ? await res.json() : res;
}

/** 全在庫アイテムをページング取得 */
export async function fetchAllInventoryItems(
  admin: { request: AdminRequest },
  pageSize: number = 50
): Promise<any[]> {
  const allItems: any[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  while (hasNextPage) {
    const data = await requestJson(admin, INVENTORY_ITEMS_QUERY, { first: pageSize, after: cursor });
    if (data?.errors) throw new Error(Array.isArray(data.errors) ? data.errors.map((e: any) => e?.message ?? String(e)).join(", ") : String(data.errors));
    const edges = data?.data?.inventoryItems?.edges ?? [];
    const nodes = edges.map((e: any) => e.node);
    allItems.push(...nodes);
    hasNextPage = data?.data?.inventoryItems?.pageInfo?.hasNextPage ?? false;
    cursor = data?.data?.inventoryItems?.pageInfo?.endCursor ?? null;
  }
  return allItems;
}

/** 在庫アイテム一覧からロケーション別スナップショットを集計 */
export function aggregateSnapshotsFromItems(
  items: any[],
  dateStr: string
): DailyInventorySnapshot[] {
  const locationMap = new Map<string, DailyInventorySnapshot>();
  for (const item of items) {
    const unitCost = toAmount(item.unitCost?.amount ?? item.unitCost);
    const variant = item.variant ?? null;
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
          date: dateStr,
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
  return Array.from(locationMap.values());
}

/** Metafield から保存済みスナップショットとショップ情報を取得 */
export async function getSavedSnapshots(admin: { request: AdminRequest }): Promise<{
  shopId: string;
  shopName: string;
  shopTimezone: string;
  savedSnapshots: InventorySnapshotsData;
}> {
  const data = await requestJson(admin, GET_SNAPSHOTS_QUERY);
  if (data?.errors)
    throw new Error(Array.isArray(data.errors) ? data.errors.map((e: any) => e?.message ?? String(e)).join(", ") : String(data.errors));
  const shop = data?.data?.shop ?? {};
  const shopId = shop.id ?? "";
  const shopName = shop.name ?? "";
  const shopTimezone = shop.ianaTimezone ?? "UTC";
  const metafieldValue = shop.metafield?.value;
  let savedSnapshots: InventorySnapshotsData = { version: 1, snapshots: [] };
  if (typeof metafieldValue === "string" && metafieldValue) {
    try {
      const parsed = JSON.parse(metafieldValue);
      if (parsed?.version === 1 && Array.isArray(parsed?.snapshots)) savedSnapshots = parsed;
    } catch {
      /* ignore */
    }
  }
  return { shopId, shopName, shopTimezone, savedSnapshots };
}

/** 指定日付のスナップショットをマージして Metafield に保存 */
export async function saveSnapshotsForDate(
  admin: { request: AdminRequest },
  shopId: string,
  savedSnapshots: InventorySnapshotsData,
  newSnapshots: DailyInventorySnapshot[],
  dateToReplace: string
): Promise<{ userErrors: Array<{ field?: string; message: string }> }> {
  const updated = savedSnapshots.snapshots.filter((s) => s.date !== dateToReplace);
  updated.push(...newSnapshots);
  const data = await requestJson(admin, SAVE_SNAPSHOTS_MUTATION, {
    metafields: [
      {
        ownerId: shopId,
        namespace: INVENTORY_INFO_NS,
        key: DAILY_SNAPSHOTS_KEY,
        type: "json",
        value: JSON.stringify({ version: 1, snapshots: updated }),
      },
    ],
  });
  const userErrors = data?.data?.metafieldsSet?.userErrors ?? [];
  return { userErrors };
}

/** 指定日付の在庫スナップショットを取得して保存（前日フォールバックや Cron で使用） */
export async function fetchAndSaveSnapshotsForDate(
  admin: { request: AdminRequest },
  dateStr: string
): Promise<{ ok: boolean; userErrors?: string[] }> {
  const { shopId, savedSnapshots } = await getSavedSnapshots(admin);
  const items = await fetchAllInventoryItems(admin);
  const newSnapshots = aggregateSnapshotsFromItems(items, dateStr);
  const { userErrors } = await saveSnapshotsForDate(admin, shopId, savedSnapshots, newSnapshots, dateStr);
  if (userErrors.length > 0) {
    return { ok: false, userErrors: userErrors.map((e: any) => e.message) };
  }
  return { ok: true };
}
