/**
 * POS 棚卸ID一覧の表示対象選定（純粋関数）。
 * メタフィールドは発行順（古い順）に追記されるため、件数上限で切る前に必ず新しい順へ並べる。
 */

function countNameNumber(c) {
  const m = String(c?.countName ?? "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

function createdAtMs(c) {
  const t = new Date(c?.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 新しい順（createdAt 降順、同時刻・欠落時は棚卸ID番号の降順） */
export function compareCountsNewestFirst(a, b) {
  const d = createdAtMs(b) - createdAtMs(a);
  if (d !== 0) return d;
  return countNameNumber(b) - countNameNumber(a);
}

/** 新しい順に並べ替えた新しい配列を返す（id 重複は先に現れた方を残す） */
export function sortCountsNewestFirst(counts) {
  const list = Array.isArray(counts) ? counts.filter(Boolean) : [];
  const seen = new Set();
  const unique = [];
  for (const c of list) {
    const id = c?.id != null ? String(c.id) : "";
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    unique.push(c);
  }
  return unique.sort(compareCountsNewestFirst);
}

/**
 * ロケーション絞り込み → 新しい順 → 件数上限の順で表示対象を決める。
 * @param {unknown[]} counts
 * @param {{ limit?: number, matches?: (c: any) => boolean }} [opts]
 * @returns {{ all: any[], visible: any[], hasMore: boolean }}
 */
export function selectCountsForList(counts, opts = {}) {
  const matches = typeof opts.matches === "function" ? opts.matches : null;
  const base = Array.isArray(counts) ? counts : [];
  const all = sortCountsNewestFirst(matches ? base.filter((c) => c && matches(c)) : base);
  const limit = Number(opts.limit);
  if (!Number.isFinite(limit) || limit <= 0) return { all, visible: all, hasMore: false };
  const n = Math.floor(limit);
  return { all, visible: all.slice(0, n), hasMore: all.length > n };
}
