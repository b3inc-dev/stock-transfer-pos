/* global process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('./fixtures/production-start-fetch.mjs',import.meta.url));
const dbUrl='postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test';
const enabled=process.env.RUN_POS_PG_RECOVERY==='1';
if(enabled)assert.ok(process.env.DATABASE_URL===dbUrl,'only the exact isolated production-start database is permitted');
const key='synthetic-only-daily-key';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function run(program,args,env){return new Promise((resolve,reject)=>{
 const p=spawn(program,args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('isolated command deadline'));},20000);
 p.on('error',()=>{clearTimeout(timer);reject(Error('isolated command startup failed'));});p.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
});}
test('start fixture rejects non-disposable URL before server import',async()=>{
 for(const url of ['postgresql://CANARY@remote.invalid/live',dbUrl+'?schema=public',dbUrl+'#CANARY']){
  const result=await run(process.execPath,[fixture,'guard-only'],{RUN_POS_PG_RECOVERY:'1',POS_START_FIXTURE:'1',DATABASE_URL:url});
  assert.equal(result.status,1);assert.ok(!(result.stdout+result.stderr).includes('CANARY'));
 }
});
test('actual production build npm start routes HTTP authentication and DB recovery',{skip:!enabled,timeout:150000},async()=>{
 const {PrismaClient,Prisma}=await import('@prisma/client');
 const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(Prisma.prismaVersion.client,lock.packages['node_modules/@prisma/client'].version);
 const db=new PrismaClient({log:[]}),shop='full-start-pg.invalid',temp=await mkdtemp(join(tmpdir(),'pos-start-'));let server;
 const audit=join(temp,'fetch-audit.jsonl');
 const clear=async()=>{await db.inventoryWebhookObservation.deleteMany({});await db.inventoryChangeLog.deleteMany({});await db.session.deleteMany({});};
 try{
  const [version]=await db.$queryRawUnsafe('SHOW server_version_num');assert.ok(Number(version.server_version_num)>=160000&&Number(version.server_version_num)<170000);
  await clear();await db.session.create({data:{id:'offline-full-start',shop,state:'synthetic',isOnline:false,accessToken:'synthetic-token-CANARY'}});
  for(const[time,qty,delta]of[['2026-01-03T02:00:00Z',10,0],['2026-01-04T02:00:00Z',8,-2]])await db.inventoryChangeLog.create({data:{shop,timestamp:new Date(time),date:time.slice(0,10),inventoryItemId:'11',locationId:'22',sku:'',locationName:'synthetic',activity:'admin_webhook',sourceType:'admin_webhook',quantityAfter:qty,delta,idempotencyKey:'full:'+time}});
  await db.inventoryWebhookObservation.create({data:{shop,inventoryItemId:'11',locationId:'22',available:10,timestamp:new Date('2026-01-04T02:00:10Z'),idempotencyKey:shop+':11:22:2026-01-04T02:00:10.000Z'}});
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const url='http://127.0.0.1:'+port+'/api/inventory-snapshot-daily';
  let output='';server=spawn('npm',['run','start'],{detached:true,env:{PATH:process.env.PATH,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),NODE_OPTIONS:'--import='+fixture,RUN_POS_PG_RECOVERY:'1',POS_START_FIXTURE:'1',POS_START_AUDIT_FILE:audit,DATABASE_URL:dbUrl,INVENTORY_SNAPSHOT_API_KEY:key,SHOPIFY_APP_URL:'https://runtime-fixture.invalid',SHOPIFY_API_KEY:'00000000000000000000000000000000',SHOPIFY_API_SECRET:'synthetic-quality-only',SCOPES:'read_products'},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);server.on('error',()=>{});
  let denied;for(let n=0;n<100;n++){
   try{denied=await fetch(url,{method:'POST',headers:{Authorization:'Bearer wrong-synthetic-key'}});break;}catch{await wait(100);}
  }
  assert.ok(denied,'actual npm start must serve the compiled route');assert.equal(denied.status,401);assert.equal((await denied.json()).ok,false);
  assert.equal(await db.inventoryWebhookObservation.count(),1);assert.equal(await db.inventoryChangeLog.count(),2,'compiled auth gate must not write on401');
  const get=await fetch(url);assert.equal(get.status,405,'actual router must reject GET without a loader');
  const call=()=>run(process.execPath,[fileURLToPath(new URL('../scripts/call-inventory-snapshot-daily.js',import.meta.url))],{INVENTORY_SNAPSHOT_API_URL:url,INVENTORY_SNAPSHOT_API_KEY:key});
  const first=await call();assert.equal(first.status,0,'compiled server must recover the stored observation');assert.ok(!(first.stdout+first.stderr).includes('CANARY'));const summary=JSON.parse(first.stdout);assert.equal(summary.processed,1);assert.equal(summary.total,1);assert.equal(summary.observationRecovery.completed,1);
  assert.equal(await db.inventoryWebhookObservation.count(),0);
  const history=()=>db.inventoryChangeLog.findMany({where:{shop,timestamp:{gte:new Date('2026-01-04T00:00:00Z')}},orderBy:{timestamp:'asc'}});
  assert.deepEqual((await history()).map(r=>[r.quantityAfter,r.delta]),[[8,-2],[10,2]]);
  const repeat=await call();assert.equal(repeat.status,0);assert.equal(JSON.parse(repeat.stdout).observationRecovery.attempted,0);assert.equal((await history()).length,2);
  const events=(await readFile(audit,'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.ok(events.filter(x=>x.kind==='synthetic_graphql').length>=3);assert.equal(events.filter(x=>x.kind==='denied_fetch').length,0,'only the known synthetic GraphQL boundary should be requested');assert.equal(events.filter(x=>x.kind==='denied_interval').length,0,'background periodic jobs must stay inactive');
  assert.ok(!output.includes('synthetic-token-CANARY'),'server must not print access tokens');
  console.log('PRODUCTION_START_CHAIN npm_start=pass compiled_route401=pass get405=pass child_cli_pg_plus2=pass repeat_idempotent=pass denied_fetch=0');
 }finally{
  if(server?.pid){try{process.kill(-server.pid,'SIGTERM');}catch{}await wait(100);}
  await clear();await db.$disconnect();await rm(temp,{recursive:true,force:true});
 }
});
