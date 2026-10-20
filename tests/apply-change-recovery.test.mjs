/**
 * applyInventoryChangeToApi recoverUncertain（通信断/202 → 同一 appEventId の状態照会）と純粋ヘルパー
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  isUncertainFetchError,
  classifyApplyChangeResponse,
  decideFromEventStatus,
} from "../extensions/common/applyChangeRecovery.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadApply(nonce) {
  const modPath = pathToFileURL(path.join(root, "extensions/common/applyInventoryChange.js")).href;
  const { applyInventoryChangeToApi } = await import(`${modPath}?t=${nonce}`);
  return applyInventoryChangeToApi;
}

function installSession() {
  globalThis.shopify = { session: { getSessionToken: async () => "tok" } };
}

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
}

const baseArgs = {
  appEventId: "evt_inventory_count_c1_g1",
  activity: "inventory_count",
  locationId: "gid://shopify/Location/1",
  entries: [{ inventoryItemId: "gid://shopify/InventoryItem/1", quantityAfter: 3, quantityBefore: 1 }],
  recoverUncertain: true,
  recoveryDelaysMs: [0, 0, 0],
};

/** fetch モック: main（entries あり）と status（statusOnly）を分けて記録 */
function mockFetch({ main, status }) {
  const calls = { main: [], status: [] };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.statusOnly) {
      calls.status.push(body);
      return status(calls.status.length, body);
    }
    calls.main.push(body);
    return main(calls.main.length, body);
  };
  return calls;
}

describe("applyChangeRecovery helpers", () => {
  it("treats WebKit Load failed / AbortError as uncertain", () => {
    assert.equal(isUncertainFetchError(new TypeError("Load failed")), true);
    assert.equal(isUncertainFetchError(Object.assign(new Error("x"), { name: "AbortError" })), true);
    assert.equal(isUncertainFetchError(new Error("applyInventoryChangeToApi: No entries")), false);
  });

  it("classifies 202 applying as pending and partial_failed separately", () => {
    assert.equal(classifyApplyChangeResponse(200, { ok: true }), "success");
    assert.equal(classifyApplyChangeResponse(202, { ok: false, status: "applying" }), "pending");
    assert.equal(classifyApplyChangeResponse(400, { ok: false, status: "partial_failed" }), "partial_failed");
    assert.equal(classifyApplyChangeResponse(503, {}), "retryable");
    assert.equal(classifyApplyChangeResponse(400, { ok: false, error: "x" }), "fatal");
  });

  it("maps event status to next action without re-applying partial/applying", () => {
    assert.equal(decideFromEventStatus({ ok: true, found: true, status: "completed" }), "completed");
    assert.equal(decideFromEventStatus({ ok: true, found: false }), "resend");
    assert.equal(decideFromEventStatus({ ok: true, found: true, status: "failed" }), "resend");
    assert.equal(decideFromEventStatus({ ok: true, found: true, status: "applying" }), "wait");
    assert.equal(decideFromEventStatus({ ok: true, found: true, status: "partial_failed" }), "manual");
    assert.equal(decideFromEventStatus(null), "unknown");
  });
});

describe("applyInventoryChangeToApi recoverUncertain", () => {
  it("Load failed → status completed returns success without re-sending", async () => {
    installSession();
    const calls = mockFetch({
      main: () => {
        throw new TypeError("Load failed");
      },
      status: () => jsonRes(200, { ok: true, found: true, status: "completed", eventId: "e1", lineCount: 1 }),
    });
    const apply = await loadApply(`a${Date.now()}`);
    const r = await apply(baseArgs);
    assert.equal(r.ok, true);
    assert.equal(r.recoveredViaStatus, true);
    assert.equal(calls.main.length, 1);
    assert.equal(calls.status[0].appEventId, baseArgs.appEventId);
  });

  it("202 applying that stays applying throws APPLY_PENDING and never re-sends", async () => {
    installSession();
    const calls = mockFetch({
      main: () => jsonRes(202, { ok: false, status: "applying", error: "Event already exists with status: applying" }),
      status: () => jsonRes(200, { ok: true, found: true, status: "applying" }),
    });
    const apply = await loadApply(`b${Date.now()}`);
    await assert.rejects(apply(baseArgs), (e) => e.code === "APPLY_PENDING");
    assert.equal(calls.main.length, 1);
  });

  it("Load failed → event not found re-sends once with the same appEventId", async () => {
    installSession();
    const calls = mockFetch({
      main: (n) => {
        if (n === 1) throw new TypeError("Load failed");
        return jsonRes(200, { ok: true, status: "completed" });
      },
      status: () => jsonRes(200, { ok: true, found: false }),
    });
    const apply = await loadApply(`c${Date.now()}`);
    const r = await apply(baseArgs);
    assert.equal(r.ok, true);
    assert.equal(calls.main.length, 2);
    assert.ok(calls.main.every((b) => b.appEventId === baseArgs.appEventId));
  });

  it("partial_failed status stops with APPLY_PARTIAL and no re-send", async () => {
    installSession();
    const calls = mockFetch({
      main: () => {
        throw new TypeError("Load failed");
      },
      status: () => jsonRes(200, { ok: true, found: true, status: "partial_failed" }),
    });
    const apply = await loadApply(`d${Date.now()}`);
    await assert.rejects(apply(baseArgs), (e) => e.code === "APPLY_PARTIAL");
    assert.equal(calls.main.length, 1);
  });

  it("status unreachable gives APPLY_UNCERTAIN after one main request", async () => {
    installSession();
    const calls = mockFetch({
      main: () => {
        throw new TypeError("Load failed");
      },
      status: () => {
        throw new TypeError("Load failed");
      },
    });
    const apply = await loadApply(`e${Date.now()}`);
    await assert.rejects(apply(baseArgs), (e) => e.code === "APPLY_UNCERTAIN");
    assert.equal(calls.main.length, 1);
    assert.equal(calls.status.length, 3);
  });

  it("without recoverUncertain the legacy path is unchanged (Load failed thrown as-is)", async () => {
    installSession();
    const calls = mockFetch({
      main: () => {
        throw new TypeError("Load failed");
      },
      status: () => jsonRes(200, { ok: true, found: true, status: "completed" }),
    });
    const apply = await loadApply(`f${Date.now()}`);
    await assert.rejects(apply({ ...baseArgs, recoverUncertain: false }), /Load failed/);
    assert.equal(calls.status.length, 0);
  });
});
