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
  const observations=[];
  globalThis.inventoryZeroObservationFixture.db.inventoryWebhookObservation = {
    async upsert({where,create}) {
      assert.equal(where.shop_idempotencyKey.shop,create.shop);
      const found=observations.find(row=>row.shop===create.shop&&row.idempotencyKey===create.idempotencyKey);
      if(found)return found;
      const row={...create};observations.push(row);return row;
    },
    async findFirst({where}) {
      return observations.filter(row=>matches(row,where)).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)||a.idempotencyKey.localeCompare(b.idempotencyKey))[0]??null;
    },
    async deleteMany({where}) {
      let count=0;for(let i=observations.length-1;i>=0;i--)if(matches(observations[i],where)){observations.splice(i,1);count++;}return {count};
    },
  };
  return { rows, observations, restoreRead() { failedRead = null; } };
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
test('zero-looking later observation survives reverse arrival',async()=>{
  assert.deepEqual(await sequence([later,earlier]),expected);
});
test('replay of the missing later observation repairs history exactly once',async()=>{
  assert.deepEqual(await sequence([later,earlier,later,later]),expected);
});

const deliver = async ([available,updated_at]) => {
 globalThis.inventoryZeroObservationFixture.event={...event,payload:{...event.payload,available,updated_at}};
 try{return await submit();}finally{globalThis.inventoryZeroObservationFixture.event=event;}
};
test('a genuine zero stays out of visible history and retains one idempotent observation',async()=>{
 const f=historyFixture(10,null);
 assert.equal((await deliver(later)).status,200);assert.equal((await deliver(later)).status,200);
 assert.equal(f.rows.length,0);assert.equal(f.observations.length,1);
 assert.deepEqual(Object.keys(f.observations[0]).sort(),['adjustmentGroupId','available','idempotencyKey','inventoryItemId','locationId','shop','timestamp'].sort());
});
test('retention unavailable or failed is not acknowledged as success',async()=>{
 for(const missing of [true,false]) {
  const f=historyFixture(10,null);
  if(missing)globalThis.inventoryZeroObservationFixture.db.inventoryWebhookObservation=undefined;
  else globalThis.inventoryZeroObservationFixture.db.inventoryWebhookObservation.upsert=async()=>{throw new Error('synthetic unavailable store');};
  assert.equal((await deliver(later)).status,503);assert.equal(f.rows.length,0);assert.equal(f.observations.length,0);
 }
});
test('foreign shop/item/location observations cannot be replayed by this anchor',async()=>{
 const f=historyFixture(10,null);
 for(const changed of [{shop:'foreign.invalid'},{inventoryItemId:'99'},{locationId:'99'}])f.observations.push({shop:event.shop,inventoryItemId:'11',locationId:'22',timestamp:new Date(later[1]),available:10,idempotencyKey:JSON.stringify(changed),...changed});
 assert.equal((await deliver(earlier)).status,200);
 assert.deepEqual(f.rows.map(r=>r.quantityAfter),[8]);assert.equal(f.observations.length,3);
});
test('a retained replay failure stays recoverable by retrying the committed anchor',async()=>{
 const f=historyFixture(10,null);await deliver(later);
 const obs=globalThis.inventoryZeroObservationFixture.db.inventoryWebhookObservation,find=obs.findFirst;
 obs.findFirst=async()=>{throw new Error('synthetic replay read unavailable');};
 assert.equal((await deliver(earlier)).status,200);assert.equal(f.rows.length,1);assert.equal(f.observations.length,1);
 obs.findFirst=find;
 assert.equal((await deliver(earlier)).status,200);
 assert.deepEqual([...f.rows].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).map(r=>({quantity:r.quantityAfter,delta:r.delta})),expected);
 assert.equal(f.observations.length,0);
});
test('retained negative movement uses the existing pending-sale classifier',async()=>{
 const f=historyFixture(10,null);let pending=[{orderId:'synthetic-sale',quantity:2,locationId:'22'}];
 globalThis.inventoryZeroObservationFixture.db.orderPendingLocation={findMany:async()=>pending,findFirst:async()=>null,deleteMany:async()=>{pending=[];return {count:1};}};
 await deliver(later);assert.equal((await deliver([12,earlier[1]])).status,200);
 assert.deepEqual(f.rows.map(r=>[r.activity,r.quantityAfter,r.delta]),[['admin_webhook',12,2],['order_sales',10,-2]]);
 assert.equal(f.observations.length,0);assert.equal(pending.length,0);
});
test('retained positive movement uses pending-refund while preserving the existing sale row',async()=>{
 const f=historyFixture(10,null);await deliver(later);
 const sold={id:'synthetic-sale-log',shop:event.shop,inventoryItemId:'11',locationId:'22',timestamp:new Date(earlier[1]),quantityAfter:8,delta:-2,activity:'order_sales',sourceType:'order_sales',sourceId:'order_synthetic',idempotencyKey:`${event.shop}:11:22:${new Date(earlier[1]).toISOString()}`,sku:'',variantId:null,locationName:'22'};
 f.rows.push(sold);const prior={...sold};let pending=[{refundId:'synthetic-refund',orderId:'synthetic',quantity:2,locationId:'22'}];
 globalThis.inventoryZeroObservationFixture.db.refundPendingLocation={findMany:async()=>pending,findFirst:async()=>null,deleteMany:async()=>{pending=[];return {count:1};}};
 assert.equal((await deliver(earlier)).status,200);assert.deepEqual(f.rows[0],prior);
 assert.deepEqual(f.rows.map(r=>[r.activity,r.quantityAfter,r.delta]),[['order_sales',8,-2],['refund',10,2]]);
 assert.equal(f.observations.length,0);assert.equal(pending.length,0);
});

