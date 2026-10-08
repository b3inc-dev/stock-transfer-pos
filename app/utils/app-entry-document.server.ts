/**
 * loss / adjustment / purchase / order_request エントリの DB SoT。
 * POS v2 チャンク相当を 1 行 1 エントリで保持。
 */
import db from "../db.server";
import { preferDbSot, type AppEntryType } from "./metafield-db-sot";

export type AppEntryLike = {
  id?: string;
  status?: string;
  locationId?: string;
  lossName?: string;
  adjustmentName?: string;
  purchaseName?: string;
  orderName?: string;
  name?: string;
  createdAt?: string;
  [key: string]: unknown;
};

function modelReady(): boolean {
  return Boolean(db && typeof (db as { appEntryDocument?: unknown }).appEntryDocument !== "undefined");
}

function entryName(entry: AppEntryLike, entryType: AppEntryType): string | null {
  if (entryType === "loss") return entry.lossName != null ? String(entry.lossName) : null;
  if (entryType === "adjustment") return entry.adjustmentName != null ? String(entry.adjustmentName) : null;
  if (entryType === "purchase") return entry.purchaseName != null ? String(entry.purchaseName) : null;
  if (entryType === "order_request") {
    return entry.orderName != null
      ? String(entry.orderName)
      : entry.name != null
        ? String(entry.name)
        : null;
  }
  return null;
}

export async function replaceEntriesForShop(
  shop: string,
  entryType: AppEntryType,
  entries: AppEntryLike[]
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    if (!modelReady()) return { ok: false, count: 0, error: "AppEntryDocument model not available" };
    const list = Array.isArray(entries) ? entries : [];
    const keepIds = new Set<string>();

    for (const entry of list) {
      const entryId = String(entry?.id ?? "").trim();
      if (!entryId) continue;
      keepIds.add(entryId);
      const payloadJson = JSON.stringify(entry);
      await db.appEntryDocument.upsert({
        where: { shop_entryType_entryId: { shop, entryType, entryId } },
        create: {
          shop,
          entryType,
          entryId,
          status: entry.status != null ? String(entry.status) : null,
          name: entryName(entry, entryType),
          locationId: entry.locationId != null ? String(entry.locationId) : null,
          payloadJson,
          version: 1,
          source: "db",
        },
        update: {
          status: entry.status != null ? String(entry.status) : null,
          name: entryName(entry, entryType),
          locationId: entry.locationId != null ? String(entry.locationId) : null,
          payloadJson,
          version: { increment: 1 },
          source: "db",
        },
      });
    }

    const existing = await db.appEntryDocument.findMany({
      where: { shop, entryType },
      select: { entryId: true },
    });
    const toDelete = existing
      .map((e: { entryId: string }) => e.entryId)
      .filter((id: string) => !keepIds.has(id));
    if (toDelete.length > 0) {
      await db.appEntryDocument.deleteMany({
        where: { shop, entryType, entryId: { in: toDelete } },
      });
    }

    return { ok: true, count: keepIds.size };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[app-entry-document] replace ${entryType} failed:`, msg);
    return { ok: false, count: 0, error: msg };
  }
}

export async function upsertAppEntryDocument(
  shop: string,
  entryType: AppEntryType,
  entry: AppEntryLike
): Promise<{ ok: boolean; error?: string }> {
  const entryId = String(entry?.id ?? "").trim();
  if (!entryId) return { ok: false, error: "missing entry id" };
  try {
    if (!modelReady()) return { ok: false, error: "AppEntryDocument model not available" };
    const payloadJson = JSON.stringify(entry);
    await db.appEntryDocument.upsert({
      where: { shop_entryType_entryId: { shop, entryType, entryId } },
      create: {
        shop,
        entryType,
        entryId,
        status: entry.status != null ? String(entry.status) : null,
        name: entryName(entry, entryType),
        locationId: entry.locationId != null ? String(entry.locationId) : null,
        payloadJson,
        version: 1,
        source: "db",
      },
      update: {
        status: entry.status != null ? String(entry.status) : null,
        name: entryName(entry, entryType),
        locationId: entry.locationId != null ? String(entry.locationId) : null,
        payloadJson,
        version: { increment: 1 },
        source: "db",
      },
    });
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[app-entry-document] upsert ${entryType} failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function listEntriesFromDb(
  shop: string,
  entryType: AppEntryType,
  opts?: { take?: number; skip?: number }
): Promise<AppEntryLike[]> {
  try {
    if (!modelReady()) return [];
    const docs = await db.appEntryDocument.findMany({
      where: { shop, entryType },
      orderBy: { createdAt: "desc" },
      take: opts?.take ?? 5000,
      skip: opts?.skip ?? 0,
    });
    const out: AppEntryLike[] = [];
    for (const doc of docs) {
      if (!doc.payloadJson) {
        out.push({ id: doc.entryId, status: doc.status ?? undefined });
        continue;
      }
      try {
        const parsed = JSON.parse(doc.payloadJson);
        if (parsed && typeof parsed === "object") {
          out.push({ ...parsed, id: doc.entryId });
        }
      } catch {
        out.push({ id: doc.entryId, status: doc.status ?? undefined });
      }
    }
    return out;
  } catch (e: unknown) {
    console.warn(
      `[app-entry-document] list ${entryType} failed:`,
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

export async function countEntriesFromDb(shop: string, entryType: AppEntryType): Promise<number> {
  try {
    if (!modelReady()) return 0;
    return await db.appEntryDocument.count({ where: { shop, entryType } });
  } catch {
    return 0;
  }
}

/** DB 優先。DB が空なら metafield 配列を返す。 */
export async function preferEntriesFromDb(
  shop: string,
  entryType: AppEntryType,
  metafieldEntries: AppEntryLike[]
): Promise<AppEntryLike[]> {
  if (!preferDbSot("entries")) {
    return Array.isArray(metafieldEntries) ? metafieldEntries : [];
  }
  const n = await countEntriesFromDb(shop, entryType);
  if (n > 0) return listEntriesFromDb(shop, entryType);
  return Array.isArray(metafieldEntries) ? metafieldEntries : [];
}
