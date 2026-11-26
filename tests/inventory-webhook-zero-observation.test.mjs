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
      name: "inventory-zero-observation-fixture", enforce: "pre",
      resolveId(id) {
        if (id === "../db.server") return "\0fixture-db";
        if (id === "../shopify.server") return "\0fixture-shopify";
      },
      load(id) {
        if (id === "\0fixture-db") return "export default globalThis.inventoryZeroObservationFixture.db";
        if (id === "\0fixture-shopify") return "export default {}; export const authenticate = {webhook: async () => globalThis.inventoryZeroObservationFixture.event}";
      },
    }],
  });
  globalThis.inventoryZeroObservationFixture = { db: {}, event };
  ({ action } = await vite.ssrLoadModule("/app/routes/webhooks.inventory_levels.update.tsx"));
});

after(async () => { delete globalThis.inventoryZeroObservationFixture; await vite?.close(); });

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
  globalThis.inventoryZeroObservationFixture.db.inventoryChangeLog = {
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

async function sequence(quantities) {
  const fixture = historyFixture(10, null);
  const responses=[];
  try {
    for(const [quantity,at] of quantities) {
      globalThis.inventoryZeroObservationFixture.event={...event,payload:{...event.payload,available:quantity,updated_at:at}};
      responses.push((await submit()).status);
    }
    const observations=[...fixture.rows].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).map(row=>({quantity:row.quantityAfter,delta:row.delta}));
    assert.deepEqual(responses,quantities.map(()=>200));
    return observations;
  } finally { globalThis.inventoryZeroObservationFixture.event=event; }
}
const earlier=[8,'2026-01-04T02:00:00Z'];
const later=[10,'2026-01-04T02:00:10Z'];
const expected=[{quantity:8,delta:-2},{quantity:10,delta:2}];

test('chronological 10 to 8 to 10 keeps both nonzero observations',async()=>{
  assert.deepEqual(await sequence([earlier,later]),expected);
});
test('nonzero reverse-order control retains both observations',async()=>{
  assert.deepEqual(await sequence([[7,later[1]],earlier]),[{quantity:8,delta:-2},{quantity:7,delta:-1}]);
});
// Known unmet chronological invariance, documented in #53 comment6945558864.
// TODO is intentional: the assertions retain the desired result, not the observed loss.
test('zero-looking later observation survives reverse arrival', {todo:'POS-WEBHOOK-ZERO-001: zero-delta observation is discarded before a predecessor arrives'},async()=>{
  assert.deepEqual(await sequence([later,earlier]),expected);
});
test('replay of the missing later observation repairs history exactly once',async()=>{
  assert.deepEqual(await sequence([later,earlier,later,later]),expected);
});

