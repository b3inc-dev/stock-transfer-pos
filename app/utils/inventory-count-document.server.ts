/**
 * Phase F / R-META: 棚卸ドキュメントの DB 書き込み基盤。
 * metafield（inventory_counts_*）は移行期間のフォールバック SoT。
 * 失敗しても呼び出し側の metafield 成功を壊さない（best-effort）。
 * Admin「在庫変動履歴」は InventoryChangeLog のまま（本モジュール対象外）。
 */
import db from "../db.server";

const PAYLOAD_INLINE_MAX_CHARS = 100_000;

export type InventoryCountDocumentUpsertInput = {
  shop: string;
  countId: string;
  countName?: string | null;
  status: string;
  locationId?: string | null;
  locationName?: string | null;
  payload?: unknown;
  completedAt?: string | Date | null;
};

function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 1 棚卸ID分を DB に upsert。大きい payload は先頭チャンクに退避。
 * DB 未準備・例外時は false を返し throw しない。
 */
export async function upsertInventoryCountDocument(
  input: InventoryCountDocumentUpsertInput
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    if (!db || typeof (db as { inventoryCountDocument?: unknown }).inventoryCountDocument === "undefined") {
      return { ok: false, error: "InventoryCountDocument model not available" };
    }
    const payloadStr = input.payload != null ? JSON.stringify(input.payload) : null;
    const useInline = payloadStr != null && payloadStr.length <= PAYLOAD_INLINE_MAX_CHARS;
    const completedAt = toDate(input.completedAt ?? null);

    const doc = await db.inventoryCountDocument.upsert({
      where: { shop_countId: { shop: input.shop, countId: String(input.countId) } },
      create: {
        shop: input.shop,
        countId: String(input.countId),
        countName: input.countName ?? null,
        status: input.status,
        locationId: input.locationId ?? null,
        locationName: input.locationName ?? null,
        payloadJson: useInline ? payloadStr : null,
        version: 1,
        source: "db",
        completedAt,
      },
      update: {
        countName: input.countName ?? null,
        status: input.status,
        locationId: input.locationId ?? null,
        locationName: input.locationName ?? null,
        payloadJson: useInline ? payloadStr : null,
        version: { increment: 1 },
        source: "db",
        completedAt,
      },
    });

    if (payloadStr && !useInline) {
      await db.inventoryCountDocumentChunk.deleteMany({ where: { documentId: doc.id } });
      const chunkSize = PAYLOAD_INLINE_MAX_CHARS;
      let idx = 0;
      for (let offset = 0; offset < payloadStr.length; offset += chunkSize) {
        const slice = payloadStr.slice(offset, offset + chunkSize);
        await db.inventoryCountDocumentChunk.create({
          data: { documentId: doc.id, chunkIndex: idx, payload: slice },
        });
        idx += 1;
      }
    }

    return { ok: true, id: doc.id };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[inventory-count-document] upsert failed (metafield remains SoT):", msg);
    return { ok: false, error: msg };
  }
}

function parseDocPayload(doc: {
  payloadJson: string | null;
  chunks?: Array<{ payload: string }>;
}): unknown {
  if (doc.payloadJson) {
    try {
      return JSON.parse(doc.payloadJson);
    } catch {
      return doc.payloadJson;
    }
  }
  if (doc.chunks?.length) {
    const joined = doc.chunks.map((c) => c.payload).join("");
    try {
      return JSON.parse(joined);
    } catch {
      return joined;
    }
  }
  return null;
}

/**
 * DB 優先で 1 件読む。無ければ null（呼び出し側が metafield にフォールバック）。
 */
export async function readInventoryCountDocumentFromDb(
  shop: string,
  countId: string
): Promise<{ countId: string; status: string; payload: unknown; version: number } | null> {
  try {
    if (!db || typeof (db as { inventoryCountDocument?: unknown }).inventoryCountDocument === "undefined") {
      return null;
    }
    const doc = await db.inventoryCountDocument.findUnique({
      where: { shop_countId: { shop, countId: String(countId) } },
      include: { chunks: { orderBy: { chunkIndex: "asc" } } },
    });
    if (!doc) return null;
    return {
      countId: doc.countId,
      status: doc.status,
      payload: parseDocPayload(doc),
      version: doc.version,
    };
  } catch (e: unknown) {
    console.warn(
      "[inventory-count-document] read failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}

export type DbCountOverlay = {
  countId: string;
  status: string;
  countName?: string | null;
  locationId?: string | null;
  locationName?: string | null;
  payload: unknown;
  version: number;
  updatedAt: Date;
};

/** ショップの DB 棚卸ドキュメント一覧（dual-read 用） */
export async function listInventoryCountDocumentsForShop(shop: string): Promise<DbCountOverlay[]> {
  try {
    if (!db || typeof (db as { inventoryCountDocument?: unknown }).inventoryCountDocument === "undefined") {
      return [];
    }
    const docs = await db.inventoryCountDocument.findMany({
      where: { shop },
      include: { chunks: { orderBy: { chunkIndex: "asc" } } },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    return docs.map((doc: {
      countId: string;
      status: string;
      countName: string | null;
      locationId: string | null;
      locationName: string | null;
      payloadJson: string | null;
      version: number;
      updatedAt: Date;
      chunks: Array<{ payload: string }>;
    }) => ({
      countId: doc.countId,
      status: doc.status,
      countName: doc.countName,
      locationId: doc.locationId,
      locationName: doc.locationName,
      payload: parseDocPayload(doc),
      version: doc.version,
      updatedAt: doc.updatedAt,
    }));
  } catch (e: unknown) {
    console.warn(
      "[inventory-count-document] list failed:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

function normalizeCountId(id: unknown): string {
  const s = String(id ?? "").trim();
  return s.split("/").pop() || s;
}

/**
 * metafield 配列を正としつつ、DB に存在する count は payload（または status 等）で上書きする dual-read。
 * DB のみに存在する count は末尾に追加（metafield 未反映の確定成功分）。
 */
export async function mergeInventoryCountsWithDb<T extends { id?: string; status?: string }>(
  shop: string,
  metafieldCounts: T[]
): Promise<T[]> {
  const dbDocs = await listInventoryCountDocumentsForShop(shop);
  if (dbDocs.length === 0) return metafieldCounts;

  const byNorm = new Map<string, DbCountOverlay>();
  for (const d of dbDocs) {
    byNorm.set(normalizeCountId(d.countId), d);
  }

  const merged: T[] = metafieldCounts.map((c) => {
    const overlay = byNorm.get(normalizeCountId(c.id));
    if (!overlay) return c;
    byNorm.delete(normalizeCountId(c.id));
    if (overlay.payload && typeof overlay.payload === "object") {
      return {
        ...c,
        ...(overlay.payload as object),
        id: c.id,
        status: overlay.status || (overlay.payload as { status?: string }).status || c.status,
        _source: "db_overlay",
      } as T;
    }
    return {
      ...c,
      status: overlay.status || c.status,
      countName: overlay.countName ?? (c as { countName?: string }).countName,
      _source: "db_overlay",
    } as T;
  });

  for (const leftover of byNorm.values()) {
    if (leftover.payload && typeof leftover.payload === "object") {
      merged.push({
        ...(leftover.payload as object),
        id: leftover.countId,
        status: leftover.status,
        _source: "db_only",
      } as T);
    } else {
      merged.push({
        id: leftover.countId,
        status: leftover.status,
        countName: leftover.countName,
        locationId: leftover.locationId,
        locationName: leftover.locationName,
        _source: "db_only",
      } as T);
    }
  }

  return merged;
}
