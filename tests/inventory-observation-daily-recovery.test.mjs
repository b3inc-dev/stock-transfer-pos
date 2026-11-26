/* global globalThis */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite, action, daily, replayStored, drain, originalFetch;
const event = {
  shop: "fixture.invalid", topic: "INVENTORY_LEVELS_UPDATE", session: null,
  payload: { inventory_item_id: "11", location_id: "22", available: 8, updated_at: "2026-01-04T02:00:00Z" },
};

before(async () => {
  originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("unexpected external fetch");};
  vite = await createServer({
    configFile: false, appType: "custom", server: { middlewareMode: true, hmr: false },
    plugins: [{
      name: "inventory-zero-observation-fixture", enforce: "pre",
      resolveId(id) {
        if (id === "../db.server") return "\0fixture-db";
        if (id === "../shopify.server") return "\0fixture-shopify";
        if (id === "../utils/inventory-snapshot") return "\0fixture-snapshot";
        if (id === "../utils/refresh-offline-session") return "\0fixture-refresh";
      },
      load(id) {
        if (id === "\0fixture-db") return "export default globalThis.inventoryDailyRecoveryFixture.db";
        if (id === "\0fixture-shopify") return `const f=()=>globalThis.inventoryDailyRecoveryFixture;export default {clients:{Graphql:()=>({request:async()=>new Response(JSON.stringify({data:{shop:{ianaTimezone:"UTC"},location:{name:"synthetic"},inventoryItem:{variant:{id:"gid://shopify/ProductVariant/1",sku:"SYNTHETIC"}}}}))})}};export const authenticate={webhook:async()=>{f().webhookCalls++;return f().event;}};export const sessionStorage={loadSession:async()=>f().session};`;
        if (id === "\0fixture-refresh") return `export async function refreshOfflineSessionIfNeeded(){if(globalThis.inventoryDailyRecoveryFixture.refreshFails)throw Error("synthetic refresh unavailable");}`;
        if (id === "\0fixture-snapshot") return `export const getSavedSnapshots=async()=>({shopId:"synthetic",shopTimezone:"UTC",savedSnapshots:{version:1,snapshots:[]}});export const fetchAllInventoryItems=async()=>[];export const aggregateSnapshotsFromItems=()=>[];export const saveSnapshotsForDate=async()=>({userErrors:[]});`;
      },
    }],
  });
  globalThis.inventoryDailyRecoveryFixture = { db: {}, event, webhookCalls:0 };
  ({ action, replayStoredInventoryObservation:replayStored } = await vite.ssrLoadModule("/app/routes/webhooks.inventory_levels.update.tsx"));
  ({action:daily}=await vite.ssrLoadModule("/app/routes/api.inventory-snapshot-daily.tsx"));
  ({drainInventoryObservations:drain}=await vite.ssrLoadModule("/app/utils/inventory-observation-drain.server.ts"));
});

after(async () => { globalThis.fetch=originalFetch;delete globalThis.inventoryDailyRecoveryFixture; await vite?.close(); });

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
  globalThis.inventoryDailyRecoveryFixture.db.inventoryChangeLog = {
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
  globalThis.inventoryDailyRecoveryFixture.db.inventoryWebhookObservation = {
    async upsert({where,create}) {
      assert.equal(where.shop_idempotencyKey.shop,create.shop);
      const found=observations.find(row=>row.shop===create.shop&&row.idempotencyKey===create.idempotencyKey);
      if(found)return found;
      const row={...create};observations.push(row);return row;
    },
    async findUnique({where}) {return observations.find(row=>row.shop===where.shop_idempotencyKey.shop&&row.idempotencyKey===where.shop_idempotencyKey.idempotencyKey)??null;},
    async findMany({take}) {return [...observations].sort((a,b)=>(a.lastAttemptedAt==null?-Infinity:+new Date(a.lastAttemptedAt))-(b.lastAttemptedAt==null?-Infinity:+new Date(b.lastAttemptedAt))||new Date(a.timestamp)-new Date(b.timestamp)).slice(0,take);},
    async findFirst({where}) {
      return observations.filter(row=>matches(row,where)).sort((a,b)=>(a.lastAttemptedAt==null?-Infinity:+new Date(a.lastAttemptedAt))-(b.lastAttemptedAt==null?-Infinity:+new Date(b.lastAttemptedAt))||new Date(a.timestamp)-new Date(b.timestamp)||a.idempotencyKey.localeCompare(b.idempotencyKey))[0]??null;
    },
    async updateMany({where,data}) {
      let count=0;for(const row of observations)if(matches(row,where)){Object.assign(row,data);count++;}return {count};
    },
    async deleteMany({where}) {
      let count=0;for(let i=observations.length-1;i>=0;i--)if(matches(observations[i],where)){observations.splice(i,1);count++;}return {count};
    },
  };
  return { rows, observations, restoreRead() { failedRead = null; } };
}

