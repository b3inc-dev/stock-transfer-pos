/* eslint-env node */
/* global globalThis */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyInventoryChangeToApi } from '../extensions/common/applyInventoryChange.js';
import { adjustInventoryAtLocationWithFallback, buildTransferAdjustAppEventId } from '../extensions/common/adjustInventoryViaApplyChange.js';

const locationId = 'gid://shopify/Location/101';
const entries = [{ inventoryItemId: 'gid://shopify/InventoryItem/1', sku: 'FIXTURE-1', delta: -2 }];
const request = { appEventId: 'fixture-event', activity: 'outbound_transfer', locationId, entries };
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, statusText: 'fixture', json: async () => data });

// Every helper call runs with fetch replaced before invocation; no real API/DB is reachable here.
async function mocked(run, handler) {
  const saved = { fetch: globalThis.fetch, shopify: globalThis.shopify, setTimeout: globalThis.setTimeout };
  const calls = [];
  let tokens = 0;
  try {
    globalThis.shopify = { session: { getSessionToken: async () => `fixture-token-${++tokens}` } };
    globalThis.setTimeout = (callback) => { callback(); return 0; };
    globalThis.fetch = async (_url, options) => {
      const call = { body: JSON.parse(options.body), authorization: options.headers.Authorization, signal: options.signal };
      calls.push(call);
      return handler(call, calls.length);
    };
    await run(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.setTimeout = saved.setTimeout;
    if (saved.shopify === undefined) delete globalThis.shopify;
    else globalThis.shopify = saved.shopify;
  }
}

for (const status of [401, 429, 503]) {
  test(`retry ${status} preserves operation and item/location/quantity mapping`, async () => {
    await mocked(async (calls) => {
      await applyInventoryChangeToApi(request);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].body, calls[1].body);
      assert.equal(calls[0].body.locationId, locationId);
      assert.deepEqual(calls[0].body.entries, entries);
      assert.notEqual(calls[0].authorization, calls[1].authorization);
    }, (_call, count) => count === 1 ? response(status, { ok: false, error: 'temporary' }) : response(200, { ok: true }));
  });
}

test('network retry is bounded to three attempts with the same event ID', async () => {
  await mocked(async (calls) => {
    await assert.rejects(applyInventoryChangeToApi(request), /Network/);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.body.appEventId === request.appEventId));
  }, () => { throw new TypeError('Network fixture failure'); });
});

test('applying event response is not automatically retried', async () => {
  await mocked(async (calls) => {
    await assert.rejects(applyInventoryChangeToApi(request), /already applying/);
    assert.equal(calls.length, 1);
  }, () => response(202, { ok: false, error: 'already applying' }));
});

test('repeated calls preserve the key; deduplication requires server enforcement', async () => {
  await mocked(async (calls) => {
    await applyInventoryChangeToApi(request);
    await applyInventoryChangeToApi(request);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, calls[1].body);
  }, () => response(200, { ok: true }));
});

test('partial chunk failure stops later chunks; retry restarts with stable chunk keys', async () => {
  const deltas = Array.from({ length: 501 }, (_, i) => ({ inventoryItemId: `gid://shopify/InventoryItem/${i + 1}`, sku: `FIXTURE-${i + 1}`, delta: 1 }));
  const options = { locationId, deltas, sourceId: 'fixture-transfer', shipmentId: 'fixture-shipment' };
  await mocked(async (calls) => {
    await assert.rejects(adjustInventoryAtLocationWithFallback(options), /partial fixture/);
    assert.deepEqual(calls.map((call) => call.body.entries.length), [250, 250]);
    await adjustInventoryAtLocationWithFallback(options);
    assert.deepEqual(calls.map((call) => call.body.entries.length), [250, 250, 250, 250, 1]);
    assert.equal(calls[0].body.appEventId, calls[2].body.appEventId);
    assert.equal(calls[1].body.appEventId, calls[3].body.appEventId);
    assert.ok(calls.every((call) => call.body.locationId === locationId));
    assert.equal(calls[4].body.entries[0].sku, 'FIXTURE-501');
  }, (_call, count) => count === 2 ? response(400, { ok: false, error: 'partial fixture' }) : response(200, { ok: true }));
});

test('location separates generated operation keys', () => {
  const options = { operation: 'inbound', transferId: 'fixture-transfer', shipmentId: 'fixture-shipment' };
  const first = buildTransferAdjustAppEventId({ ...options, locationId });
  assert.equal(first, buildTransferAdjustAppEventId({ ...options, locationId }));
  assert.notEqual(first, buildTransferAdjustAppEventId({ ...options, locationId: 'gid://shopify/Location/102' }));
});

test('current apply-change client supplies no abort signal or timeout recovery', async () => {
  await mocked(async (calls) => {
    await applyInventoryChangeToApi(request);
    assert.equal(calls[0].signal, undefined);
  }, () => response(200, { ok: true }));
});
