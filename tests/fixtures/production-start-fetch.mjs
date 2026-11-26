/* global process, globalThis */
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
assert.ok(process.env.RUN_POS_PG_RECOVERY==='1'&&process.env.POS_START_FIXTURE==='1','production start acceptance requires explicit isolated opt-in');
assert.ok(process.env.DATABASE_URL==='postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test','only the exact disposable database is permitted');
if(process.argv[2]==='guard-only')process.exit(0);
const audit=resolve(process.env.POS_START_AUDIT_FILE||'');
assert.ok(audit.startsWith(resolve(tmpdir())+'/pos-start-'),'audit must stay inside the generated temporary fixture directory');
const record=kind=>appendFileSync(audit,JSON.stringify({kind})+'\n');
globalThis.setInterval=()=>{record('denied_interval');throw Error('periodic dispatch forbidden in isolated production-start acceptance');};
globalThis.fetch=async(input,options)=>{
 const address=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 const url=new URL(address);
 if(url.href!=='https://full-start-pg.invalid/admin/api/2026-01/graphql.json'){
  record('denied_fetch');throw Error('external fetch forbidden by isolated production-start acceptance');
 }
 assert.equal(options?.method,'POST');
 assert.equal(options?.headers?.['X-Shopify-Access-Token'],'synthetic-token-CANARY');
 record('synthetic_graphql');
 return new Response(JSON.stringify({data:{shop:{id:'gid://shopify/Shop/1',name:'synthetic',ianaTimezone:'UTC',metafield:null},location:{name:'synthetic'},inventoryItem:{variant:{id:'gid://shopify/ProductVariant/1',sku:'synthetic'}},inventoryItems:{edges:[],pageInfo:{hasNextPage:false,endCursor:null}},metafieldsSet:{metafields:[],userErrors:[]}}}),{status:200,headers:{'Content-Type':'application/json'}});
};
