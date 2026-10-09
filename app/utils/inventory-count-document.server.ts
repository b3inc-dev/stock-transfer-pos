/**
 * Phase F / R-META → staged cutover: 棚卸ドキュメントの DB SoT。
 * Admin/API は DB 優先読取。metafield は空 DB 時のフォールバック／任意ミラー。
 * Admin「在庫変動履歴」は InventoryChangeLog のまま（本モジュール対象外）。
 */
import db from "../db.server";
import { preferDbSot } from "./metafield-db-sot";

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
    console.warn("[inventory-count-document] upsert failed:", msg);
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
    const LIST_TAKE = 2000;
    const docs = await db.inventoryCountDocument.findMany({
      where: { shop },
      include: { chunks: { orderBy: { chunkIndex: "asc" } } },
      orderBy: { updatedAt: "desc" },
      take: LIST_TAKE,
    });
    if (docs.length >= LIST_TAKE) {
      console.warn(
        `[inventory-count-document] list truncated at ${LIST_TAKE} for shop=${shop}`
      );
    }
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

function overlayFromDbDoc<T extends { id?: string; status?: string }>(doc: DbCountOverlay): T {
  if (doc.payload && typeof doc.payload === "object") {
    return {
      ...(doc.payload as object),
      id: doc.countId,
      status: doc.status,
      _source: "db",
      _dbVersion: doc.version,
    } as T;
  }
  return {
    id: doc.countId,
    status: doc.status,
    countName: doc.countName,
    locationId: doc.locationId,
    locationName: doc.locationName,
    _source: "db",
    _dbVersion: doc.version,
  } as T;
}

/**
 * DB SoT 読取（段階移行後）:
 * - preferDbSot かつ DB に 1 件以上 → DB を正とし、metafield にだけある id を末尾フォールバック追加
 * - DB 空 → metafield をそのまま（未 migrate ショップ）
 * - preferDbSot=false → 旧 dual-read（metafield SoT + DB-only 末尾追加）
 */
export async function mergeInventoryCountsWithDb<T extends { id?: string; status?: string }>(
  shop: string,
  metafieldCounts: T[]
): Promise<T[]> {
  const dbDocs = await listInventoryCountDocumentsForShop(shop);
  const mf = Array.isArray(metafieldCounts) ? metafieldCounts : [];

  if (preferDbSot("inventory_counts") && dbDocs.length > 0) {
    const fromDb = dbDocs.map((d) => overlayFromDbDoc<T>(d));
    const seen = new Set(fromDb.map((c) => normalizeCountId(c.id)).filter(Boolean));
    const merged = [...fromDb];
    for (const c of mf) {
      const norm = normalizeCountId(c.id);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      merged.push({ ...c, _source: "metafield_fallback" } as T);
    }
    return merged;
  }

  if (dbDocs.length === 0) return mf;

  // legacy dual-read（緊急フォールバック METAFIELD_DB_SOT_INVENTORY_COUNTS=0）
  const seen = new Set(mf.map((c) => normalizeCountId(c.id)).filter(Boolean));
  const merged: T[] = [...mf];
  for (const leftover of dbDocs) {
    const norm = normalizeCountId(leftover.countId);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    merged.push(overlayFromDbDoc<T>(leftover));
  }
  return merged;
}

type CountLikeForUpsert = {
  id?: string;
  countName?: string | null;
  status?: string;
  locationId?: string | null;
  locationName?: string | null;
  completedAt?: string | null;
  _dbVersion?: number | null;
  [key: string]: unknown;
};

async function assertDbVersionIfPresent(
  shop: string,
  countId: string,
  expected: unknown
): Promise<{ ok: boolean; error?: string }> {
  if (expected == null || expected === "") return { ok: true };
  const n = Number(expected);
  if (!Number.isInteger(n) || n < 1) return { ok: true };
  try {
    const row = await db.inventoryCountDocument.findUnique({
      where: { shop_countId: { shop, countId } },
      select: { version: true },
    });
    if (!row) return { ok: true }; // 新規
    if (row.version !== n) {
      return {
        ok: false,
        error: `他の操作でデータが更新されています（${countId}: expected ${n}, got ${row.version}）`,
      };
    }
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 棚卸一覧を DB に全件 upsert（migrate / Admin persist）。削除はしない。1件失敗で ok:false。 */
export async function upsertInventoryCountsBulk(
  shop: string,
  counts: CountLikeForUpsert[]
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    let n = 0;
    const errors: string[] = [];
    for (const c of counts) {
      const countId = String(c?.id ?? "").trim();
      if (!countId) continue;
      const verCheck = await assertDbVersionIfPresent(shop, countId, c._dbVersion);
      if (!verCheck.ok) {
        errors.push(verCheck.error || `${countId}: version conflict`);
        continue;
      }
      const res = await upsertInventoryCountDocument({
        shop,
        countId,
        countName: c.countName ?? null,
        status: String(c.status || "draft"),
        locationId: c.locationId ?? null,
        locationName: c.locationName ?? null,
        payload: c,
        completedAt: c.completedAt ?? null,
      });
      if (res.ok) n += 1;
      else errors.push(`${countId}: ${res.error || "upsert failed"}`);
    }
    if (errors.length > 0) {
      return { ok: false, count: n, error: errors.slice(0, 5).join(" / ") };
    }
    return { ok: true, count: n };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, count: 0, error: msg };
  }
}

/**
 * POS/Admin の全件 replace: upsert 後、渡されなかった countId を削除。
 * 空配列での全消しは拒否（既存がある場合）。
 */
export async function replaceInventoryCountsForShop(
  shop: string,
  counts: CountLikeForUpsert[]
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    if (!db || typeof (db as { inventoryCountDocument?: unknown }).inventoryCountDocument === "undefined") {
      return { ok: false, count: 0, error: "InventoryCountDocument model not available" };
    }
    const list = Array.isArray(counts) ? counts : [];
    const keepIds = new Set<string>();
    for (const c of list) {
      const id = String(c?.id ?? "").trim();
      if (id) keepIds.add(id);
    }

    const existingCount = await db.inventoryCountDocument.count({ where: { shop } });
    if (keepIds.size === 0 && existingCount > 0) {
      return {
        ok: false,
        count: 0,
        error: "棚卸データを空にすることはできません。既存の棚卸IDが消えるため、空配列での上書きをブロックしました。",
      };
    }

    const upsertRes = await upsertInventoryCountsBulk(shop, list);
    if (!upsertRes.ok) return upsertRes;

    const existing = await db.inventoryCountDocument.findMany({
      where: { shop },
      select: { countId: true },
    });
    const toDelete = existing
      .map((e: { countId: string }) => e.countId)
      .filter((id: string) => !keepIds.has(id));
    if (toDelete.length > 0) {
      await db.inventoryCountDocument.deleteMany({
        where: { shop, countId: { in: toDelete } },
      });
    }
    return { ok: true, count: keepIds.size };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, count: 0, error: msg };
  }
}
