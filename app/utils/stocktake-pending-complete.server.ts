/**
 * STOCKTAKE_COMPLETE_RETRY: pending_complete_v1 バックアップの読取・書込・メタ更新適用。
 * POS API と Admin action の両方から使う。
 */
import {
  readInventoryCountsChunked,
  writeInventoryCountsChunked,
  normalizeIdForMatch,
  type InventoryCount,
} from "../routes/app.inventory-count";
import { resolveStocktakeCompleteStatus } from "./stocktake-complete-status";

export const STOCKTAKE_NS = "stock_transfer_pos";
export const PENDING_COMPLETE_KEY = "pending_complete_v1";

export type PendingCompleteItemEntry = {
  inventoryItemId: string;
  currentQuantity: number;
  actualQuantity: number;
  variantId?: string;
  sku?: string;
  title?: string;
};
export type PendingCompleteGroup = { groupId: string; items: PendingCompleteItemEntry[] };
export type PendingCompleteBackup = {
  countId: string;
  completedGroups: PendingCompleteGroup[];
  savedAt: string;
};

type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/**
 * pending_complete_v1 を書く。成功/失敗を呼び出し元が判定できるようにする
 * （失敗を握りつぶすと Admin retryOnly が 404 になるギャップがあった）。
 */
export async function writePendingCompleteBackup(
  admin: AdminGraphql,
  ownerId: string,
  backup: PendingCompleteBackup | null
): Promise<{ ok: boolean; error?: string }> {
  const value = backup ? JSON.stringify(backup) : "{}";
  const mutation = `#graphql mutation SetPendingComplete($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { message } }
  }`;
  try {
    const resp = await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: STOCKTAKE_NS,
            key: PENDING_COMPLETE_KEY,
            type: "json",
            value,
          },
        ],
      },
    });
    if (!resp.ok) {
      const msg = `HTTP ${resp.status}`;
      console.warn("[pending-complete] write failed:", msg);
      return { ok: false, error: msg };
    }
    const json = (await resp.json().catch(() => ({}))) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
      errors?: Array<{ message?: string }>;
    };
    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
    if (json?.errors?.length) {
      const msg = json.errors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "GraphQL errors";
      console.warn("[pending-complete] write GraphQL errors:", msg);
      return { ok: false, error: msg };
    }
    if (userErrors.length > 0) {
      const msg = userErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "userErrors";
      console.warn("[pending-complete] write userErrors:", msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[pending-complete] write failed:", msg);
    return { ok: false, error: msg };
  }
}

export async function readPendingCompleteBackup(
  admin: AdminGraphql
): Promise<PendingCompleteBackup | null> {
  const query = `#graphql query PendingComplete {
    currentAppInstallation {
      metafield(namespace: "${STOCKTAKE_NS}", key: "${PENDING_COMPLETE_KEY}") { value }
    }
  }`;
  try {
    const resp = await admin.graphql(query);
    const json = (await resp.json().catch(() => ({}))) as {
      data?: { currentAppInstallation?: { metafield?: { value?: string } } };
    };
    const raw = json?.data?.currentAppInstallation?.metafield?.value;
    if (!raw || raw === "{}") return null;
    const parsed = JSON.parse(raw) as PendingCompleteBackup;
    if (!parsed?.countId || !Array.isArray(parsed.completedGroups)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * バックアップの completedGroups を metafield 棚卸にマージして書く。成功時バックアップを削除。
 */
export async function applyPendingCompleteFromBackup(
  admin: AdminGraphql,
  ownerId: string,
  backup: PendingCompleteBackup
): Promise<{
  ok: boolean;
  error?: string;
  countId: string;
  status?: "completed" | "in_progress";
  completedAt?: string;
  /** dual-write 用。成功時は再 readInventoryCountsChunked 不要 */
  savedCount?: InventoryCount;
}> {
  const countId = backup.countId;
  const completedGroups = backup.completedGroups;
  if (!countId || !completedGroups?.length) {
    return { ok: false, error: "バックアップが不正です", countId: countId || "" };
  }

  let inventoryCounts: InventoryCount[];
  try {
    // shop は呼び出し側で dual-read したい場合に別途渡す。ここでは metafield 正本＋バックアップ適用。
    inventoryCounts = await readInventoryCountsChunked(admin);
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), countId };
  }

  const count = inventoryCounts.find(
    (c) => String(c.id) === String(countId) || normalizeIdForMatch((c as { id?: string }).id) === normalizeIdForMatch(countId)
  );
  if (!count) {
    return { ok: false, error: "棚卸が見つかりません", countId };
  }

  const groupItemsMap: Record<string, unknown[]> =
    (count as { groupItems?: Record<string, unknown[]> }).groupItems && typeof (count as { groupItems?: unknown }).groupItems === "object"
      ? { ...((count as { groupItems: Record<string, unknown[]> }).groupItems) }
      : {};

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
    const key = Object.keys(groupItemsMap).find((k) => normalizeIdForMatch(k) === normalizeIdForMatch(gid)) ?? gid;
    groupItemsMap[key] = entry;
  }

  const completedGroupIds = completedGroups.map((g) => g.groupId);
  const { status, allDone, groupIdsForCheck } = resolveStocktakeCompleteStatus({
    productGroupIds: count.productGroupIds,
    productGroupId: (count as { productGroupId?: string }).productGroupId,
    cancelledGroupIds: (count as { cancelledGroupIds?: string[] }).cancelledGroupIds,
    groupItemsMap,
    completedGroupIds,
  });
  const completedAt = allDone ? new Date().toISOString() : undefined;
  const hadProductGroupIds =
    (Array.isArray(count.productGroupIds) && count.productGroupIds.length > 0) ||
    Boolean((count as { productGroupId?: string }).productGroupId);

  let savedCount: InventoryCount | undefined;
  const updatedCounts: InventoryCount[] = inventoryCounts.map((c) => {
    if (String(c.id) !== String(countId) && normalizeIdForMatch((c as { id?: string }).id) !== normalizeIdForMatch(countId)) {
      return c;
    }
    const next: InventoryCount = {
      ...c,
      groupItems: groupItemsMap,
      status,
      completedAt,
    };
    // 単一グループ等で productGroupIds が欠落していた場合、補完して次回読込でも allDone が正しくなるようにする
    if (!hadProductGroupIds && groupIdsForCheck.length > 0) {
      next.productGroupIds = groupIdsForCheck;
    }
    savedCount = next;
    return next;
  });

  const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts, ownerId);
  if (userErrors.length > 0) {
    const message = userErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "保存に失敗しました";
    return { ok: false, error: message, countId };
  }

  const clearResult = await writePendingCompleteBackup(admin, ownerId, null);
  if (!clearResult.ok) {
    // メタ本体は更新済み。バックアップ削除失敗は Admin が誤って再試行必要と見なす程度のため非致命。
    console.warn("[pending-complete] clear backup after success failed:", clearResult.error);
  }
  return { ok: true, countId, status, completedAt, savedCount };
}
