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
  pageSize: number = 250
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

// ==================== Bulk Operation 実装 ====================

const BULK_OPERATION_QUERY = `#graphql
  {
    inventoryItems {
      edges {
        node {
          id
          unitCost {
            amount
            currencyCode
          }
          inventoryLevels {
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

const BULK_OPERATION_RUN_QUERY = `#graphql
  mutation BulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
        errorCode
        createdAt
        completedAt
        objectCount
        fileSize
        url
        partialDataUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CURRENT_BULK_OPERATION_QUERY = `#graphql
  query CurrentBulkOperation {
    currentBulkOperation {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
      partialDataUrl
    }
  }
`;

export type BulkOperationStatus = "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "EXPIRED";

export type BulkOperationResult = {
  id: string;
  status: BulkOperationStatus;
  errorCode?: string;
  createdAt: string;
  completedAt?: string;
  objectCount?: number;
  fileSize?: number;
  url?: string;
  partialDataUrl?: string;
};

/** Bulk Operation を開始する */
export async function startBulkOperation(
  admin: { request: AdminRequest }
): Promise<{ ok: boolean; bulkOperation?: BulkOperationResult; userErrors?: string[] }> {
  try {
    const data = await requestJson(admin, BULK_OPERATION_RUN_QUERY, {
      query: BULK_OPERATION_QUERY,
    });

    if (data?.errors) {
      return {
        ok: false,
        userErrors: Array.isArray(data.errors)
          ? data.errors.map((e: any) => e?.message ?? String(e))
          : [String(data.errors)],
      };
    }

    const bulkOp = data?.data?.bulkOperationRunQuery?.bulkOperation;
    const userErrors = data?.data?.bulkOperationRunQuery?.userErrors ?? [];

    if (userErrors.length > 0) {
      return {
        ok: false,
        userErrors: userErrors.map((e: any) => e.message ?? String(e)),
      };
    }

    if (!bulkOp) {
      return { ok: false, userErrors: ["Bulk operation not created"] };
    }

    return {
      ok: true,
      bulkOperation: {
        id: bulkOp.id,
        status: bulkOp.status,
        errorCode: bulkOp.errorCode,
        createdAt: bulkOp.createdAt,
        completedAt: bulkOp.completedAt,
        objectCount: bulkOp.objectCount,
        fileSize: bulkOp.fileSize,
        url: bulkOp.url,
        partialDataUrl: bulkOp.partialDataUrl,
      },
    };
  } catch (error) {
    return {
      ok: false,
      userErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** 現在の Bulk Operation のステータスを取得する */
export async function getCurrentBulkOperation(
  admin: { request: AdminRequest }
): Promise<{ ok: boolean; bulkOperation?: BulkOperationResult; error?: string }> {
  try {
    const data = await requestJson(admin, CURRENT_BULK_OPERATION_QUERY);

    if (data?.errors) {
      return {
        ok: false,
        error: Array.isArray(data.errors)
          ? data.errors.map((e: any) => e?.message ?? String(e)).join(", ")
          : String(data.errors),
      };
    }

    const bulkOp = data?.data?.currentBulkOperation;
    if (!bulkOp) {
      return { ok: true, bulkOperation: undefined };
    }

    return {
      ok: true,
      bulkOperation: {
        id: bulkOp.id,
        status: bulkOp.status,
        errorCode: bulkOp.errorCode,
        createdAt: bulkOp.createdAt,
        completedAt: bulkOp.completedAt,
        objectCount: bulkOp.objectCount,
        fileSize: bulkOp.fileSize,
        url: bulkOp.url,
        partialDataUrl: bulkOp.partialDataUrl,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Bulk Operation の結果をダウンロードしてパースする */
export async function downloadBulkOperationResult(
  url: string
): Promise<any[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download bulk operation result: ${response.statusText}`);
  }

  const text = await response.text();
  const lines = text.trim().split("\n").filter((line) => line.trim());
  const items: any[] = [];

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      items.push(item);
    } catch (error) {
      console.warn("Failed to parse bulk operation result line:", error, line);
    }
  }

  return items;
}

/** Bulk Operation を使って在庫スナップショットを取得して保存 */
export async function fetchAndSaveSnapshotsForDateUsingBulkOperation(
  admin: { request: AdminRequest },
  dateStr: string,
  maxWaitSeconds: number = 300
): Promise<{ ok: boolean; userErrors?: string[]; skipped?: boolean }> {
  try {
    // 既存の Bulk Operation が実行中か確認
    const currentOp = await getCurrentBulkOperation(admin);
    if (currentOp.ok && currentOp.bulkOperation) {
      const status = currentOp.bulkOperation.status;
      if (status === "RUNNING" || status === "CREATED") {
        // 既に実行中の場合は、その完了を待つ
        return await waitForBulkOperationAndSave(admin, currentOp.bulkOperation.id, dateStr, maxWaitSeconds);
      }
    }

    // 新しい Bulk Operation を開始
    const startResult = await startBulkOperation(admin);
    if (!startResult.ok || !startResult.bulkOperation) {
      return {
        ok: false,
        userErrors: startResult.userErrors ?? ["Failed to start bulk operation"],
      };
    }

    // 完了を待つ
    return await waitForBulkOperationAndSave(admin, startResult.bulkOperation.id, dateStr, maxWaitSeconds);
  } catch (error) {
    return {
      ok: false,
      userErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** Bulk Operation の完了を待って結果を保存する */
async function waitForBulkOperationAndSave(
  admin: { request: AdminRequest },
  bulkOperationId: string,
  dateStr: string,
  maxWaitSeconds: number
): Promise<{ ok: boolean; userErrors?: string[]; skipped?: boolean }> {
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;
  const pollIntervalMs = 2000; // 2秒ごとにポーリング

  while (Date.now() - startTime < maxWaitMs) {
    const currentOp = await getCurrentBulkOperation(admin);
    if (!currentOp.ok || !currentOp.bulkOperation) {
      return {
        ok: false,
        userErrors: [currentOp.error ?? "Failed to get bulk operation status"],
      };
    }

    const status = currentOp.bulkOperation.status;

    if (status === "COMPLETED") {
      // 完了したら結果をダウンロード
      const url = currentOp.bulkOperation.url;
      if (!url) {
        return {
          ok: false,
          userErrors: ["Bulk operation completed but no URL provided"],
        };
      }

      const items = await downloadBulkOperationResult(url);
      // Bulk Operation の結果は inventoryItems の配列なので、そのまま集計に使える
      const newSnapshots = aggregateSnapshotsFromItems(items, dateStr);

      const { shopId, savedSnapshots } = await getSavedSnapshots(admin);
      const { userErrors } = await saveSnapshotsForDate(admin, shopId, savedSnapshots, newSnapshots, dateStr);

      if (userErrors.length > 0) {
        return {
          ok: false,
          userErrors: userErrors.map((e: any) => e.message),
        };
      }

      return { ok: true };
    }

    if (status === "FAILED" || status === "CANCELED" || status === "EXPIRED") {
      return {
        ok: false,
        userErrors: [
          `Bulk operation ${status.toLowerCase()}: ${currentOp.bulkOperation.errorCode ?? "Unknown error"}`,
        ],
      };
    }

    // RUNNING または CREATED の場合は待つ
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // タイムアウト
  return {
    ok: false,
    userErrors: [`Bulk operation timeout after ${maxWaitSeconds} seconds`],
  };
}
