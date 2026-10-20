/**
 * 棚卸の 1 件ずつ保存（db_v2）。正本の切替（legacy / dual / db）、移し替え、照合、
 * メタフィールドへの書き写し（旧 POS 互換）を扱う。
 * 設計: docs/STOCKTAKE_PER_COUNT_STORAGE.md
 */
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import {
  readInventoryCountsChunked,
  writeInventoryCountsChunked,
  getInventoryCountsVersion,
  prepareCountsForWrite,
  type InventoryCount,
} from "../routes/app.inventory-count";
import { mergePendingCompleteIntoCounts, type MergeInventoryCount } from "./stocktake-pending-complete-merge";
import {
  assembleCount,
  compareCountSets,
  maxCountNameNumber,
  nextCountName,
  normalizeStocktakeId,
  reconcileLegacyIntoDb,
  resolveEffectiveMode,
  sortListNewestFirst,
  splitCount,
  toListEntry,
  type CountLike,
  type StocktakeStorageMode,
} from "./stocktake-count-store-logic";

export type { StocktakeStorageMode } from "./stocktake-count-store-logic";

type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};
type Tx = Prisma.TransactionClient;

const NS = "stock_transfer_pos";
const INVENTORY_COUNT_NEXT_KEY = "inventory_count_next_v1";
const SOURCE_V2 = "db_v2";
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 };
const MIRROR_DEBOUNCE_MS = 1500;
const MIRROR_CAS_MAX_ATTEMPTS = 3;
const LOG = "[stocktake-store]";

export const STOCKTAKE_VERSION_CONFLICT_MESSAGE =
  "他の操作でデータが更新されています。画面を再読み込みしてから再度お試しください。";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// モード
// ---------------------------------------------------------------------------

export async function getStorageState(shop: string) {
  return db.stocktakeStorageState.findUnique({ where: { shop } });
}

/** DB 未マイグレーション・接続失敗時は legacy（現行動作）に倒す */
export async function getEffectiveStorageMode(shop: string): Promise<StocktakeStorageMode> {
  const envMode = process.env.STOCKTAKE_STORAGE_MODE;
  if (!shop) return resolveEffectiveMode({ envMode: "legacy", override: null, backfilled: false });
  try {
    const state = await getStorageState(shop);
    return resolveEffectiveMode({
      envMode,
      override: state?.modeOverride ?? null,
      backfilled: Boolean(state?.backfilledAt),
    });
  } catch (e) {
    console.warn(LOG, "mode lookup failed, using legacy:", errMsg(e));
    return "legacy";
  }
}

async function upsertState(shop: string, data: Prisma.StocktakeStorageStateUpdateInput) {
  return db.stocktakeStorageState.upsert({
    where: { shop },
    create: { ...(data as Omit<Prisma.StocktakeStorageStateCreateInput, "shop">), shop },
    update: data,
  });
}

