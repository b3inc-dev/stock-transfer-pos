/**
 * POS 側: 棚卸 API（db モード）の利用判定・ページ分割
 * Run: node --test tests/stocktake-counts-api-client.test.mjs
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cachedStorageMode,
  getDbListCache,
  pageForChunkIndex,
  rememberStorageMode,
  resetStocktakeCountsApiCache,
  setDbListCache,
  totalPagesFor,
  tryCountsApi,
} from "../extensions/stock-transfer-stocktake/src/screens/stocktake/stocktakeCountsApi.js";

beforeEach(() => resetStocktakeCountsApiCache());

const postReturning = (res) => {
  const calls = [];
  return {
    calls,
    deps: {
      post: async (body) => {
        calls.push(body);
        return typeof res === "function" ? res(body) : res;
      },
    },
  };
};

describe("pageForChunkIndex / totalPagesFor", () => {
  const list = Array.from({ length: 7 }, (_, i) => i); // 0 = newest

  it("highest chunk index is the newest page (matches metafield chunk order)", () => {
    assert.equal(totalPagesFor(list.length, 3), 3);
    assert.deepEqual(pageForChunkIndex(list, 3, 2), [0, 1, 2]);
    assert.deepEqual(pageForChunkIndex(list, 3, 1), [3, 4, 5]);
    assert.deepEqual(pageForChunkIndex(list, 3, 0), [6]);
  });

  it("returns [] for out-of-range indexes and handles empty lists", () => {
    assert.deepEqual(pageForChunkIndex(list, 3, 3), []);
    assert.deepEqual(pageForChunkIndex(list, 3, -1), []);
    assert.deepEqual(pageForChunkIndex([], 3, 0), []);
    assert.equal(totalPagesFor(0, 3), 1);
    assert.equal(totalPagesFor(5, 0), 5);
  });
});

describe("tryCountsApi", () => {
  it("returns the response in db mode and caches the mode", async () => {
    const { deps, calls } = postReturning({ ok: true, storageMode: "db", counts: [{ id: "1" }] });
    const res = await tryCountsApi("list", null, deps);
    assert.deepEqual(res.counts, [{ id: "1" }]);
    assert.deepEqual(calls, [{ op: "list" }]);
    assert.equal(cachedStorageMode(), "db");
  });

  it("returns null in legacy/dual and skips the API while cached", async () => {
    const { deps, calls } = postReturning({ ok: true, storageMode: "dual" });
    assert.equal(await tryCountsApi("get", "c1", deps), null);
    assert.deepEqual(calls, [{ op: "get", countId: "c1" }]);
    assert.equal(await tryCountsApi("get", "c1", deps), null);
    assert.equal(calls.length, 1);
  });

  it("falls back (null) when the server is old or unreachable, and stops retrying for a while", async () => {
    const { deps, calls } = postReturning(null);
    assert.equal(await tryCountsApi("list", null, deps), null);
    assert.equal(cachedStorageMode(), "legacy");
    assert.equal(await tryCountsApi("list", null, deps), null);
    assert.equal(calls.length, 1);
  });

  it("keeps db mode on a transient failure so the next call retries the API", async () => {
    rememberStorageMode("db");
    let fail = true;
    const { deps, calls } = postReturning(() => (fail ? null : { ok: true, storageMode: "db", count: { id: "c1" } }));
    assert.equal(await tryCountsApi("get", "c1", deps), null);
    assert.equal(cachedStorageMode(), "db");
    fail = false;
    const res = await tryCountsApi("get", "c1", deps);
    assert.deepEqual(res.count, { id: "c1" });
    assert.equal(calls.length, 2);
  });

  it("mode cache expires after 60s", () => {
    rememberStorageMode("legacy", 1_000);
    assert.equal(cachedStorageMode(1_000 + 59_000), "legacy");
    assert.equal(cachedStorageMode(1_000 + 60_000), null);
  });
});

describe("db list cache", () => {
  it("is only visible while the cached mode is db", () => {
    setDbListCache([{ id: "1" }], 50);
    assert.equal(getDbListCache(), null);
    rememberStorageMode("db");
    assert.deepEqual(getDbListCache(), { counts: [{ id: "1" }], listLimit: 50 });
  });
});
