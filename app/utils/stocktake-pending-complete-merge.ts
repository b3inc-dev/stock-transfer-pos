/**
 * pending_complete バックアップを棚卸ドキュメント配列へマージする純粋ロジック。
 * savedCount は dual-write 用（成功後の再 read を避ける）。
 *
 * ※ app.inventory-count を import しない（テスト容易性・ルート循環回避）。
 */
import { resolveStocktakeCompleteStatus } from "./stocktake-complete-status.ts";

/** ルート InventoryCount と同型の最小フィールド */
export type MergeInventoryCount = {
  id?: string;
  productGroupIds?: string[] | null;
  productGroupId?: string | null;
  cancelledGroupIds?: string[] | null;
  groupItems?: Record<string, unknown[]>;
  status?: string;
  completedAt?: string | null;
  [key: string]: unknown;
};

export type PendingCompleteMergeItem = {
  inventoryItemId: string;
  currentQuantity: number;
  actualQuantity: number;
  variantId?: string;
  sku?: string;
  title?: string;
};

export type PendingCompleteMergeGroup = {
  groupId: string;
  items: PendingCompleteMergeItem[];
};

function normalizeIdForMatch(id: string | number | undefined | null): string {
  const s = String(id ?? "").trim();
  const lastSegment = s.split("/").pop() || s;
  return lastSegment;
}

/**
 * GraphQL metafieldsSet 応答を backupPersisted 用の ok/error に正規化する。
 */
export function interpretMetafieldsSetWriteResult(args: {
  httpOk: boolean;
  httpStatus: number;
  json: {
    data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
    errors?: Array<{ message?: string }>;
  };
}): { ok: boolean; error?: string } {
  if (!args.httpOk) {
    return { ok: false, error: `HTTP ${args.httpStatus}` };
  }
  const userErrors = args.json?.data?.metafieldsSet?.userErrors ?? [];
  if (args.json?.errors?.length) {
    const msg =
      args.json.errors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "GraphQL errors";
    return { ok: false, error: msg };
  }
  if (userErrors.length > 0) {
    const msg = userErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "userErrors";
    return { ok: false, error: msg };
  }
  return { ok: true };
}

export function mergePendingCompleteIntoCounts(args: {
  inventoryCounts: MergeInventoryCount[];
  countId: string;
  completedGroups: PendingCompleteMergeGroup[];
  /** テスト固定用。省略時は allDone なら now ISO */
  nowIso?: string;
}): {
  updatedCounts: MergeInventoryCount[];
  savedCount?: MergeInventoryCount;
  status: "completed" | "in_progress";
  completedAt?: string;
} {
  const { inventoryCounts, countId, completedGroups } = args;
  const count = inventoryCounts.find(
    (c) =>
      String(c.id) === String(countId) ||
      normalizeIdForMatch(c.id) === normalizeIdForMatch(countId)
  );
  if (!count) {
    return {
      updatedCounts: inventoryCounts,
      status: "in_progress",
    };
  }

  const groupItemsMap: Record<string, unknown[]> =
    count.groupItems && typeof count.groupItems === "object" ? { ...count.groupItems } : {};

  for (const { groupId: gid, items } of completedGroups) {
    const entry = items.map((i) => ({
      inventoryItemId: i.inventoryItemId,
      variantId: i.variantId,
      sku: i.sku ?? "",
      title: i.title ?? "",
      currentQuantity: Number(i.currentQuantity),
      actualQuantity: Number(i.actualQuantity),
      delta: Number(i.actualQuantity) - Number(i.currentQuantity),
    }));
    const key =
      Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(gid)) ??
      gid;
    groupItemsMap[key] = entry;
  }

  const completedGroupIds = completedGroups.map((g) => g.groupId);
  const { status, allDone, groupIdsForCheck } = resolveStocktakeCompleteStatus({
    productGroupIds: count.productGroupIds,
    productGroupId: count.productGroupId,
    cancelledGroupIds: count.cancelledGroupIds,
    groupItemsMap,
    completedGroupIds,
  });
  const completedAt = allDone ? args.nowIso ?? new Date().toISOString() : undefined;
  const hadProductGroupIds =
    (Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0) ||
    Boolean(count.productGroupId);

  let savedCount: MergeInventoryCount | undefined;
  const updatedCounts: MergeInventoryCount[] = inventoryCounts.map((c) => {
    if (
      String(c.id) !== String(countId) &&
      normalizeIdForMatch(c.id) !== normalizeIdForMatch(countId)
    ) {
      return c;
    }
    const next: MergeInventoryCount = {
      ...c,
      groupItems: groupItemsMap,
      status,
      completedAt,
    };
    if (!hadProductGroupIds && groupIdsForCheck.length > 0) {
      next.productGroupIds = groupIdsForCheck;
    }
    savedCount = next;
    return next;
  });

  return { updatedCounts, savedCount, status, completedAt };
}
