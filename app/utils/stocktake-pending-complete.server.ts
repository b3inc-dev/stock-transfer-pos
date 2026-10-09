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
import {
  interpretMetafieldsSetWriteResult,
  mergePendingCompleteIntoCounts,
} from "./stocktake-pending-complete-merge";

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
    const json = (await resp.json().catch(() => ({}))) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
      errors?: Array<{ message?: string }>;
    };
    const interpreted = interpretMetafieldsSetWriteResult({
      httpOk: resp.ok,
      httpStatus: resp.status,
      json,
    });
    if (!interpreted.ok) {
      console.warn("[pending-complete] write failed:", interpreted.error);
      return interpreted;
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

  const { updatedCounts, savedCount, status, completedAt } = mergePendingCompleteIntoCounts({
    inventoryCounts: inventoryCounts as InventoryCount[],
    countId,
    completedGroups,
  });
  if (!savedCount) {
    return { ok: false, error: "棚卸が見つかりません", countId };
  }

  const { userErrors } = await writeInventoryCountsChunked(
    admin,
    updatedCounts as InventoryCount[],
    ownerId
  );
  if (userErrors.length > 0) {
    const message = userErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "保存に失敗しました";
    return { ok: false, error: message, countId };
  }

  const clearResult = await writePendingCompleteBackup(admin, ownerId, null);
  if (!clearResult.ok) {
    // メタ本体は更新済み。バックアップ削除失敗は Admin が誤って再試行必要と見なす程度のため非致命。
    console.warn("[pending-complete] clear backup after success failed:", clearResult.error);
  }
  return {
    ok: true,
    countId,
    status,
    completedAt,
    savedCount: savedCount as InventoryCount,
  };
}
