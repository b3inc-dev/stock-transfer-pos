import { PrismaClient } from '@prisma/client';
import { createServer } from 'vite';
import { assertIsolatedRecoveryDatabase } from './isolated-pg-guard.mjs';

// Independent processes share only the explicitly guarded disposable PostgreSQL.
assertIsolatedRecoveryDatabase();
for (const key of ['log','info','warn','error']) console[key]=()=>{};
globalThis.fetch=async()=>{throw Error('external fetch forbidden in isolated acceptance');};
const prisma=new PrismaClient({log:[]});
const mode=process.argv[2];
let seedReadFailure=false;
const db=new Proxy(prisma,{get(target,key){
 if(key==='inventoryWebhookObservation')return new Proxy(target[key],{get(model,method){
  if(method==='findFirst'&&seedReadFailure)return async()=>{throw Error('synthetic replay read failure');};
  if(method==='findMany'&&mode==='concurrent')return async args=>{
   const rows=await model.findMany(args);process.send({phase:'selected',pid:process.pid,selected:rows.length});
   await new Promise(resolve=>process.once('message',message=>{if(message==='release')resolve();}));return rows;
  };
  if(method==='deleteMany'&&mode==='delete-failure')return async()=>{throw Error('synthetic cleanup failure after real history commit');};
  const value=model[method];return typeof value==='function'?value.bind(model):value;
 }});
 const value=target[key];return typeof value==='function'?value.bind(target):value;
}});
const shop='pg-recovery.invalid';
const session={id:'offline-pg-recovery',shop,accessToken:'synthetic-only-token'};
const fixture={db,event:null,session};globalThis.posPgRecoveryFixture=fixture;
let vite;
try{
 vite=await createServer({configFile:false,appType:'custom',server:{middlewareMode:true,hmr:false},plugins:[{
  name:'isolated-pg-ports',enforce:'pre',resolveId(id){
   if(id==='../db.server')return '\0pg-db';if(id==='../shopify.server')return '\0pg-shopify';
   if(id==='../utils/inventory-snapshot')return '\0pg-snapshot';if(id==='../utils/refresh-offline-session')return '\0pg-refresh';
  },load(id){
   if(id==='\0pg-db')return 'export default globalThis.posPgRecoveryFixture.db';
   if(id==='\0pg-shopify')return `const f=()=>globalThis.posPgRecoveryFixture;export default {clients:{Graphql:()=>({request:async()=>new Response(JSON.stringify({data:{shop:{ianaTimezone:'UTC'},location:{name:'synthetic'},inventoryItem:{variant:{id:'gid://shopify/ProductVariant/1',sku:'synthetic'}}}}))})}};export const authenticate={webhook:async()=>f().event};export const sessionStorage={loadSession:async id=>f().db.session.findUnique({where:{id}})};`;
   if(id==='\0pg-refresh')return `export async function refreshOfflineSessionIfNeeded(){if(process.argv[2]==='refresh-failure')throw Error('synthetic refresh failure');}`;
   if(id==='\0pg-snapshot')return `export const getSavedSnapshots=async()=>({shopId:'synthetic',shopTimezone:'UTC',savedSnapshots:{version:1,snapshots:[]}});export const fetchAllInventoryItems=async()=>[];export const aggregateSnapshotsFromItems=()=>[];export const saveSnapshotsForDate=async()=>({userErrors:[]});`;
  }
 }]});
 const {action:webhook}=await vite.ssrLoadModule('/app/routes/webhooks.inventory_levels.update.tsx');
 const {action:daily}=await vite.ssrLoadModule('/app/routes/api.inventory-snapshot-daily.tsx');
 if(mode==='seed'){
  await prisma.session.create({data:{...session,state:'synthetic',isOnline:false}});
  await prisma.inventoryChangeLog.create({data:{shop,timestamp:new Date('2026-01-03T02:00:00Z'),date:'2026-01-03',inventoryItemId:'11',locationId:'22',sku:'',locationName:'synthetic',activity:'admin_webhook',sourceType:'admin_webhook',delta:0,quantityAfter:10,idempotencyKey:'synthetic-baseline'}});
  const send=async(available,updated_at)=>{fixture.event={shop,topic:'INVENTORY_LEVELS_UPDATE',session:null,payload:{inventory_item_id:'11',location_id:'22',available,updated_at}};return webhook({request:new Request('https://synthetic.invalid/webhook',{method:'POST'})});};
  if((await send(10,'2026-01-04T02:00:10Z')).status!==200)throw Error('seed later webhook failed');
  seedReadFailure=true;if((await send(8,'2026-01-04T02:00:00Z')).status!==200)throw Error('seed anchor webhook failed');seedReadFailure=false;
  process.send({phase:'result',mode,ok:true,pid:process.pid});
 }else{
  const response=await daily({request:new Request('https://synthetic.invalid/api/inventory-snapshot-daily',{method:'POST',headers:{Authorization:'Bearer synthetic-only-daily-key'}})});
  const body=await response.json();process.send({phase:'result',mode,pid:process.pid,status:response.status,ok:body.ok,processed:body.processed,total:body.total,recovery:body.observationRecovery});
 }
}catch(error){process.send?.({phase:'failure',mode,code:typeof error.code==='string'?error.code:'ISOLATED_WORKER_FAILURE'});process.exitCode=1;}
finally{await vite?.close();await prisma.$disconnect();process.disconnect?.();}
