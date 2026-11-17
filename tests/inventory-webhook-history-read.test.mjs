/* global globalThis */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite, action;
const event = {
  shop: "fixture.invalid", topic: "INVENTORY_LEVELS_UPDATE", session: null,
  payload: { inventory_item_id: "11", location_id: "22", available: 8, updated_at: "2026-01-04T02:00:00Z" },
};

before(async () => {
  vite = await createServer({
    configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false },
    plugins: [{
      name: "inventory-history-read-fixture", enforce: "pre",
      resolveId(id) {
        if (id === "../db.server") return "\0fixture-db";
        if (id === "../shopify.server") return "\0fixture-shopify";
      },
      load(id) {
        if (id === "\0fixture-db") return "export default globalThis.inventoryHistoryFixture.db";
        if (id === "\0fixture-shopify") return "export default {}; export const authenticate = {webhook: async () => globalThis.inventoryHistoryFixture.event}";
      },
    }],
  });
  globalThis.inventoryHistoryFixture = { db: {}, event };
  ({ action } = await vite.ssrLoadModule("/app/routes/webhooks.inventory_levels.update.tsx"));
});

after(async () => { delete globalThis.inventoryHistoryFixture; await vite?.close(); });

function historyFixture(previousQuantity, failedRead, failuresRemaining = Infinity) {
  const rows = [];
  function read(method) {
    if (method === failedRead && failuresRemaining > 0) {
      failuresRemaining--;
      throw Object.assign(new Error("synthetic connection timeout"), { code: "P2024" });
    }
  }
  const baseline = previousQuantity === null ? null : { quantityAfter: previousQuantity };
  globalThis.inventoryHistoryFixture.db.inventoryChangeLog = {
    async findFirst({ where }) {
      read("findFirst");
      if (where.activity || where.timestamp || where.note) return null;
      return [...rows].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] ?? baseline;
    },
    async findUnique({ where }) {
      read("findUnique");
      return rows.find(row => row.idempotencyKey === where.shop_idempotencyKey.idempotencyKey);
    },
    async findMany() { return []; },
    async create({ data }) { rows.push(data); return data; },
  };
  return { rows, restoreRead() { failedRead = null; } };
}

const submit = () => action({ request: new Request("https://fixture.invalid/webhook", { method: "POST" }) });

for (const failedRead of ["findFirst", "findUnique"]) {
  test(`a failed ${failedRead} leaves history untouched; replay after recovery records the correct delta once`, async () => {
    const fixture = historyFixture(10, failedRead);
    assert.equal((await submit()).status, 503);
    assert.equal((await submit()).status, 503);
    assert.deepEqual(fixture.rows, []);
    fixture.restoreRead();
    assert.equal((await submit()).status, 200);
    assert.equal((await submit()).status, 200);
    assert.equal(fixture.rows.length, 1);
    assert.equal(fixture.rows[0].delta, -2);
    assert.ok(fixture.rows[0].idempotencyKey);
  });
}

test("a single transient read failure cannot create a keyless first-observation row", async () => {
  const fixture = historyFixture(10, "findFirst", 1);
  assert.equal((await submit()).status, 503);
  assert.deepEqual(fixture.rows, []);
  assert.equal((await submit()).status, 200);
  assert.equal(fixture.rows[0].delta, -2);
  assert.ok(fixture.rows[0].idempotencyKey);
});

test("an absent previous observation can be recorded with an idempotency key", async () => {
  const fixture = historyFixture(null, null);
  assert.equal((await submit()).status, 200);
  assert.equal((await submit()).status, 200);
  assert.equal(fixture.rows.length, 1);
  assert.equal(fixture.rows[0].delta, null);
  assert.ok(fixture.rows[0].idempotencyKey);
});


test("failure reading the fallback quantity is not treated as an absent observation", async () => {
  const fixture = historyFixture(null, null);
  const db = globalThis.inventoryHistoryFixture.db.inventoryChangeLog;
  const original = db.findFirst;
  let calls = 0;
  db.findFirst = async (query) => {
    if (++calls === 2) throw new Error("synthetic fallback lookup failed");
    return original(query);
  };
  assert.equal((await submit()).status, 503);
  assert.deepEqual(fixture.rows, []);
});

test("an unavailable history model is not acknowledged as a completed notification", async () => {
  globalThis.inventoryHistoryFixture.db.inventoryChangeLog = undefined;
  assert.equal((await submit()).status, 503);
});


// Known release blocker: a failed observation can be replayed after a newer one.
// Keep the correct expected deltas visible; TODO is not a passing acceptance test.
test("a retry after a newer observation preserves chronological deltas", {
  todo: "#46 / #53: durable ordering and reconciliation remain unresolved; no production release",
}, async () => {
  const fixture = historyFixture(10, "findFirst", 1);
  try {
    globalThis.inventoryHistoryFixture.event = event;
    assert.equal((await submit()).status, 503);
    assert.deepEqual(fixture.rows, []);
    globalThis.inventoryHistoryFixture.event = { ...event, payload: {
      ...event.payload, available: 7, updated_at: "2026-01-04T02:00:10Z",
    } };
    assert.equal((await submit()).status, 200);
    globalThis.inventoryHistoryFixture.event = event;
    assert.equal((await submit()).status, 200);
    assert.equal((await submit()).status, 200);
    assert.equal(fixture.rows.length, 2);
    const chronological = [...fixture.rows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    assert.deepEqual(chronological.map(row => ({ quantity: row.quantityAfter, delta: row.delta })), [
      { quantity: 8, delta: -2 }, { quantity: 7, delta: -1 },
    ]);
  } finally {
    globalThis.inventoryHistoryFixture.event = event;
  }
});
