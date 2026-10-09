/**
 * reportStocktakeCompleteToApi — ネットワーク文言・高速失敗リトライの単体テスト
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function installShopifySession(token = "test-token") {
  globalThis.shopify = {
    session: {
      getSessionToken: async () => token,
    },
  };
}

async function loadReportApi(nonce) {
  const modPath = pathToFileURL(path.join(root, "extensions/common/reportStocktakeComplete.js")).href;
  const { reportStocktakeCompleteToApi } = await import(`${modPath}?t=${nonce}`);
  return reportStocktakeCompleteToApi;
}

describe("reportStocktakeCompleteToApi network messaging", () => {
  it("does not mention tunnel URL on Failed to fetch and retries fast fails", async () => {
    installShopifySession();
    const calls = [];
    globalThis.fetch = async () => {
      calls.push(Date.now());
      throw new TypeError("Failed to fetch");
    };

    const reportStocktakeCompleteToApi = await loadReportApi(Date.now());

    const result = await reportStocktakeCompleteToApi({
      countId: "c1",
      groupId: "g1",
      items: [{ inventoryItemId: "i1", currentQuantity: 1, actualQuantity: 1 }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.needMetafieldRetry, true);
    assert.equal(result.uncertain, true);
    assert.match(String(result.error), /再試行/);
    assert.match(String(result.error), /サーバ側で完了している可能性/);
    assert.doesNotMatch(String(result.error), /トンネル/);
    assert.equal(calls.length, 3, `expected 3 attempts, got ${calls.length}`);
  });

  it("does not auto-retry when network fail elapsed is >= 8s", async () => {
    installShopifySession();
    const calls = [];
    const reportStocktakeCompleteToApi = await loadReportApi("slow-fail");
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    globalThis.fetch = async () => {
      calls.push(now);
      now += 9000; // elapsedMs >= NETWORK_FAST_FAIL_MS
      throw new TypeError("Failed to fetch");
    };

    try {
      const result = await reportStocktakeCompleteToApi({
        countId: "c1",
        groupId: "g1",
        items: [{ inventoryItemId: "i1", currentQuantity: 1, actualQuantity: 1 }],
      });

      assert.equal(result.ok, false);
      assert.equal(result.needMetafieldRetry, true);
      assert.equal(result.uncertain, true);
      assert.match(String(result.error), /サーバ側で完了している可能性/);
      assert.doesNotMatch(String(result.error), /トンネル/);
      assert.equal(calls.length, 1, `expected 1 attempt (no auto-retry), got ${calls.length}`);
    } finally {
      Date.now = realNow;
    }
  });

  it("uses timeout message without tunnel wording on AbortError", async () => {
    installShopifySession();
    globalThis.fetch = async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    };

    const reportStocktakeCompleteToApi = await loadReportApi(Date.now() + 1);

    const result = await reportStocktakeCompleteToApi({
      countId: "c1",
      retryOnly: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.needMetafieldRetry, true);
    assert.match(String(result.error), /タイムアウト|120/);
    assert.doesNotMatch(String(result.error), /トンネル/);
  });

  it("preserves status on HTTP 200 ok:true", async () => {
    installShopifySession();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          status: "completed",
          completedAt: "2026-10-09T00:00:00.000Z",
          countId: "c1",
          backupPersisted: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const reportStocktakeCompleteToApi = await loadReportApi(Date.now() + 2);

    const result = await reportStocktakeCompleteToApi({
      countId: "c1",
      retryOnly: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.equal(result.completedAt, "2026-10-09T00:00:00.000Z");
    assert.equal(result.backupPersisted, true);
  });

  it("preserves backupPersisted:false on HTTP 200 ok:false", async () => {
    installShopifySession();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "ステータスの反映に失敗しました",
          needMetafieldRetry: true,
          countId: "c1",
          backupPersisted: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const reportStocktakeCompleteToApi = await loadReportApi(Date.now() + 3);

    const result = await reportStocktakeCompleteToApi({
      countId: "c1",
      groupId: "g1",
      items: [{ inventoryItemId: "i1", currentQuantity: 1, actualQuantity: 1 }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.needMetafieldRetry, true);
    assert.equal(result.backupPersisted, false);
  });
});
