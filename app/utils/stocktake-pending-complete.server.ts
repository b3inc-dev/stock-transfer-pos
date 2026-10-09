/**
 * STOCKTAKE_COMPLETE_RETRY: pending_complete_v1 バックアップの読取・書込・メタ更新適用。
 * POS API と Admin action の両方から使う。
 * Metafield 失敗時は DB（InventoryCountDocument）へフォールバックし、セッション喪失後の Admin 再試行を可能にする。
 */
import db from "../db.server";
import {
  readInventoryCountsChunked,
  writeInventoryCountsChunked,
  normalizeIdForMatch,
  type InventoryCount,
} from "../routes/app.inventory-count";
import { resolveStocktakeCompleteStatus } from "./stocktake-complete-status";

export const STOCKTAKE_NS = "stock_transfer_pos";
export const PENDING_COMPLETE_KEY = "pending_complete_v1";

/** DB フォールバック用の合成 countId（棚卸本体ドキュメントと衝突しない） */
export function pendingCompleteDbCountId(countId: string): string {
  return `pending_complete:${String(countId)}`;
}

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

export type WritePendingCompleteResult = {
  ok: boolean;
  error?: string;
  /** metafield 書込成功 */
  metafieldOk: boolean;
  /** DB フォールバック書込成功（クリア時は削除成功） */
  dbOk: boolean;
};

async function writePendingCompleteBackupDb(
  shop: string | undefined,
  backup: PendingCompleteBackup | null,
  clearCountId?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!shop) {
    return { ok: false, error: "shop missing for DB backup" };
  }
  try {
    if (!db || typeof (db as { inventoryCountDocument?: unknown }).inventoryCountDocument === "undefined") {
      return { ok: false, error: "InventoryCountDocument model not available" };
    }
    if (!backup) {
      const id = clearCountId?.trim();
      if (!id) {
        return { ok: false, error: "clearCountId required to clear DB backup" };
      }
      await db.inventoryCountDocument.deleteMany({
        where: { shop, countId: pendingCompleteDbCountId(id) },
      });
      return { ok: true };
    }
    const docCountId = pendingCompleteDbCountId(backup.countId);
    const payloadStr = JSON.stringify(backup);
    await db.inventoryCountDocument.upsert({
      where: { shop_countId: { shop, countId: docCountId } },
      create: {
        shop,
        countId: docCountId,
        countName: null,
        status: "pending_complete_backup",
        locationId: null,
        locationName: null,
        payloadJson: payloadStr,
        version: 1,
        source: "db",
        completedAt: null,
      },
      update: {
        status: "pending_complete_backup",
        payloadJson: payloadStr,
        version: { increment: 1 },
        source: "db",
      },
    });
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[pending-complete] DB backup write failed:", msg);
    return { ok: false, error: msg };
  }
}

async function readPendingCompleteBackupDb(
  shop: string | undefined,
  countId: string | undefined
): Promise<PendingCompleteBackup | null> {
  if (!shop || !countId) return null;
  try {
    if (!db || typeof (db as { inventoryCountDocument?: unknown }).inventoryCountDocument === "undefined") {
      return null;
    }
    const doc = await db.inventoryCountDocument.findUnique({
      where: { shop_countId: { shop, countId: pendingCompleteDbCountId(countId) } },
      select: { payloadJson: true, status: true },
    });
    if (!doc?.payloadJson || doc.status !== "pending_complete_backup") return null;
    const parsed = JSON.parse(doc.payloadJson) as PendingCompleteBackup;
    if (!parsed?.countId || !Array.isArray(parsed.completedGroups)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * pending_complete_v1 を書く。成功/失敗を呼び出し元が判定できるようにする。
 * metafield 失敗時も shop があれば DB にフォールバック保存する。
 */
export async function writePendingCompleteBackup(
  admin: AdminGraphql,
  ownerId: string,
  backup: PendingCompleteBackup | null,
  opts?: { shop?: string; clearCountId?: string }
): Promise<WritePendingCompleteResult> {
  const value = backup ? JSON.stringify(backup) : "{}";
  const mutation = `#graphql mutation SetPendingComplete($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { message } }
  }`;
  let metafieldOk = false;
  let metafieldError: string | undefined;
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
      metafieldError = `HTTP ${resp.status}`;
      console.warn("[pending-complete] write failed:", metafieldError);
    } else {
      const json = (await resp.json().catch(() => ({}))) as {
        data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
        errors?: Array<{ message?: string }>;
      };
      const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
      if (json?.errors?.length) {
        metafieldError =
          json.errors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "GraphQL errors";
        console.warn("[pending-complete] write GraphQL errors:", metafieldError);
      } else if (userErrors.length > 0) {
        metafieldError =
          userErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "userErrors";
        console.warn("[pending-complete] write userErrors:", metafieldError);
      } else {
        metafieldOk = true;
      }
    }
  } catch (e: unknown) {
    metafieldError = e instanceof Error ? e.message : String(e);
    console.warn("[pending-complete] write failed:", metafieldError);
  }

  const dbResult = await writePendingCompleteBackupDb(
    opts?.shop,
    backup,
    backup ? undefined : opts?.clearCountId ?? undefined
  );
  const dbOk = dbResult.ok;
  // どちらか一方でも残れば Admin/POS retryOnly が動く
  const ok = metafieldOk || dbOk;
  return {
    ok,
    metafieldOk,
    dbOk,
    error: ok ? undefined : metafieldError || dbResult.error || "backup write failed",
  };
}

export async function readPendingCompleteBackup(
  admin: AdminGraphql,
  opts?: { shop?: string; countId?: string }
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
    if (raw && raw !== "{}") {
      const parsed = JSON.parse(raw) as PendingCompleteBackup;
      if (parsed?.countId && Array.isArray(parsed.completedGroups)) {
        if (
          !opts?.countId ||
          normalizeIdForMatch(parsed.countId) === normalizeIdForMatch(opts.countId)
        ) {
          return parsed;
        }
      }
    }
  } catch {
    // fall through to DB
  }
  return readPendingCompleteBackupDb(opts?.shop, opts?.countId);
}

/**
 * バックアップの completedGroups を metafield 棚卸にマージして書く。成功時バックアップを削除。
 */
export async function applyPendingCompleteFromBackup(
  admin: AdminGraphql,
  ownerId: string,
  backup: PendingCompleteBackup,
  opts?: { shop?: string }
): Promise<{
  ok: boolean;
  error?: string;
  countId: string;
  status?: "completed" | "in_progress";
  completedAt?: string;
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
    return next;
  });

  const { userErrors } = await writeInventoryCountsChunked(admin, updatedCounts, ownerId);
  if (userErrors.length > 0) {
    const message = userErrors.map((e) => e?.message ?? "").filter(Boolean).join(" / ") || "保存に失敗しました";
    return { ok: false, error: message, countId };
  }

  const clearResult = await writePendingCompleteBackup(admin, ownerId, null, {
    shop: opts?.shop,
    clearCountId: countId,
  });
  if (!clearResult.ok) {
    // メタ本体は更新済み。バックアップ削除失敗は Admin が誤って再試行必要と見なす程度のため非致命。
    console.warn("[pending-complete] clear backup after success failed:", clearResult.error);
  }
  return { ok: true, countId, status, completedAt };
}
