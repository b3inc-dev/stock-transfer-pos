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

describe("reportStocktakeCompleteToApi network messaging", () => {
  it("does not mention tunnel URL on Failed to fetch and retries fast fails", async () => {
    installShopifySession();
    const calls = [];
    globalThis.fetch = async () => {
      calls.push(Date.now());
      throw new TypeError("Failed to fetch");
    };

    const modPath = pathToFileURL(
      path.join(root, "extensions/common/reportStocktakeComplete.js")
    ).href;
    const { reportStocktakeCompleteToApi } = await import(`${modPath}?t=${Date.now()}`);

    const result = await reportStocktakeCompleteToApi({
      countId: "c1",
      groupId: "g1",
      items: [{ inventoryItemId: "i1", currentQuantity: 1, actualQuantity: 1 }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.needMetafieldRetry, true);
    assert.equal(result.uncertain, true);
    assert.match(String(result.error), /再試行/);
    assert.doesNotMatch(String(result.error), /トンネル/);
    assert.equal(calls.length, 3, `expected 3 attempts, got ${calls.length}`);
  });

  it("uses timeout message without tunnel wording on AbortError", async () => {
    installShopifySession();
    globalThis.fetch = async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    };

    const modPath = pathToFileURL(
      path.join(root, "extensions/common/reportStocktakeComplete.js")
    ).href;
    const { reportStocktakeCompleteToApi } = await import(`${modPath}?t=${Date.now() + 1}`);

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
        JSON.stringify({ ok: true, status: "completed", completedAt: "2026-10-09T00:00:00.000Z", countId: "c1" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const modPath = pathToFileURL(
      path.join(root, "extensions/common/reportStocktakeComplete.js")
    ).href;
    const { reportStocktakeCompleteToApi } = await import(`${modPath}?t=${Date.now() + 2}`);

    const result = await reportStocktakeCompleteToApi({
      countId: "c1",
      retryOnly: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.equal(result.completedAt, "2026-10-09T00:00:00.000Z");
  });
});
