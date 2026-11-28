/* global process */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const path = process.env.POS_HISTORY_PARENT === '1' ? 'app/routes/__audit_parent_history.tsx' : 'app/routes/app.history.$id.tsx';
const source = readFileSync(path,'utf8');
function route(responsePayload) {
 const javascript = ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true,
 }}).outputText;
 let reads = 0, authCalls = 0;
 const module = {exports:{}};
 const injected = specifier => {
  if(specifier === '../shopify.server') return {authenticate:{admin:async()=>{authCalls++;return {admin:{graphql:async(query,options)=>{
   reads++;assert.match(query,/query TransferLineItems/);assert.deepEqual({...options.variables},{id:'gid://shopify/InventoryTransfer/101'});
   return new Response(JSON.stringify(responsePayload),{headers:{'Content-Type':'application/json'}});
  }}};}}};
  if(specifier === '../utils/graphql-with-retry') return {withGraphQLRetry:value=>value};
  if(specifier === '../components/admin-ui') return {BackAction:()=>null,StateBadge:()=>null};
  if(specifier === '../utils/transfer-status') return {transferStatusLabel:value=>value,transferStatusTone:()=>''};
  if(specifier === '@shopify/shopify-app-react-router/server') return {boundary:{error:value=>value}};
  if(specifier === 'react-router' || specifier === 'react/jsx-runtime') return require(specifier);
  throw new Error('unexpected dependency '+specifier);
 };
 const build = vm.runInNewContext('(function(require,module,exports){'+javascript+'\n})',{Response,console:{error(){}}});
 build(injected,module,module.exports);
 return {load:()=>module.exports.loader({request:new Request('https://fixture.invalid/app/history/synthetic'),params:{id:encodeURIComponent('gid://shopify/InventoryTransfer/101')}}),counts:()=>({reads,authCalls})};
}
const transfer = {id:'gid://shopify/InventoryTransfer/101',name:'synthetic transfer',status:'IN_PROGRESS',dateCreated:'2026-01-01T00:00:00Z',
 origin:{location:{id:'gid://shopify/Location/1',name:'Synthetic origin'}},destination:{location:{id:'gid://shopify/Location/2',name:'Synthetic destination'}}};
test('actual exported history loader returns React Router data for a normal transfer',async()=>{
 const item={id:'line1',quantity:3,inventoryItem:{id:'item1',sku:'fallback-sku',variant:{id:'variant1',title:'Blue',sku:'SKU1',barcode:'JAN1',selectedOptions:[{name:'Color',value:'Blue'}],product:{title:'Synthetic product'}}}};
 const r=route({data:{inventoryTransfer:{...transfer,shipments:{nodes:[{id:'shipment1',lineItems:{nodes:[item]}}]}}}});
 const result=await r.load();
 assert.equal(result.data.transfer.name,'synthetic transfer');
 assert.equal(result.data.transfer.type,'outbound');
 assert.equal(result.data.lineItems.length,1);
 assert.equal(result.data.lineItems[0].quantity,3);
 assert.equal(result.data.lineItems[0].title,'Synthetic product / Blue');
 assert.equal(result.data.lineItems[0].sku,'SKU1');
 assert.equal(result.data.lineItems[0].option1,'Blue');
 assert.equal(result.init.headers['Cache-Control'],'private, no-store');
 assert.deepEqual(r.counts(),{reads:1,authCalls:1});
});
test('actual exported loader returns an empty detail without inventing a write',async()=>{
 const r=route({data:{inventoryTransfer:{...transfer,shipments:{nodes:[]}}}});
 const result=await r.load();
 assert.equal(result.data.lineItems.length,0);
 assert.deepEqual(r.counts(),{reads:1,authCalls:1});
});
test('missing transfer keeps the existing 404 branch',async()=>{
 await assert.rejects(route({data:{inventoryTransfer:null}}).load(),error=>error instanceof Response&&error.status===404);
});
test('GraphQL error keeps the existing 500 branch',async()=>{
 await assert.rejects(route({errors:[{message:'synthetic error'}]}).load(),error=>error instanceof Response&&error.status===500);
});
