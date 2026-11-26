/* global process, globalThis */
import {createServer as createHttpServer} from 'node:http';
const expected='postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test';
if(process.env.RUN_POS_PG_RECOVERY!=='1'||process.env.DATABASE_URL!==expected){process.stderr.write('ISOLATED_HTTP_PG_GUARD_REJECTED\n');process.exit(1);}

if(process.argv[2]==='guard-only')process.exit(0);
const {PrismaClient}=await import('@prisma/client');
const {createServer}=await import('vite');
const db=new PrismaClient({log:[]});
for(const name of ['log','info','warn','error'])console[name]=()=>{};
globalThis.fetch=async()=>{throw Error('external fetch forbidden in isolated HTTP acceptance');};
globalThis.dailyHttpPgFixture={db};
let vite,http;
try{
 vite=await createServer({configFile:false,appType:'custom',server:{middlewareMode:true,hmr:false},plugins:[{
  name:'http-pg-synthetic-shopify-ports',enforce:'pre',resolveId(id){
   if(id==='../db.server')return '\0http-db';if(id==='../shopify.server')return '\0http-shopify';
   if(id==='../utils/inventory-snapshot')return '\0http-snapshot';if(id==='../utils/refresh-offline-session')return '\0http-refresh';
  },load(id){
   if(id==='\0http-db')return 'export default globalThis.dailyHttpPgFixture.db';
   if(id==='\0http-shopify')return `export default {clients:{Graphql:()=>({request:async()=>new Response(JSON.stringify({data:{shop:{ianaTimezone:'UTC'},location:{name:'synthetic'},inventoryItem:{variant:{id:'gid://shopify/ProductVariant/1',sku:'synthetic'}}}}))})}};export const authenticate={webhook:async()=>{throw Error('network webhook forbidden in HTTP fixture');}};export const sessionStorage={loadSession:async id=>globalThis.dailyHttpPgFixture.db.session.findUnique({where:{id}})};`;
   if(id==='\0http-refresh')return 'export async function refreshOfflineSessionIfNeeded(){}';
   if(id==='\0http-snapshot')return `export const getSavedSnapshots=async()=>({shopId:'synthetic',shopTimezone:'UTC',savedSnapshots:{version:1,snapshots:[]}});export const fetchAllInventoryItems=async()=>[];export const aggregateSnapshotsFromItems=()=>[];export const saveSnapshotsForDate=async()=>({userErrors:[]});`;
  }
 }]});
 const {action}=await vite.ssrLoadModule('/app/routes/api.inventory-snapshot-daily.tsx');
 http=createHttpServer(async(req,res)=>{
  try{
   if(req.url!=='/api/inventory-snapshot-daily'||req.method!=='POST'){res.writeHead(404);res.end();return;}
   const result=await action({request:new Request('http://127.0.0.1'+req.url,{method:'POST',headers:req.headers})});
   res.writeHead(result.status,{'Content-Type':'application/json'});res.end(await result.text());
  }catch{res.writeHead(500);res.end(JSON.stringify({ok:false,error:'isolated bridge failure'}));}
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 process.send({phase:'ready',url:'http://127.0.0.1:'+http.address().port+'/api/inventory-snapshot-daily',pid:process.pid});
 await new Promise(resolve=>process.once('message',message=>{if(message==='stop')resolve();}));
}catch{process.send?.({phase:'failure'});process.exitCode=1;}
finally{http?.closeAllConnections();await new Promise(resolve=>http?http.close(resolve):resolve());await vite?.close();await db.$disconnect();process.disconnect?.();}
