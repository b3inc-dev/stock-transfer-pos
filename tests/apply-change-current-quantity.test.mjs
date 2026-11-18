/**
 * ロス・仕入れの「増減だけ」の明細: 今の在庫数を読めなかったら、0 として扱わずに失敗にする。
 * 0 として扱うと、在庫が「0 からの増減」で書き換わる（10 個あるのにロス 1 個で -1 個）。
 * Run: node --experimental-strip-types --test tests/apply-change-current-quantity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeDeltaEntries,
  readAvailableFromResponse,
} from "../app/utils/current-quantity-read.ts";

const available = (n) => ({ data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "available", quantity: n }] } } } });

describe("readAvailableFromResponse", () => {
  it("読めたときはその数", () => {
    assert.deepEqual(readAvailableFromResponse(true, 200, available(10)), { ok: true, quantity: 10 });
    assert.deepEqual(readAvailableFromResponse(true, 200, available(0)), { ok: true, quantity: 0 });
    assert.deepEqual(readAvailableFromResponse(true, 200, available(-3)), { ok: true, quantity: -3 });
  });

  it("その店に在庫の記録が無い（inventoryLevel が null）ときだけ 0", () => {
    assert.deepEqual(
      readAvailableFromResponse(true, 200, { data: { inventoryItem: { inventoryLevel: null } } }),
      { ok: true, quantity: 0 }
    );
  });

  it("HTTP の失敗・GraphQL の errors・data なし・available なしは 0 にしない（送り直してよい失敗）", () => {
    for (const [ok, status, json] of [
      [false, 503, {}],
      [false, 500, { errors: [{ message: "Internal" }] }],
      [true, 200, { errors: [{ message: "Throttled" }] }],
      [true, 200, {}],
      [true, 200, { data: null }],
      [true, 200, { data: {} }],
      [true, 200, { data: { inventoryItem: { inventoryLevel: { quantities: [] } } } }],
      [true, 200, { data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "available", quantity: null }] } } } }],
    ]) {
      const r = readAvailableFromResponse(ok, status, json);
      assert.equal(r.ok, false, JSON.stringify(json));
      assert.equal(r.retryable, true, JSON.stringify(json));
    }
  });

  it("商品が見つからない（inventoryItem が null）は送り直しても同じなので retryable ではない", () => {
    const r = readAvailableFromResponse(true, 200, { data: { inventoryItem: null } });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
  });
});

describe("normalizeDeltaEntries", () => {
  it("今の在庫 + delta にする。quantityAfter がある明細は読まない", async () => {
    const reads = [];
    const r = await normalizeDeltaEntries(
      [
        { inventoryItemId: "1", delta: -1 },
        { inventoryItemId: "2", quantityAfter: 5 },
        { inventoryItemId: "3" },
      ],
      async (id) => {
        reads.push(id);
        return { ok: true, quantity: 10 };
      }
    );
    assert.equal(r.ok, true);
    assert.deepEqual(reads, ["1"]);
    assert.deepEqual(
      r.entries.map((e) => [e.inventoryItemId, e.quantityBefore, e.quantityAfter]),
      [["1", 10, 9], ["2", undefined, 5]]
    );
  });

  it("1 件でも読めなければ、どの明細も作らずに失敗（0 + delta にしない）", async () => {
    const r = await normalizeDeltaEntries(
      [
        { inventoryItemId: "1", delta: -1 },
        { inventoryItemId: "2", delta: -1 },
      ],
      async (id) => (id === "2" ? { ok: false, retryable: true, error: "Throttled" } : { ok: true, quantity: 10 })
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.equal(r.inventoryItemId, "2");
    assert.equal("entries" in r, false);
  });

  it("読む処理が例外を投げても失敗（送り直してよい）", async () => {
    const r = await normalizeDeltaEntries([{ inventoryItemId: "1", delta: 3 }], async () => {
      throw new Error("network down");
    });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.match(r.error, /network down/);
  });
});

describe("apply-change route", () => {
  const route = readFileSync(new URL("../app/routes/api.inventory.apply-change.tsx", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../app/utils/inventory-set-quantities-server.ts", import.meta.url), "utf8");

  it("delta の明細は normalizeDeltaEntries で直し、読めなければイベントを作る前に返す", () => {
    assert.doesNotMatch(route, /cur \+ e\.delta/);
    const normalize = route.indexOf("await normalizeDeltaEntries(");
    const create = route.indexOf("db.inventoryChangeEvent.create(");
    assert.ok(normalize > 0 && create > normalize, "normalize before event create");
    assert.match(route, /current_quantity_unreadable/);
    assert.match(route, /status: normalized\.retryable \? 503 : 400/);
  });

  it("fetchCurrentQuantityServer は読めなかったときに 0 を返さない", () => {
    const start = helper.indexOf("export async function fetchCurrentQuantityServer(");
    const end = helper.indexOf("\n}\n", start);
    const body = helper.slice(start, end);
    assert.ok(start > 0);
    assert.doesNotMatch(body, /return 0;/);
    assert.match(body, /readAvailableAt\(/);
    const readStart = helper.indexOf("async function readAvailableAt(");
    const readBody = helper.slice(readStart, helper.indexOf("\n}\n", readStart));
    assert.ok(readStart > 0);
    assert.match(readBody, /readAvailableFromResponse\(/);
  });
});