const deliver=async(q,time)=>{globalThis.inventoryDailyRecoveryFixture.event={...event,payload:{...event.payload,available:q,updated_at:time}};return action({request:new Request('https://fixture.invalid/webhook',{method:'POST'})});};
const cron=()=>daily({request:new Request('https://fixture.invalid/api/inventory-snapshot-daily',{method:'POST',headers:{Authorization:'Bearer synthetic-daily-key'}})});
const earlier='2026-01-04T02:00:00Z',later='2026-01-04T02:00:10Z';
test('existing authenticated daily trigger recovers after transient failure without another inventory notification',async()=>{
 const previousKey=process.env.INVENTORY_SNAPSHOT_API_KEY;process.env.INVENTORY_SNAPSHOT_API_KEY='synthetic-daily-key';
 try {
  const f=historyFixture(10,null),state=globalThis.inventoryDailyRecoveryFixture,obs=state.db.inventoryWebhookObservation,find=obs.findFirst;
  state.webhookCalls=0;await deliver(10,later);obs.findFirst=async()=>{throw Error('synthetic replay read outage');};await deliver(8,earlier);obs.findFirst=find;
  assert.equal(f.rows.length,1);assert.equal(f.observations.length,1);assert.equal(state.webhookCalls,2);
  state.session={id:'offline-synthetic',shop:event.shop,accessToken:'synthetic-token'};
  const record={...state.session,isOnline:false,expires:null,refreshToken:null};
  state.db.session={findFirst:async({where})=>{assert.equal(where.shop,event.shop);return record;},findMany:async()=>[record]};
  state.refreshFails=true;
  const failed=await (await cron()).json();assert.equal(failed.ok,false);assert.equal(failed.observationRecovery.failed,1);assert.equal(f.observations.length,1);
  state.refreshFails=false;
  const recovered=await (await cron()).json();assert.equal(recovered.ok,true);assert.equal(recovered.observationRecovery.completed,1);assert.equal(f.observations.length,0);
  assert.deepEqual([...f.rows].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).map(r=>[r.quantityAfter,r.delta]),[[8,-2],[10,2]]);
  const repeated=await (await cron()).json();assert.equal(repeated.observationRecovery.attempted,0);assert.equal(f.rows.length,2);
  assert.equal(state.webhookCalls,2,'cron recovery never requires another external inventory notification');
 }finally{if(previousKey===undefined)delete process.env.INVENTORY_SNAPSHOT_API_KEY;else process.env.INVENTORY_SNAPSHOT_API_KEY=previousKey;}
});
test('unauthorized daily request never reaches observation or snapshot data',async()=>{
 const previousKey=process.env.INVENTORY_SNAPSHOT_API_KEY;process.env.INVENTORY_SNAPSHOT_API_KEY='synthetic-daily-key';
 try{globalThis.inventoryDailyRecoveryFixture.db.inventoryWebhookObservation={findMany:async()=>{throw Error('forbidden data access');}};
  const response=await daily({request:new Request('https://fixture.invalid/api/inventory-snapshot-daily',{method:'POST'})});assert.equal(response.status,401);
 }finally{if(previousKey===undefined)delete process.env.INVENTORY_SNAPSHOT_API_KEY;else process.env.INVENTORY_SNAPSHOT_API_KEY=previousKey;}
});
test('trusted replay rejects a session from another shop before touching history',async()=>{
 const response=await replayStored({shop:'other.invalid',inventoryItemId:'11',locationId:'22',available:10,timestamp:new Date(later),adjustmentGroupId:null},{shop:event.shop});assert.equal(response.status,403);
});

test('HTTP200 cannot hide a retained nonzero-required observation; genuine zero remains retained',async()=>{
 for(const baseline of [8,10]){
  const f=historyFixture(baseline,null);f.observations.push({shop:event.shop,inventoryItemId:'11',locationId:'22',timestamp:new Date(later),available:10,idempotencyKey:'synthetic-pending'});
  const result=await drain({db:globalThis.inventoryDailyRecoveryFixture.db,replay:async()=>new Response('OK')});
  assert.equal(result.failed,baseline===8?1:0);assert.equal(result.retained,baseline===10?1:0);assert.equal(result.completed,0);assert.equal(f.rows.length,0);assert.equal(f.observations.length,1);
 }
});
test('daily recovery respects its batch time budget and reports unattempted work',async()=>{
 const f=historyFixture(10,null);let clock=0;
 f.observations.push(...['one','two'].map(idempotencyKey=>({shop:event.shop,inventoryItemId:'11',locationId:'22',timestamp:new Date(later),available:10,idempotencyKey})));
 const result=await drain({db:globalThis.inventoryDailyRecoveryFixture.db,nowMs:()=>clock,budgetMs:5,replay:async row=>{f.observations.splice(f.observations.indexOf(row),1);clock=10;return new Response('OK');}});
 assert.equal(result.scanned,2);assert.equal(result.attempted,1);assert.equal(result.completed,1);assert.equal(result.deferred,1);assert.equal(f.observations.length,1);
});