export async function setModeOverride(shop: string, mode: StocktakeStorageMode | null) {
  return upsertState(shop, { modeOverride: mode });
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

type DocWithRelations = {
  id: string;
  countId: string;
  status: string;
  countName: string | null;
  locationId: string | null;
  locationName: string | null;
  payloadJson: string | null;
  listJson: string | null;
  version: number;
  source: string;
  completedAt: Date | null;
  chunks: Array<{ chunkIndex: number; payload: string }>;
  groupResults: Array<{ groupId: string; groupKey: string; itemsJson: string }>;
};

export type DbCountRecord = { documentId: string; version: number; count: CountLike; format: "v2" | "legacy" };

function safeParse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function docToCount(doc: DocWithRelations): DbCountRecord {
  if (doc.source === SOURCE_V2) {
    const header = (safeParse(doc.payloadJson) as Record<string, unknown>) ?? {};
    const groups = [...doc.groupResults]
      .sort((a, b) => a.groupKey.localeCompare(b.groupKey))
      .map((g) => ({ groupId: g.groupId, items: (safeParse(g.itemsJson) as unknown[]) ?? [] }));
    const count = assembleCount({ ...header, id: header.id ?? doc.countId, status: doc.status }, groups);
    return { documentId: doc.id, version: doc.version, count, format: "v2" };
  }
  let payload = safeParse(doc.payloadJson);
  if (!payload && doc.chunks.length > 0) {
    payload = safeParse([...doc.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex).map((c) => c.payload).join(""));
  }
  const base = payload && typeof payload === "object" ? (payload as CountLike) : {};
  const count: CountLike = {
    ...base,
    id: (base.id as string | undefined) ?? doc.countId,
    status: doc.status,
    countName: base.countName ?? doc.countName,
    locationId: base.locationId ?? doc.locationId,
    locationName: base.locationName ?? doc.locationName,
  };
  return { documentId: doc.id, version: doc.version, count, format: "legacy" };
}

const DOC_INCLUDE = {
  chunks: { select: { chunkIndex: true, payload: true } },
  groupResults: { select: { groupId: true, groupKey: true, itemsJson: true } },
} as const;

export async function listDbCountsFull(shop: string, tx: Tx | typeof db = db): Promise<DbCountRecord[]> {
  const docs = (await tx.inventoryCountDocument.findMany({
    where: { shop },
    include: DOC_INCLUDE,
    orderBy: { createdAt: "asc" },
  })) as unknown as DocWithRelations[];
  return docs.map(docToCount);
}

/** 一覧用（作成日時の新しい順） */
export async function listDbCountsMinimal(shop: string): Promise<Record<string, unknown>[]> {
  const docs = await db.inventoryCountDocument.findMany({
    where: { shop },
    select: {
      id: true,
      countId: true,
      status: true,
      source: true,
      listJson: true,
      countName: true,
      locationId: true,
      locationName: true,
      completedAt: true,
    },
  });
  const legacyIds = docs.filter((d) => d.source !== SOURCE_V2 || !d.listJson).map((d) => d.id);
  const legacyFull = new Map<string, CountLike>();
  if (legacyIds.length > 0) {
    const full = (await db.inventoryCountDocument.findMany({
      where: { id: { in: legacyIds } },
      include: DOC_INCLUDE,
    })) as unknown as DocWithRelations[];
    for (const d of full) legacyFull.set(d.id, docToCount(d).count);
  }
  const list = docs.map((d) => {
    const fromList = d.source === SOURCE_V2 ? (safeParse(d.listJson) as Record<string, unknown> | null) : null;
    if (fromList) return { ...fromList, status: d.status };
    return toListEntry(legacyFull.get(d.id) ?? { id: d.countId, status: d.status, countName: d.countName, locationId: d.locationId });
  });
  return sortListNewestFirst(list);
}

async function findDocId(shop: string, countId: string, tx: Tx | typeof db = db): Promise<string | null> {
  const exact = await tx.inventoryCountDocument.findUnique({
    where: { shop_countId: { shop, countId: String(countId) } },
    select: { id: true },
  });
  if (exact) return exact.id;
  const n = normalizeStocktakeId(countId);
  const all = await tx.inventoryCountDocument.findMany({ where: { shop }, select: { id: true, countId: true } });
  return all.find((d) => normalizeStocktakeId(d.countId) === n)?.id ?? null;
}

export async function getDbCount(shop: string, countId: string, tx: Tx | typeof db = db): Promise<DbCountRecord | null> {
  const id = await findDocId(shop, countId, tx);
  if (!id) return null;
  const doc = (await tx.inventoryCountDocument.findUnique({
    where: { id },
    include: DOC_INCLUDE,
  })) as unknown as DocWithRelations | null;
  return doc ? docToCount(doc) : null;
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

class VersionConflictError extends Error {
  constructor(countId: string) {
    super(`${STOCKTAKE_VERSION_CONFLICT_MESSAGE} (count=${countId})`);
    this.name = "VersionConflictError";
  }
}

export function isVersionConflictError(e: unknown): boolean {
  return e instanceof VersionConflictError || (e instanceof Error && e.name === "VersionConflictError");
}

function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 1 棚卸を新形式で書く。existing があれば行版番号 CAS（expectedVersion 省略時は existing.version）。
 * 既存の旧形式チャンクは消し、グループ結果は渡された内容と完全一致させる。
 */
async function writeCountTx(
  tx: Tx,
  shop: string,
  count: CountLike,
  existing: { documentId: string; version: number } | null,
  expectedVersion?: number
): Promise<{ documentId: string; version: number }> {
  const split = splitCount(count);
  if (!split.countId) throw new Error("countId がありません");
  const status = String(count.status ?? "draft");
  const common = {
    countName: (count.countName as string | null | undefined) ?? null,
    status,
    locationId: (count.locationId as string | null | undefined) ?? null,
    locationName: (count.locationName as string | null | undefined) ?? null,
    payloadJson: JSON.stringify(split.header),
    listJson: JSON.stringify(split.list),
    source: SOURCE_V2,
    completedAt: toDate(count.completedAt),
  };

  let documentId: string;
  let version: number;
  if (existing) {
    const expected = expectedVersion ?? existing.version;
    const res = await tx.inventoryCountDocument.updateMany({
      where: { id: existing.documentId, version: expected },
      data: { ...common, version: { increment: 1 } },
    });
    if (res.count === 0) throw new VersionConflictError(split.countId);
    documentId = existing.documentId;
    version = expected + 1;
    await tx.inventoryCountDocumentChunk.deleteMany({ where: { documentId } });
  } else {
    const created = await tx.inventoryCountDocument.create({
      data: { shop, countId: split.countId, version: 1, ...common },
      select: { id: true },
    });
    documentId = created.id;
    version = 1;
  }

  const keys = split.groups.map((g) => g.groupKey);
  await tx.inventoryCountGroupResult.deleteMany({
    where: { documentId, ...(keys.length > 0 ? { groupKey: { notIn: keys } } : {}) },
  });
  for (const g of split.groups) {
    await tx.inventoryCountGroupResult.upsert({
      where: { documentId_groupKey: { documentId, groupKey: g.groupKey } },
      create: {
        documentId,
        shop,
        countId: split.countId,
        groupId: g.groupId,
        groupKey: g.groupKey,
        itemsJson: JSON.stringify(g.items),
      },
      update: { groupId: g.groupId, itemsJson: JSON.stringify(g.items), countId: split.countId },
    });
  }
  return { documentId, version };
}

async function lockDocument(tx: Tx, documentId: string) {
  await tx.$queryRaw`SELECT "id" FROM "InventoryCountDocument" WHERE "id" = ${documentId} FOR UPDATE`;
}

/**
 * 複数棚卸をまとめて保存（1 トランザクション）。expectedVersions は countId（正規化）→ 読み込み時の行版番号。
 * 版番号が無い棚卸は新規作成として扱い、既に存在すれば競合。
 */
export async function saveDbCounts(
  shop: string,
  counts: CountLike[],
  expectedVersions: Map<string, number>
): Promise<{ ok: true } | { ok: false; conflict: boolean; error: string }> {
  if (counts.length === 0) return { ok: true };
  try {
    await db.$transaction(async (tx) => {
      for (const c of counts) {
        const key = normalizeStocktakeId(c.id);
        const docId = await findDocId(shop, String(c.id ?? ""), tx);
        const expected = expectedVersions.get(key);
        if (docId) {
          if (expected == null) throw new VersionConflictError(key);
          await writeCountTx(tx, shop, c, { documentId: docId, version: expected }, expected);
        } else {
          await writeCountTx(tx, shop, c, null);
        }
      }
    }, TX_OPTS);
    return { ok: true };
  } catch (e) {
    if (isVersionConflictError(e)) {
      return { ok: false, conflict: true, error: STOCKTAKE_VERSION_CONFLICT_MESSAGE };
    }
    const code = (e as { code?: string })?.code;
    if (code === "P2002") return { ok: false, conflict: true, error: STOCKTAKE_VERSION_CONFLICT_MESSAGE };
    console.error(LOG, "saveDbCounts failed:", errMsg(e));
    return { ok: false, conflict: false, error: `棚卸の保存に失敗しました: ${errMsg(e)}` };
  }
}

/** dual: メタフィールド書き込み成功後に、変化した棚卸だけ DB を新形式で上書き（メタフィールドが正） */
export async function mirrorCountsToDbAfterLegacyWrite(shop: string, counts: CountLike[]): Promise<void> {
  if (!shop || counts.length === 0) return;
  for (const c of counts) {
    try {
      await db.$transaction(async (tx) => {
        const docId = await findDocId(shop, String(c.id ?? ""), tx);
        if (docId) {
          await lockDocument(tx, docId);
          const cur = await tx.inventoryCountDocument.findUnique({ where: { id: docId }, select: { version: true } });
          await writeCountTx(tx, shop, c, { documentId: docId, version: cur?.version ?? 1 });
        } else {
          await writeCountTx(tx, shop, c, null);
        }
      }, TX_OPTS);
    } catch (e) {
      console.warn(LOG, "dual-write skipped for", c.id, errMsg(e));
    }
  }
}

/** 棚卸ID発行（db）。番号はショップ単位のロック下で DB とメタフィールドの次番号の大きい方 */
export async function createDbCount(
  shop: string,
  newCount: CountLike,
  legacyNext: number | null
): Promise<{ ok: true; countName: string } | { ok: false; error: string }> {
  try {
    const countName = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stocktake:" + shop}))`;
      const names = await tx.inventoryCountDocument.findMany({ where: { shop }, select: { countName: true } });
      const name = nextCountName(
        names.map((n) => n.countName),
        legacyNext
      );
      await writeCountTx(tx, shop, { ...newCount, countName: name }, null);
      return name;
    }, TX_OPTS);
    return { ok: true, countName };
  } catch (e) {
    console.error(LOG, "createDbCount failed:", errMsg(e));
    return { ok: false, error: `棚卸IDの発行に失敗しました: ${errMsg(e)}` };
  }
}

