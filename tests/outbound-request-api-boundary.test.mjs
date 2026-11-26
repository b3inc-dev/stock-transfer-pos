/* global globalThis */
import assert from "node:assert/strict";
import { test } from "node:test";
import { outboundRequestApi, currentRequestLocation } from "../extensions/stock-transfer-request/src/api.js";
import { getAppUrl } from "../extensions/common/appUrl.js";

// No credentials, network, database, inventory mutation, or real POS host.
// Each test owns and restores globals; these tests must remain sequential.
function fixture(t, options = {}) {
  const calls = [], timers = [], cleared = [];
  const previous = Object.fromEntries(["shopify", "fetch", "setTimeout", "clearTimeout"].map(key => [key, globalThis[key]]));
  let tokenCalls = 0;
  globalThis.shopify = { session: { currentSession: { locationId: options.location ?? 1 }, async getSessionToken() { tokenCalls++; return options.token ?? "synthetic-token"; } } };
  globalThis.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
  globalThis.clearTimeout = timer => { cleared.push(timer); };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (options.fetch) return options.fetch(url, init, timers);
    return Response.json({ ok: true, row: { id: "synthetic-request" } });
  };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return { calls, timers, cleared, get tokenCalls() { return tokenCalls; } };
}

test("numeric and canonical POS locations resolve; malformed locations stop before token/fetch", async t => {
  const f = fixture(t);
  assert.equal(currentRequestLocation(), "gid://shopify/Location/1");
  shopify.session.currentSession.locationId = "gid://shopify/Location/2";
  assert.equal(currentRequestLocation(), "gid://shopify/Location/2");
  for (const location of ["", "1/other", "gid://shopify/Product/1", "https://synthetic.invalid"]) {
    shopify.session.currentSession.locationId = location;
    await assert.rejects(outboundRequestApi({ command: "begin" }), /POS店舗/);
  }
  assert.equal(f.tokenCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.length, 0);
});

test("changed POS origin refuses shipping before token/fetch", async t => {
  const f = fixture(t);
  await assert.rejects(outboundRequestApi({ command: "begin", originId: "gid://shopify/Location/2" }), /店舗が変わっています/);
  assert.equal(f.tokenCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.length, 0);
});

test("missing session token refuses before timer or network", async t => {
  const f = fixture(t, { token: "" });
  await assert.rejects(outboundRequestApi({ command: "begin" }), /利用権限/);
  assert.equal(f.tokenCalls, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.length, 0);
});

test("request uses candidate endpoint and authenticated POS location, never caller locationId", async t => {
  const f = fixture(t);
  const payload = { command: "begin", originId: "gid://shopify/Location/1", locationId: "gid://shopify/Location/999", id: "synthetic-request", version: 7, claimKey: "synthetic-device", token: "synthetic-preview" };
  const response = await outboundRequestApi(payload);
  assert.equal(response.row.id, "synthetic-request");
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, getAppUrl() + "/api/outbound-requests");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer synthetic-token");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { ...payload, locationId: "gid://shopify/Location/1" });
  assert.equal(payload.locationId, "gid://shopify/Location/999");
  assert.equal(init.signal.aborted, false);
  assert.deepEqual(f.cleared, f.timers);
});

for (const command of ["begin", "preview", "save", "advance", "reconcile", "detail"]) test(command + " transport has explicit timeout and clears it after success", async t => {
  const f = fixture(t);
  await outboundRequestApi({ command });
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, ["begin", "preview", "save"].includes(command) ? 90000 : 25000);
  assert.deepEqual(f.cleared, f.timers);
});

test("timeout aborts original request and never automatically retries uncertain shipping", async t => {
  const f = fixture(t, { fetch: async (_url, { signal }, timers) => {
    timers[0].fn();
    assert.equal(signal.aborted, true);
    throw new DOMException("synthetic timeout", "AbortError");
  } });
  await assert.rejects(outboundRequestApi({ command: "begin" }), /同じ依頼を読み直して結果を確認.*新しく出庫し直さない/);
  assert.equal(f.calls.length, 1, "an uncertain operation must not be resubmitted by the transport");
  assert.deepEqual(f.cleared, f.timers);
});

test("network failure clears timeout, directs reread and performs no automatic retry", async t => {
  const f = fixture(t, { fetch: async () => { throw new TypeError("synthetic connection lost after server success"); } });
  await assert.rejects(outboundRequestApi({ command: "advance" }), /通信できません。同じ依頼を読み直して結果を確認/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.cleared, f.timers);
});

for (const sample of [
  { status: 401, body: { ok: true }, expected: /出庫依頼を取得できません/ },
  { status: 404, body: {}, expected: /まだ利用できません/ },
  { status: 409, body: { ok: false, error: "synthetic-stale-version" }, expected: /synthetic-stale-version/ },
  { status: 200, body: { ok: false }, expected: /出庫依頼を取得できません/ },
  { status: 502, malformed: true, expected: /出庫依頼を取得できません/ },
  { status: 200, malformed: true, expected: /出庫依頼を取得できません/ },
]) test("HTTP/application failure is rejected without retry: " + sample.status + (sample.malformed ? " malformed" : ""), async t => {
  const f = fixture(t, { fetch: async () => sample.malformed
    ? new Response("<synthetic-invalid-json>", { status: sample.status })
    : Response.json(sample.body, { status: sample.status }) });
  await assert.rejects(outboundRequestApi({ command: "begin" }), sample.expected);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.cleared, f.timers);
});

test("unexpected errors retain identity, clear timeout and never retry", async t => {
  const error = new Error("synthetic-host-error");
  const f = fixture(t, { fetch: async () => { throw error; } });
  await assert.rejects(outboundRequestApi({ command: "advance" }), actual => actual === error);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.cleared, f.timers);
});
