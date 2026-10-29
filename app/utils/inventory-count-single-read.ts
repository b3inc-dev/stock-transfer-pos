/**
 * 棚卸 1 件だけを inventory_counts_v1_c* チャンクから取り出すための純粋ロジック。
 * 管理画面 get_count_full で全チャンク読込を避けるために使う（取得はルート側、判定はここ）。
 */

export type CountPartLike = {
  _part: true;
  countId: string;
  partIndex: number;
  totalParts: number;
};

export type SingleCountLookup<T> =
  | { status: "found"; count: T }
  | { status: "not_found" }
  /** パート欠落・ID 表記揺れなどで確定できない。呼び出し側は全件読込にフォールバックする */
  | { status: "incomplete" };

/** inventory_count_index_v1（countId → チャンク番号配列）をパースする。不正なら null */
export function parseCountChunkIndex(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * インデックスから countId のチャンク番号を引く。
 * totalChunks 以上の番号は書き直しで縮んだ後の残骸キーを指す可能性があるため除外し、1 つでもあれば null（=信用しない）を返す。
 */
export function lookupCountChunkIndices(
  index: Record<string, unknown> | null,
  countId: string,
  totalChunks: number,
  normalize: (id: string) => string
): number[] | null {
  if (!index) return null;
  const n = normalize(countId);
  let value: unknown = index[countId] ?? index[n];
  if (value == null) {
    const key = Object.keys(index).find((k) => normalize(k) === n);
    value = key != null ? index[key] : undefined;
  }
  const arr = Array.isArray(value) ? value : value != null ? [value] : [];
  const indices = arr.map((v) => Number(v));
  if (indices.length === 0) return null;
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= totalChunks)) return null;
  return [...new Set(indices)].sort((a, b) => a - b);
}

/**
 * 指定チャンク（番号昇順）から countId の棚卸を探す。readInventoryCountsChunked → find と同じ優先順位：
 * パートでない完全オブジェクトを先に返し、無ければパートを結合する。パートが揃っていない場合は incomplete。
 */
export function findCountInChunkRaws<T>(
  chunks: Array<{ index: number; raw: string }>,
  countId: string,
  normalize: (id: string) => string,
  mergeParts: (parts: CountPartLike[]) => T
): SingleCountLookup<T> {
  const n = normalize(countId);
  const matches = (id: unknown) => id != null && (String(id) === countId || normalize(String(id)) === n);
  const parts: CountPartLike[] = [];
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  for (const { raw } of sorted) {
    let chunk: unknown;
    try {
      chunk = JSON.parse(raw);
    } catch {
      return { status: "incomplete" };
    }
    if (!Array.isArray(chunk)) return { status: "incomplete" };
    for (const el of chunk) {
      if (!el || typeof el !== "object") continue;
      if ((el as CountPartLike)._part === true) {
        if (matches((el as CountPartLike).countId)) parts.push(el as CountPartLike);
      } else if (matches((el as { id?: unknown }).id)) {
        return { status: "found", count: el as T };
      }
    }
  }
  if (parts.length === 0) return { status: "not_found" };
  const countIds = new Set(parts.map((p) => String(p.countId)));
  const total = parts[0].totalParts;
  const partIndices = new Set(parts.map((p) => p.partIndex));
  const complete =
    countIds.size === 1 &&
    Number.isInteger(total) &&
    total >= 1 &&
    parts.every((p) => p.totalParts === total) &&
    partIndices.size === total &&
    parts.length === total &&
    [...partIndices].every((i) => Number.isInteger(i) && i >= 0 && i < total);
  return complete ? { status: "found", count: mergeParts(parts) } : { status: "incomplete" };
}

/** インデックス未登録（append 直後の新規発行分）を探すための末尾チャンク番号 */
export function tailChunkIndices(totalChunks: number, count: number, exclude: number[] = []): number[] {
  const out: number[] = [];
  for (let i = totalChunks - 1; i >= 0 && out.length < count; i--) {
    if (!exclude.includes(i)) out.push(i);
  }
  return out.sort((a, b) => a - b);
}
