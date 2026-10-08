/**
 * 日次在庫スナップショット DB SoT（shop metafield inventory_info/daily_snapshots から移行）。
 */
import db from "../db.server";
import type { DailyInventorySnapshot, InventorySnapshotsData } from "./inventory-snapshot";
import { preferDbSot } from "./metafield-db-sot";

function modelReady(): boolean {
  return Boolean(
    db && typeof (db as { inventoryDailySnapshotRow?: unknown }).inventoryDailySnapshotRow !== "undefined"
  );
}

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function listDailySnapshotsFromDb(shop: string): Promise<DailyInventorySnapshot[]> {
  try {
    if (!modelReady()) return [];
    const rows = await db.inventoryDailySnapshotRow.findMany({
      where: { shop },
      orderBy: [{ date: "desc" }, { locationId: "asc" }],
      take: 50_000,
    });
    return rows.map(
      (r: {
        date: string;
        locationId: string;
        locationName: string | null;
        totalQuantity: number;
        totalRetailValue: number;
        totalCompareAtPriceValue: number;
        totalCostValue: number;
        snapshotUpdatedAt: Date | null;
      }) => ({
        date: r.date,
        locationId: r.locationId,
        locationName: r.locationName ?? "",
        totalQuantity: r.totalQuantity,
        totalRetailValue: r.totalRetailValue,
        totalCompareAtPriceValue: r.totalCompareAtPriceValue,
        totalCostValue: r.totalCostValue,
        updatedAt: r.snapshotUpdatedAt ? r.snapshotUpdatedAt.toISOString() : undefined,
      })
    );
  } catch (e: unknown) {
    console.warn(
      "[inventory-daily-snapshot] list failed:",
      e instanceof Error ? e.message : String(e)
    );
    return [];
  }
}

export async function replaceDailySnapshotsForDate(
  shop: string,
  dateToReplace: string,
  snapshots: DailyInventorySnapshot[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!modelReady()) return { ok: false, error: "InventoryDailySnapshotRow model not available" };
    await db.inventoryDailySnapshotRow.deleteMany({
      where: { shop, date: dateToReplace },
    });
    for (const s of snapshots) {
      if (!s?.locationId || s.date !== dateToReplace) continue;
      await db.inventoryDailySnapshotRow.create({
        data: {
          shop,
          date: s.date,
          locationId: String(s.locationId),
          locationName: s.locationName ?? null,
          totalQuantity: Number(s.totalQuantity) || 0,
          totalRetailValue: Number(s.totalRetailValue) || 0,
          totalCompareAtPriceValue: Number(s.totalCompareAtPriceValue) || 0,
          totalCostValue: Number(s.totalCostValue) || 0,
          snapshotUpdatedAt: toDate(s.updatedAt ?? null),
        },
      });
    }
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[inventory-daily-snapshot] replace date failed:", msg);
    return { ok: false, error: msg };
  }
}

/** 全件置換（migrate 用） */
export async function replaceAllDailySnapshots(
  shop: string,
  snapshots: DailyInventorySnapshot[]
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    if (!modelReady()) return { ok: false, count: 0, error: "InventoryDailySnapshotRow model not available" };
    await db.inventoryDailySnapshotRow.deleteMany({ where: { shop } });
    let count = 0;
    for (const s of snapshots) {
      if (!s?.date || !s?.locationId) continue;
      await db.inventoryDailySnapshotRow.create({
        data: {
          shop,
          date: s.date,
          locationId: String(s.locationId),
          locationName: s.locationName ?? null,
          totalQuantity: Number(s.totalQuantity) || 0,
          totalRetailValue: Number(s.totalRetailValue) || 0,
          totalCompareAtPriceValue: Number(s.totalCompareAtPriceValue) || 0,
          totalCostValue: Number(s.totalCostValue) || 0,
          snapshotUpdatedAt: toDate(s.updatedAt ?? null),
        },
      });
      count += 1;
    }
    return { ok: true, count };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[inventory-daily-snapshot] replace all failed:", msg);
    return { ok: false, count: 0, error: msg };
  }
}

export async function preferDailySnapshotsFromDb(
  shop: string,
  metafieldData: InventorySnapshotsData
): Promise<InventorySnapshotsData> {
  if (!preferDbSot("daily_snapshots")) {
    return metafieldData?.version === 1 && Array.isArray(metafieldData.snapshots)
      ? metafieldData
      : { version: 1, snapshots: [] };
  }
  const fromDb = await listDailySnapshotsFromDb(shop);
  if (fromDb.length > 0) return { version: 1, snapshots: fromDb };
  return metafieldData?.version === 1 && Array.isArray(metafieldData.snapshots)
    ? metafieldData
    : { version: 1, snapshots: [] };
}