/** POS の draft→in_progress（db）。既に in_progress 以上なら何もしない */
export async function startDbCount(shop: string, countId: string): Promise<CountLike | null> {
  return db.$transaction(async (tx) => {
    const docId = await findDocId(shop, countId, tx);
    if (!docId) return null;
    await lockDocument(tx, docId);
    const rec = await getDbCount(shop, countId, tx);
    if (!rec) return null;
    if (rec.count.status !== "draft") return rec.count;
    const next = { ...rec.count, status: "in_progress" };
    await writeCountTx(tx, shop, next, { documentId: rec.documentId, version: rec.version });
    return next;
  }, TX_OPTS);
}

export type CompletedGroupInput = {
  groupId: string;
  items: Array<{ inventoryItemId: string; currentQuantity: number; actualQuantity: number; variantId?: string; sku?: string; title?: string }>;
};

/**
 * 完了報告（db）。棚卸 1 行をロックし、そのグループの結果だけを書いて状態を再計算する。
 * Shopify API は呼ばない。
 */
export async function applyCompleteInDb(
  shop: string,
  countId: string,
  completedGroups: CompletedGroupInput[]
): Promise<
  | { ok: true; countId: string; status: "completed" | "in_progress"; completedAt?: string; savedCount: CountLike }
  | { ok: false; notFound?: boolean; error: string; countId: string }
