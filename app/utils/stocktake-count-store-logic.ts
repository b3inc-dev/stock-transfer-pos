/**
 * 棚卸 1 件ずつ保存（db_v2）の純粋ロジック。Prisma / ルートを import しない（node:test 用）。
 */

export type StocktakeStorageMode = "legacy" | "dual" | "db";

export type CountLike = {
  id?: string;
  countName?: string | null;
  locationId?: string | null;
  locationName?: string | null;
  status?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  productGroupId?: string | null;
  productGroupIds?: string[] | null;
  productGroupNames?: string[] | null;
  cancelledGroupIds?: string[] | null;
  groupItems?: Record<string, unknown[]> | null;
  [key: string]: unknown;
};

export type GroupResultRow = { groupId: string; groupKey: string; items: unknown[] };

export type SplitCount = {
  countId: string;
  header: Record<string, unknown>;
  groups: GroupResultRow[];
  list: Record<string, unknown>;
};

export function normalizeStocktakeId(id: unknown): string {
  const s = String(id ?? "").trim();
  return s.split("/").pop() || s;
}

export function parseStorageMode(raw: unknown): StocktakeStorageMode | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "legacy" || s === "dual" || s === "db") return s;
  return null;
}

/**
 * 実効モード。db は移し替え（backfill）済みのショップでだけ有効にし、未完了なら dual に落とす。
 */
export function resolveEffectiveMode(args: {
  envMode: unknown;
  override: unknown;
  backfilled: boolean;
}): StocktakeStorageMode {
  const requested = parseStorageMode(args.override) ?? parseStorageMode(args.envMode) ?? "legacy";
  if (requested === "db" && !args.backfilled) return "dual";
  return requested;
}

/** 一覧用の軽量版（メタフィールド inventory_counts_list_v1 の要素と同じ形） */
export function toListEntry(c: CountLike): Record<string, unknown> {
  const productGroupIds = Array.isArray(c.productGroupIds)
    ? c.productGroupIds
    : c.productGroupId
      ? [c.productGroupId]
      : [];
  const out: Record<string, unknown> = {
    id: c.id,
    locationId: c.locationId,
    status: c.status,
    countName: c.countName,
    createdAt: c.createdAt,
    productGroupIds,
  };
  if (Array.isArray(c.productGroupNames)) out.productGroupNames = c.productGroupNames;
  if (Array.isArray(c.cancelledGroupIds)) out.cancelledGroupIds = c.cancelledGroupIds;
  if (c.locationName) out.locationName = c.locationName;
  if (c.completedAt) out.completedAt = c.completedAt;
  return out;
}

/** 棚卸 1 件を「本文（groupItems 以外）」と「グループ結果」に分ける */
export function splitCount(count: CountLike): SplitCount {
  const countId = String(count.id ?? "");
  const { groupItems, ...rest } = count;
  const groups: GroupResultRow[] = [];
  const seen = new Set<string>();
  if (groupItems && typeof groupItems === "object") {
    for (const [groupId, items] of Object.entries(groupItems)) {
      const groupKey = normalizeStocktakeId(groupId);
      if (!groupKey || seen.has(groupKey)) continue;
      seen.add(groupKey);
      groups.push({ groupId, groupKey, items: Array.isArray(items) ? items : [] });
    }
  }
  return { countId, header: rest, groups, list: toListEntry(count) };
}

/** splitCount の逆。グループ結果が無ければ groupItems を付けない（元データと同じ形に戻す） */
export function assembleCount(
  header: Record<string, unknown>,
  groups: Array<{ groupId: string; items: unknown[] }>
): CountLike {
  const out: CountLike = { ...(header as CountLike) };
  if (groups.length > 0) {
    const groupItems: Record<string, unknown[]> = {};
    for (const g of groups) groupItems[g.groupId] = Array.isArray(g.items) ? g.items : [];
    out.groupItems = groupItems;
  }
  return out;
}

const STATUS_RANK: Record<string, number> = { draft: 0, in_progress: 1, completed: 2 };

function isTerminal(status: unknown): boolean {
  return status === "completed" || status === "cancelled";
}

