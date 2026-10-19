/**
 * 棚卸明細の同一性（inventoryItemId 優先、なければ variantId）に関する純関数。
 * 追加読み込み・下書き復元・確定時の重複除去と、スナップショット ID の未読込判定に使う。
 * Shopify / storage に依存しない（node:test で検証: tests/stocktake-line-identity.test.mjs）。
 */

/** GID と数値 ID を同一視するため末尾セグメントに正規化する */
export function normalizeStocktakeId(id) {
  const s = String(id ?? "").trim();
  if (!s) return "";
  return s.split("/").pop() || s;
}

/**
 * 行の同一性キー。キーを作れない行は "" を返す（重複除去の対象外）。
 * scopeByGroup: まとめて表示で、別グループの同一商品を別行として扱う場合に true。
 */
export function lineIdentityKey(line, { scopeByGroup = false } = {}) {
  if (!line || typeof line !== "object") return "";
  const inv = normalizeStocktakeId(line.inventoryItemId);
  const variant = normalizeStocktakeId(line.variantId);
  const base = inv ? `i:${inv}` : variant ? `v:${variant}` : "";
  if (!base) return "";
  if (!scopeByGroup) return base;
  return `${normalizeStocktakeId(line.productGroupId)}|${base}`;
}

function toFiniteNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mergeDuplicateLine(kept, dup) {
  const merged = { ...kept };
  const a = toFiniteNumber(kept.actualQuantity);
  const b = toFiniteNumber(dup.actualQuantity);
  // スキャンは一致する全行を同じ値に更新するため、合算せず max を採用する
  if (a === null) merged.actualQuantity = dup.actualQuantity;
  else if (b !== null && b > a) merged.actualQuantity = b;
  if (kept.stockLoading && !dup.stockLoading) {
    merged.currentQuantity = dup.currentQuantity;
    merged.stockLoading = dup.stockLoading;
    merged.stockError = dup.stockError;
  }
  if (kept.isExtra && !dup.isExtra) merged.isExtra = false;
  for (const k of ["inventoryItemId", "variantId", "sku", "barcode", "imageUrl", "productTitle", "variantTitle"]) {
    if ((merged[k] === null || merged[k] === undefined || merged[k] === "") && dup[k]) merged[k] = dup[k];
  }
  return merged;
}

/**
 * 同一性キーで重複行を1行にまとめる。先頭の行（位置・id）を残し、実数は max。
 * @returns {{ lines: object[], mergedCount: number }}
 */
export function dedupeLinesByIdentity(lines, opts = {}) {
  const src = Array.isArray(lines) ? lines : [];
  const out = [];
  const indexByKey = new Map();
  let mergedCount = 0;
  for (const line of src) {
    const key = lineIdentityKey(line, opts);
    if (!key) {
      out.push(line);
      continue;
    }
    const idx = indexByKey.get(key);
    if (idx === undefined) {
      indexByKey.set(key, out.length);
      out.push(line);
      continue;
    }
    out[idx] = mergeDuplicateLine(out[idx], line);
    mergedCount++;
  }
  return { lines: mergedCount > 0 ? out : src, mergedCount };
}

/** 既存行と同一性キーが重ならない incoming 行だけを末尾に追加する（incoming 内の重複も除く） */
export function appendUniqueLines(prev, incoming, opts = {}) {
  const base = Array.isArray(prev) ? prev : [];
  const add = Array.isArray(incoming) ? incoming : [];
  const seen = new Set(base.map((l) => lineIdentityKey(l, opts)).filter(Boolean));
  const accepted = [];
  for (const line of add) {
    const key = lineIdentityKey(line, opts);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    accepted.push(line);
  }
  return { lines: accepted.length > 0 ? [...base, ...accepted] : base, added: accepted, skippedCount: add.length - accepted.length };
}

/** 行の inventoryItemId（正規化済み）の Set */
export function collectInventoryItemIdSet(lines) {
  const set = new Set();
  for (const l of Array.isArray(lines) ? lines : []) {
    const n = normalizeStocktakeId(l?.inventoryItemId);
    if (n) set.add(n);
  }
  return set;
}

/** 正規化済み ID の Set を作る（配列・Set・undefined を受け付ける） */
export function toNormalizedIdSet(ids) {
  const set = new Set();
  if (!ids) return set;
  for (const id of ids) {
    const n = normalizeStocktakeId(id);
    if (n) set.add(n);
  }
  return set;
}

/**
 * スナップショット ID のうち、未読込（exclude に無い）ものを元の順・元の表記で重複なく返す。
 * excludeSet は正規化済み ID の Set（表示済み・解決不能・取得失敗）。
 */
export function pendingSnapshotIds(snapshotIds, excludeSet) {
  const out = [];
  const seen = new Set();
  const exclude = excludeSet instanceof Set ? excludeSet : toNormalizedIdSet(excludeSet);
  for (const id of Array.isArray(snapshotIds) ? snapshotIds : []) {
    const n = normalizeStocktakeId(id);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (exclude.has(n)) continue;
    out.push(id);
  }
  return out;
}

/** inventoryItemIdsByGroup から groupId（GID/数値混在可）の配列を引く */
export function findSnapshotIdsForGroup(inventoryItemIdsByGroup, groupId) {
  if (!inventoryItemIdsByGroup || typeof inventoryItemIdsByGroup !== "object" || !groupId) return undefined;
  if (Array.isArray(inventoryItemIdsByGroup[groupId])) return inventoryItemIdsByGroup[groupId];
  const n = normalizeStocktakeId(groupId);
  const key = Object.keys(inventoryItemIdsByGroup).find((k) => normalizeStocktakeId(k) === n);
  return key && Array.isArray(inventoryItemIdsByGroup[key]) ? inventoryItemIdsByGroup[key] : undefined;
}

/**
 * 集合差（スナップショット一意 ID − exclude）が1件以上あるグループがあるか。
 * スナップショットが無いグループは判定対象外（false 扱い）。
 */
export function hasPendingSnapshotIds(inventoryItemIdsByGroup, groupIds, excludeSet) {
  for (const gid of Array.isArray(groupIds) ? groupIds : []) {
    const ids = findSnapshotIdsForGroup(inventoryItemIdsByGroup, gid);
    if (ids && pendingSnapshotIds(ids, excludeSet).length > 0) return true;
  }
  return false;
}

/**
 * apply-change 用 entries を inventoryItemId ごとに1件にする（同一品目への二重 setQuantities 防止）。
 * quantityAfter は max（下書き正規化と同じ規則）、quantityBefore は先頭の値。
 * @returns {{ entries: object[], duplicateCount: number, conflictCount: number }}
 */
export function dedupeAdjustEntries(entries) {
  const src = Array.isArray(entries) ? entries : [];
  const out = [];
  const indexByKey = new Map();
  let duplicateCount = 0;
  let conflictCount = 0;
  for (const e of src) {
    const key = normalizeStocktakeId(e?.inventoryItemId);
    if (!key) {
      out.push(e);
      continue;
    }
    const idx = indexByKey.get(key);
    if (idx === undefined) {
      indexByKey.set(key, out.length);
      out.push(e);
      continue;
    }
    duplicateCount++;
    const kept = out[idx];
    if (Number(kept.quantityAfter) !== Number(e.quantityAfter)) {
      conflictCount++;
      if (Number(e.quantityAfter) > Number(kept.quantityAfter)) out[idx] = { ...kept, quantityAfter: e.quantityAfter };
    }
  }
  return { entries: out, duplicateCount, conflictCount };
}
