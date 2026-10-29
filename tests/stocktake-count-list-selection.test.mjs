import test from "node:test";
import assert from "node:assert/strict";
import {
  compareCountsNewestFirst,
  sortCountsNewestFirst,
  selectCountsForList,
} from "../extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeCountListSelection.js";

const pad = (n) => String(n).padStart(4, "0");
const KANAZAWA = "gid://shopify/Location/84";
const OTHER = "gid://shopify/Location/1";

/** メタフィールドと同じ「発行順＝古い順」の配列 */
function makeCounts(n, locationFor = () => KANAZAWA) {
  return Array.from({ length: n }, (_, i) => ({
    id: `count-${i + 1}`,
    countName: `#C${pad(i + 1)}`,
    locationId: locationFor(i + 1),
    status: "in_progress",
    createdAt: new Date(Date.UTC(2026, 0, 1) + (i + 1) * 3600_000).toISOString(),
  }));
}

test("上限超過時も最新の棚卸IDが表示される（#C0084 / 上限50 の本番事象）", () => {
  const counts = makeCounts(84);
  const { visible, hasMore } = selectCountsForList(counts, { limit: 50 });
  assert.equal(visible.length, 50);
  assert.equal(visible[0].countName, "#C0084");
  assert.equal(visible[49].countName, "#C0035");
  assert.equal(hasMore, true);
});

test("ロケーション絞り込みを上限より先に行う", () => {
  // 古い 80 件は別店舗、新しい 4 件だけ金沢
  const counts = makeCounts(84, (n) => (n > 80 ? KANAZAWA : OTHER));
  const { visible, hasMore, all } = selectCountsForList(counts, {
    limit: 2,
    matches: (c) => c.locationId === KANAZAWA,
  });
  assert.deepEqual(visible.map((c) => c.countName), ["#C0084", "#C0083"]);
  assert.equal(all.length, 4);
  assert.equal(hasMore, true);
});

test("さらに読み込み：上限を広げると過去分が続けて出る", () => {
  const counts = makeCounts(84);
  const first = selectCountsForList(counts, { limit: 50 });
  const second = selectCountsForList(counts, { limit: 100 });
  assert.equal(second.visible.length, 84);
  assert.equal(second.hasMore, false);
  assert.deepEqual(second.visible.slice(0, 50), first.visible);
  assert.equal(second.visible[83].countName, "#C0001");
});

test("limit 未設定（0）なら全件・hasMore=false", () => {
  const counts = makeCounts(3);
  const { visible, hasMore } = selectCountsForList(counts, { limit: 0 });
  assert.equal(visible.length, 3);
  assert.equal(hasMore, false);
});

test("createdAt 同値・欠落時は棚卸ID番号の降順", () => {
  const a = { id: "a", countName: "#C0009" };
  const b = { id: "b", countName: "#C0010" };
  const c = { id: "c", countName: "#C0002", createdAt: "2026-01-01T00:00:00Z" };
  assert.deepEqual(sortCountsNewestFirst([a, b, c]).map((x) => x.id), ["c", "b", "a"]);
  assert.ok(compareCountsNewestFirst(b, a) < 0);
});

test("id 重複は後に現れた方（新しいチャンク側）を残し、入力配列は変更しない", () => {
  const counts = makeCounts(3);
  const input = [...counts, { ...counts[0], status: "completed" }];
  const snapshot = JSON.stringify(input);
  const out = sortCountsNewestFirst(input);
  assert.equal(out.length, 3);
  assert.equal(out.find((c) => c.id === "count-1").status, "completed");
  assert.equal(JSON.stringify(input), snapshot);
});

test("不正入力でも落ちない", () => {
  assert.deepEqual(selectCountsForList(null, { limit: 5 }).visible, []);
  assert.deepEqual(sortCountsNewestFirst([null, undefined]), []);
});
