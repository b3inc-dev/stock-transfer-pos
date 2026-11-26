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

function historyFixture(previousQuantity, failedRead, failuresRemaining = Infinity, seedRows = []) {
  const rows = seedRows.map(row => ({ ...row }));
  function read(method) {
    if (method === failedRead && failuresRemaining > 0) {
      failuresRemaining--;
      throw Object.assign(new Error("synthetic connection timeout"), { code: "P2024" });
    }
  }
  // The current chronology helper always sends timestamp.lt/gt and tenant/item/location
  // scope. A timestamp predicate must filter observations, not make them disappear.
  const baseline = previousQuantity === null ? null : {
    id: "synthetic-baseline", shop: event.shop, inventoryItemId: "11", locationId: "22",
    timestamp: new Date("2026-01-03T02:00:00Z"), quantityAfter: previousQuantity,
    activity: "admin_webhook", note: "", idempotencyKey: "synthetic-baseline",
  };
  function matches(row, where) {
    return Object.entries(where).every(([key, wanted]) => {
      if (key === "OR") return wanted.some(term => matches(row, term));
      const actual = row[key];
      if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
        return Object.entries(wanted).every(([operator, value]) => {
          if (operator === "in") return value.includes(actual);
          if (operator === "not") return value === null ? actual != null : actual !== value;
          if (operator === "startsWith") return typeof actual === "string" && actual.startsWith(value);
          if (operator === "endsWith") return typeof actual === "string" && actual.endsWith(value);
          if (operator === "lt") return new Date(actual) < new Date(value);
          if (operator === "lte") return new Date(actual) <= new Date(value);
          if (operator === "gt") return new Date(actual) > new Date(value);
          if (operator === "gte") return new Date(actual) >= new Date(value);
          throw new Error(`Unsupported synthetic history predicate: ${operator}`);
        });
      }
      return wanted instanceof Date ? new Date(actual).getTime() === wanted.getTime() : actual === wanted;
    });
  }
  function selected({ where, orderBy, take }) {
    const found = [...rows, ...(baseline ? [baseline] : [])].filter(row => matches(row, where));
    if (orderBy?.timestamp) found.sort((a, b) => (new Date(a.timestamp) - new Date(b.timestamp)) * (orderBy.timestamp === "asc" ? 1 : -1));
    return take === undefined ? found : found.slice(0, take);
  }
  globalThis.inventoryHistoryFixture.db.inventoryChangeLog = {
    async findFirst(query) {
      read("findFirst");
      return selected(query)[0] ?? null;
    },
    async findUnique({ where }) {
      read("findUnique");
      return rows.find(row => row.idempotencyKey === where.shop_idempotencyKey.idempotencyKey);
    },
    async findMany(query) { return selected(query); },
    async create({ data }) { const row = { id: `synthetic-${rows.length + 1}`, ...data }; rows.push(row); return row; },
    async update({ where, data }) { const row = rows.find(item => matches(item, where)); assert.ok(row, "update targets a saved observation"); Object.assign(row, data); return row; },
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

test("newer observations from another shop, item or location never become this event's baseline", async () => {
  const shared = { timestamp: new Date("2026-01-04T01:59:59Z"), activity: "admin_webhook", delta: 4, note: "" };
  const foreign = [
    { ...shared, id: "other-shop", shop: "other.invalid", inventoryItemId: "11", locationId: "22", quantityAfter: 100 },
    { ...shared, id: "other-item", shop: event.shop, inventoryItemId: "99", locationId: "22", quantityAfter: 50 },
    { ...shared, id: "other-location", shop: event.shop, inventoryItemId: "11", locationId: "99", quantityAfter: 60 },
  ];
  const fixture = historyFixture(10, null, Infinity, foreign);
  assert.equal((await submit()).status, 200);
  assert.deepEqual(fixture.rows.slice(0, foreign.length), foreign);
  assert.equal(fixture.rows.length, foreign.length + 1);
  assert.equal(fixture.rows.at(-1).delta, -2);
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


// Exercise the current timestamp-scoped predecessor lookup and successor repair.
// This nonzero-observation case does not cover #53's missing zero-delta observation.
test("a retry after a newer observation preserves chronological deltas", async () => {
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