> {
  try {
    return await db.$transaction(async (tx) => {
      const docId = await findDocId(shop, countId, tx);
      if (!docId) return { ok: false as const, notFound: true, error: "棚卸が見つかりません", countId };
      await lockDocument(tx, docId);
      const rec = await getDbCount(shop, countId, tx);
      if (!rec) return { ok: false as const, notFound: true, error: "棚卸が見つかりません", countId };
      const merged = mergePendingCompleteIntoCounts({
        inventoryCounts: [rec.count as MergeInventoryCount],
        countId,
        completedGroups,
      });
      if (!merged.savedCount) return { ok: false as const, notFound: true, error: "棚卸が見つかりません", countId };
      const [prepared] = prepareCountsForWrite(
        [merged.savedCount as unknown as InventoryCount],
        [rec.count as unknown as InventoryCount],
        { assignNames: false }
      );
      const saved = (prepared ?? merged.savedCount) as CountLike;
      await writeCountTx(tx, shop, saved, { documentId: rec.documentId, version: rec.version });
      const status = saved.status === "completed" ? "completed" : "in_progress";
      return {
        ok: true as const,
        countId: String(rec.count.id ?? countId),
        status,
        completedAt: (saved.completedAt as string | undefined) ?? undefined,
        savedCount: saved,
      };
    }, TX_OPTS);
  } catch (e) {
    console.error(LOG, "applyCompleteInDb failed:", errMsg(e));
    return { ok: false, error: `ステータスの反映に失敗しました: ${errMsg(e)}`, countId };
  }
}