function hasNonEmptyItems(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

function findGroupKey(map: Record<string, unknown[]>, groupId: string): string | undefined {
  const n = normalizeStocktakeId(groupId);
  return Object.keys(map).find((k) => normalizeStocktakeId(k) === n);
}

/**
 * 旧 POS / 旧サーバーがメタフィールドへ書いた棚卸を、DB の棚卸へ保守的に取り込む。
 * - DB に無い → そのまま追加
 * - 状態は上げる方向だけ（completed / cancelled は下げない）
 * - 番号・ロケーション等は DB が空のときだけ補う
 * - グループ結果は DB が空のグループだけ補う（DB の確定結果は上書きしない）
 */
export function reconcileLegacyIntoDb(
  dbCount: CountLike | null,
  legacyCount: CountLike
): { next: CountLike; changed: boolean } {
  if (!dbCount) return { next: { ...legacyCount }, changed: true };
  const next: CountLike = { ...dbCount };
  let changed = false;

  const fillIfBlank = (key: keyof CountLike) => {
    const cur = next[key];
    const blank = cur == null || (typeof cur === "string" && cur.trim() === "") || (Array.isArray(cur) && cur.length === 0);
    const val = legacyCount[key];
    const valBlank = val == null || (typeof val === "string" && val.trim() === "") || (Array.isArray(val) && val.length === 0);
    if (blank && !valBlank) {
      (next as Record<string, unknown>)[key as string] = val;
      changed = true;
    }
  };
  fillIfBlank("countName");
  fillIfBlank("locationId");
  fillIfBlank("locationName");
  fillIfBlank("productGroupIds");
  fillIfBlank("productGroupNames");

  const dbStatus = String(dbCount.status ?? "");
  const lgStatus = String(legacyCount.status ?? "");
  if (!isTerminal(dbStatus) && lgStatus && lgStatus !== dbStatus) {
    if (lgStatus === "cancelled") {
      next.status = "cancelled";
      changed = true;
    } else if ((STATUS_RANK[lgStatus] ?? -1) > (STATUS_RANK[dbStatus] ?? -1)) {
      next.status = lgStatus;
      if (lgStatus === "completed" && legacyCount.completedAt && !next.completedAt) {
        next.completedAt = legacyCount.completedAt;
      }
      changed = true;
    }
  }

  const lgGroups = legacyCount.groupItems && typeof legacyCount.groupItems === "object" ? legacyCount.groupItems : {};
  const dbGroups: Record<string, unknown[]> =
    next.groupItems && typeof next.groupItems === "object" ? { ...next.groupItems } : {};
  let groupsChanged = false;
  for (const [gid, items] of Object.entries(lgGroups)) {
    if (!hasNonEmptyItems(items)) continue;
    const existingKey = findGroupKey(dbGroups, gid);
    if (existingKey != null && hasNonEmptyItems(dbGroups[existingKey])) continue;
    dbGroups[existingKey ?? gid] = items as unknown[];
    groupsChanged = true;
  }
  if (groupsChanged) {
    next.groupItems = dbGroups;
    changed = true;
  }

  const lgCancelled = Array.isArray(legacyCount.cancelledGroupIds) ? legacyCount.cancelledGroupIds : [];
  if (lgCancelled.length > 0) {
    const cur = Array.isArray(next.cancelledGroupIds) ? [...next.cancelledGroupIds] : [];
    const curSet = new Set(cur.map(normalizeStocktakeId));
    let added = false;
    for (const g of lgCancelled) {
      if (!curSet.has(normalizeStocktakeId(g))) {
        cur.push(g);
        curSet.add(normalizeStocktakeId(g));
        added = true;
      }
    }
    if (added) {
      next.cancelledGroupIds = cur;
      changed = true;
    }
  }

  return { next, changed };
}

function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function countsEqual(a: CountLike | null | undefined, b: CountLike | null | undefined): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

/** before → after で内容が変わった（または新規の）棚卸だけ返す。after に無い棚卸は対象外（削除しない） */
export function diffChangedCounts<T extends CountLike>(before: T[], after: T[]): T[] {
  const beforeById = new Map<string, T>();
  for (const c of before) {
    const id = normalizeStocktakeId(c?.id);
    if (id) beforeById.set(id, c);
  }
  const out: T[] = [];
  for (const c of after) {
    const id = normalizeStocktakeId(c?.id);
    if (!id) continue;
    const prev = beforeById.get(id);
    if (!prev || !countsEqual(prev, c)) out.push(c);
  }
  return out;
}

function parseCountNameNumber(countName: unknown): number {
  if (typeof countName !== "string") return 0;
  const m = countName.trim().match(/^#C0*(\d+)$/i);
  return m ? Math.max(0, parseInt(m[1], 10)) : 0;
}

/** 次の棚卸番号（#C0001 形式）。DB の最大番号と inventory_count_next_v1 の大きい方 */
export function nextCountName(existingNames: Array<string | null | undefined>, legacyNext: number | null): string {
  const maxDb = existingNames.reduce((max, n) => Math.max(max, parseCountNameNumber(n)), 0);
  const next = Math.max(maxDb + 1, legacyNext != null && Number.isInteger(legacyNext) && legacyNext >= 1 ? legacyNext : 1);
  return `#C${String(next).padStart(4, "0")}`;
}

export function maxCountNameNumber(names: Array<string | null | undefined>): number {
  return names.reduce((max, n) => Math.max(max, parseCountNameNumber(n)), 0);
}

/** 作成日時の新しい順（POS 一覧の並びと同じ） */
export function sortListNewestFirst<T extends { createdAt?: unknown }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => new Date(String(b.createdAt ?? 0)).getTime() - new Date(String(a.createdAt ?? 0)).getTime()
  );
}

/** 照合: DB と メタフィールドの差分（ID の欠落・内容差） */
export function compareCountSets(
  dbCounts: CountLike[],
  legacyCounts: CountLike[]
): { onlyInDb: string[]; onlyInLegacy: string[]; different: string[]; same: number } {
  const dbById = new Map(dbCounts.map((c) => [normalizeStocktakeId(c.id), c]));
  const lgById = new Map(legacyCounts.map((c) => [normalizeStocktakeId(c.id), c]));
  const onlyInDb: string[] = [];
  const onlyInLegacy: string[] = [];
  const different: string[] = [];
  let same = 0;
  for (const [id, c] of dbById) {
    if (!id) continue;
    const lg = lgById.get(id);
    if (!lg) onlyInDb.push(id);
    else if (!countsEqual(normalizeForCompare(c), normalizeForCompare(lg))) different.push(id);
    else same += 1;
  }
  for (const id of lgById.keys()) {
    if (id && !dbById.has(id)) onlyInLegacy.push(id);
  }
  return { onlyInDb, onlyInLegacy, different, same };
}

function normalizeForCompare(c: CountLike): CountLike {
  const { groupItems, ...rest } = c;
  const out: CountLike = { ...rest };
  for (const k of Object.keys(out)) if (k.startsWith("_")) delete (out as Record<string, unknown>)[k];
  if (groupItems && typeof groupItems === "object") {
    const g: Record<string, unknown[]> = {};
    for (const [k, v] of Object.entries(groupItems)) g[normalizeStocktakeId(k)] = v;
    out.groupItems = g;
  }
  return out;
}
