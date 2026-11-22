/**
 * 在庫変動の CSV の「種別」が、画面（在庫情報）と同じ言葉になること（#7 の引き継ぎ）。
 * 前は CSV の表に adjustment が無く、「調整」が「その他」になっていた。
 * 2 つの表は別のファイルにあるので、中身が同じかを確かめる（片方だけ直して、ずれないように）。
 * Run: node --test tests/change-history-csv-activity-label.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

function labels(src) {
  const block = src.match(/const ACTIVITY_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert.ok(block, "ACTIVITY_LABELS が見つかる");
  return Object.fromEntries([...block[1].matchAll(/^\s*([a-z_]+):\s*"([^"]+)",?/gm)].map((m) => [m[1], m[2]]));
}

const csv = labels(read("app/export-change-history-csv.server.ts"));
const screen = labels(read("app/routes/app.inventory-info.tsx"));

describe("在庫変動の CSV の種別", () => {
  it("調整（adjustment）は「調整」（その他にならない）", () => {
    assert.equal(csv.adjustment, "調整");
  });
  it("画面の表と同じ中身", () => {
    assert.deepEqual(csv, screen);
  });
});