// ---------------------------------------------------------------------------
// 確定の再試行バックアップ（棚卸ごと）
// ---------------------------------------------------------------------------

export type PendingCompleteDbBackup = { countId: string; completedGroups: CompletedGroupInput[]; savedAt: string };

export async function writePendingCompleteDb(shop: string, backup: PendingCompleteDbBackup): Promise<boolean> {
  try {
    await db.stocktakePendingComplete.upsert({
      where: { shop_countId: { shop, countId: String(backup.countId) } },
      create: { shop, countId: String(backup.countId), payloadJson: JSON.stringify(backup), savedAt: new Date() },
      update: { payloadJson: JSON.stringify(backup), savedAt: new Date() },
    });
    return true;
  } catch (e) {
    console.warn(LOG, "pending backup write failed:", errMsg(e));
    return false;
  }
}

export async function readPendingCompleteDb(shop: string, countId?: string | null): Promise<PendingCompleteDbBackup | null> {
  try {
    const rows = await db.stocktakePendingComplete.findMany({ where: { shop }, orderBy: { savedAt: "desc" } });
    const row = countId
      ? rows.find((r) => normalizeStocktakeId(r.countId) === normalizeStocktakeId(countId))
      : rows[0];
    if (!row) return null;
    const parsed = safeParse(row.payloadJson) as PendingCompleteDbBackup | null;
    if (!parsed?.countId || !Array.isArray(parsed.completedGroups)) return null;
    return parsed;
  } catch (e) {
    console.warn(LOG, "pending backup read failed:", errMsg(e));
    return null;
  }
}

export async function clearPendingCompleteDb(shop: string, countId: string): Promise<void> {
  try {
    const rows = await db.stocktakePendingComplete.findMany({ where: { shop }, select: { id: true, countId: true } });
    const ids = rows.filter((r) => normalizeStocktakeId(r.countId) === normalizeStocktakeId(countId)).map((r) => r.id);
    if (ids.length > 0) await db.stocktakePendingComplete.deleteMany({ where: { id: { in: ids } } });
  } catch (e) {
    console.warn(LOG, "pending backup clear failed:", errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// 移し替え・照合
// ---------------------------------------------------------------------------

/**
 * メタフィールドの棚卸を DB に取り込む。
 * overwrite: メタフィールドが正（legacy/dual）。conservative: DB が正（db）で旧 POS の書き込みだけ拾う。
 * 1 棚卸 1 トランザクション。DB にだけある棚卸は消さない。
 */
export async function ingestLegacyCounts(
  shop: string,
  legacyCounts: CountLike[],
  policy: "overwrite" | "conservative"
): Promise<{ inserted: number; updated: number; unchanged: number; failed: string[] }> {
  const result = { inserted: 0, updated: 0, unchanged: 0, failed: [] as string[] };
  for (const lg of legacyCounts) {
    const id = String(lg?.id ?? "");
    if (!id) continue;
    try {
      const outcome = await db.$transaction(async (tx) => {
        const docId = await findDocId(shop, id, tx);
        if (!docId) {
          await writeCountTx(tx, shop, lg, null);
          return "inserted" as const;
        }
        await lockDocument(tx, docId);
        const rec = await getDbCount(shop, id, tx);
        if (!rec) return "unchanged" as const;
        if (policy === "overwrite") {
          const same = rec.format === "v2" && compareCountSets([rec.count], [lg]).same === 1;
          if (same) return "unchanged" as const;
          await writeCountTx(tx, shop, { ...lg, id: rec.count.id ?? lg.id }, { documentId: rec.documentId, version: rec.version });
          return "updated" as const;
        }
        const { next, changed } = reconcileLegacyIntoDb(rec.count, lg);
        if (!changed && rec.format === "v2") return "unchanged" as const;
        await writeCountTx(tx, shop, next, { documentId: rec.documentId, version: rec.version });
        return "updated" as const;
      }, TX_OPTS);
      result[outcome] += 1;
    } catch (e) {
      console.warn(LOG, "ingest failed for", id, errMsg(e));
      result.failed.push(id);
    }
  }
  return result;
}

export async function backfillFromLegacy(
  shop: string,
  admin: AdminGraphql
): Promise<{ ok: boolean; error?: string; total: number; inserted: number; updated: number; unchanged: number; failed: string[]; legacyVersion: number }> {
  const mode = await getEffectiveStorageMode(shop);
  const legacyVersion = await getInventoryCountsVersion(admin);
  const legacy = (await readInventoryCountsChunked(admin)) as unknown as CountLike[];
  const r = await ingestLegacyCounts(shop, legacy, mode === "db" ? "conservative" : "overwrite");
  const ok = r.failed.length === 0;
  if (ok) {
    await upsertState(shop, {
      backfilledAt: new Date(),
      backfillLegacyVersion: legacyVersion,
      ...(mode === "db" ? {} : { mirroredLegacyVersion: legacyVersion }),
      lastError: null,
    });
  }
  return { ok, error: ok ? undefined : `取り込みに失敗した棚卸があります: ${r.failed.join(", ")}`, total: legacy.length, ...r, legacyVersion };
}

export async function verifyAgainstLegacy(shop: string, admin: AdminGraphql) {
  const legacy = (await readInventoryCountsChunked(admin)) as unknown as CountLike[];
  const dbCounts = (await listDbCountsFull(shop)).map((r) => r.count);
  return { ...compareCountSets(dbCounts, legacy), dbTotal: dbCounts.length, legacyTotal: legacy.length };
}

// ---------------------------------------------------------------------------
// メタフィールドへの書き写し（db モード・旧 POS 互換）
// ---------------------------------------------------------------------------

export async function markMirrorDirty(shop: string): Promise<void> {
  try {
    await db.stocktakeStorageState.upsert({
      where: { shop },
      create: { shop, mirrorDirty: true, mirrorSeq: 1 },
      update: { mirrorDirty: true, mirrorSeq: { increment: 1 } },
    });
  } catch (e) {
    console.warn(LOG, "markMirrorDirty failed:", errMsg(e));
  }
}

async function writeLegacyNextNumber(admin: AdminGraphql, ownerId: string, next: number) {
  const mutation = `#graphql mutation SetNext($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`;
  try {
    await admin.graphql(mutation, {
      variables: { metafields: [{ ownerId, namespace: NS, key: INVENTORY_COUNT_NEXT_KEY, type: "json", value: String(next) }] },
    });
  } catch (e) {
    console.warn(LOG, "next number write failed:", errMsg(e));
  }
}

export async function readLegacyNextNumber(admin: AdminGraphql): Promise<number | null> {
  try {
    const resp = await admin.graphql(
      `#graphql query NextKey { currentAppInstallation { metafield(namespace: "${NS}", key: "${INVENTORY_COUNT_NEXT_KEY}") { value } } }`
    );
    const json = (await resp.json().catch(() => ({}))) as { data?: { currentAppInstallation?: { metafield?: { value?: string } } } };
    const n = parseInt(String(json?.data?.currentAppInstallation?.metafield?.value ?? "").trim(), 10);
    return Number.isInteger(n) && n >= 1 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 1 回分の書き写し。旧 POS の書き込み（版番号の変化）を保守的に取り込んでから、DB の全件をそのまま書く。
 */
export async function runMirrorSync(
  shop: string,
  admin: AdminGraphql,
  ownerId: string
): Promise<{ ok: boolean; error?: string; ingested?: number; written?: number }> {
  const state = await getStorageState(shop);
  const seqAtStart = state?.mirrorSeq ?? 0;
  let lastError = "";
  for (let attempt = 1; attempt <= MIRROR_CAS_MAX_ATTEMPTS; attempt++) {
    try {
      const current = await getStorageState(shop);
      const v0 = await getInventoryCountsVersion(admin);
      let ingested = 0;
      if (current?.mirroredLegacyVersion == null || current.mirroredLegacyVersion !== v0) {
        const legacy = (await readInventoryCountsChunked(admin, { allowMissingChunksForRepair: true })) as unknown as CountLike[];
        const r = await ingestLegacyCounts(shop, legacy, "conservative");
        if (r.failed.length > 0) {
          lastError = `旧データの取り込みに失敗: ${r.failed.join(", ")}`;
          break;
        }
        ingested = r.inserted + r.updated;
        if (ingested > 0) console.warn(LOG, `ingested legacy writes shop=${shop} count=${ingested} legacyVersion=${v0}`);
        await upsertState(shop, { lastLegacyIngestAt: new Date() });
      }
      const dbCounts = (await listDbCountsFull(shop)).map((r) => r.count) as unknown as InventoryCount[];
      const { userErrors } = await writeInventoryCountsChunked(admin, dbCounts, ownerId, v0, { existingCounts: dbCounts });
      if (userErrors.length > 0) {
        lastError = userErrors.map((e) => e?.message ?? "").join(" / ");
        if (/他の操作でデータが更新されています/.test(lastError) && attempt < MIRROR_CAS_MAX_ATTEMPTS) continue;
        break;
      }
      await writeLegacyNextNumber(admin, ownerId, maxCountNameNumber(dbCounts.map((c) => c.countName)) + 1);
      const v1 = await getInventoryCountsVersion(admin);
      await db.stocktakeStorageState.update({
        where: { shop },
        data: { mirroredLegacyVersion: v1, mirroredAt: new Date(), lastError: null },
      });
      await db.stocktakeStorageState.updateMany({ where: { shop, mirrorSeq: seqAtStart }, data: { mirrorDirty: false } });
      return { ok: true, ingested, written: dbCounts.length };
    } catch (e) {
      lastError = errMsg(e);
      break;
    }
  }
  console.error(LOG, `mirror sync failed shop=${shop}:`, lastError);
  try {
    await upsertState(shop, { lastError: `mirror: ${lastError}`.slice(0, 1000) });
  } catch {
    // 状態の記録失敗は無視（印は残っているので次回再実行される）
  }
  return { ok: false, error: lastError };
}

type MirrorSlot = { running: boolean; rerun: boolean; timer: ReturnType<typeof setTimeout> | null; admin: AdminGraphql; ownerId: string };
const mirrorSlots = new Map<string, MirrorSlot>();

/** 応答とは切り離して書き写す。ショップごとに 1 本だけ走らせ、重なった依頼は 1 回の再実行にまとめる */
export function scheduleMirrorSync(shop: string, admin: AdminGraphql, ownerId: string, reason: string): void {
  if (!shop || !ownerId) return;
  let slot = mirrorSlots.get(shop);
  if (!slot) {
    slot = { running: false, rerun: false, timer: null, admin, ownerId };
    mirrorSlots.set(shop, slot);
  }
  slot.admin = admin;
  slot.ownerId = ownerId;
  if (slot.running) {
    slot.rerun = true;
    return;
  }
  if (slot.timer) return;
  const s = slot;
  s.timer = setTimeout(async () => {
    s.timer = null;
    s.running = true;
    try {
      do {
        s.rerun = false;
        const r = await runMirrorSync(shop, s.admin, s.ownerId);
        console.warn(LOG, `mirror sync shop=${shop} reason=${reason} ok=${r.ok}${r.error ? " error=" + r.error : ""}`);
        if (!r.ok) break;
      } while (s.rerun);
    } catch (e) {
      console.error(LOG, "mirror sync crashed:", errMsg(e));
    } finally {
      s.running = false;
    }
  }, MIRROR_DEBOUNCE_MS);
}

/** db モードで「書き写し待ち」か「旧 POS の書き込みあり」なら書き写しを予約する */
export async function ensureMirrorFresh(shop: string, admin: AdminGraphql, ownerId: string, reason: string): Promise<void> {
  try {
    const state = await getStorageState(shop);
    if (state?.mirrorDirty) {
      scheduleMirrorSync(shop, admin, ownerId, reason);
      return;
    }
    const v = await getInventoryCountsVersion(admin);
    if (state?.mirroredLegacyVersion == null || state.mirroredLegacyVersion !== v) {
      scheduleMirrorSync(shop, admin, ownerId, `${reason}:legacy-write`);
    }
  } catch (e) {
    console.warn(LOG, "ensureMirrorFresh failed:", errMsg(e));
  }
}

/** db → dual/legacy に戻す前に、DB の最新をメタフィールドへ同期で書き写す */
export async function switchMode(
  shop: string,
  admin: AdminGraphql,
  ownerId: string,
  target: StocktakeStorageMode,
  opts: { force?: boolean } = {}
): Promise<{ ok: boolean; error?: string; detail?: unknown }> {
  const current = await getEffectiveStorageMode(shop);
  if (target === "db") {
    const bf = await backfillFromLegacy(shop, admin);
    if (!bf.ok) return { ok: false, error: bf.error, detail: bf };
    const v = await verifyAgainstLegacy(shop, admin);
    if ((v.onlyInLegacy.length > 0 || v.different.length > 0) && !opts.force) {
      return { ok: false, error: "照合で差分があります。内容を確認してください。", detail: v };
    }
    await upsertState(shop, { modeOverride: "db", mirroredLegacyVersion: bf.legacyVersion, mirrorDirty: false });
    return { ok: true, detail: { backfill: bf, verify: v } };
  }
  if (current === "db") {
    const r = await runMirrorSync(shop, admin, ownerId);
    if (!r.ok && !opts.force) {
      return { ok: false, error: `メタフィールドへの書き写しに失敗したため切り替えません: ${r.error}` };
    }
  }
  await upsertState(shop, { modeOverride: target });
  return { ok: true };
}

export async function getStorageStatus(shop: string) {
  const [state, mode, docCount, v2Count, pendingCount] = await Promise.all([
    getStorageState(shop).catch(() => null),
    getEffectiveStorageMode(shop),
    db.inventoryCountDocument.count({ where: { shop } }).catch(() => 0),
    db.inventoryCountDocument.count({ where: { shop, source: SOURCE_V2 } }).catch(() => 0),
    db.stocktakePendingComplete.count({ where: { shop } }).catch(() => 0),
  ]);
  return {
    envMode: process.env.STOCKTAKE_STORAGE_MODE ?? null,
    effectiveMode: mode,
    state,
    documents: docCount,
    documentsV2: v2Count,
    pendingBackups: pendingCount,
  };
}
