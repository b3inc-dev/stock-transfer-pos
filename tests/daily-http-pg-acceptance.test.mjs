/* global process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fork,spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const worker=new URL('./fixtures/daily-http-pg-worker.mjs',import.meta.url);
const url='postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test';
const enabled=process.env.RUN_POS_PG_RECOVERY==='1';
if(enabled)assert.ok(process.env.DATABASE_URL===url,'only the exact isolated HTTP PG fixture is permitted');
const key='synthetic-only-daily-key';
function child(program,args,env){return new Promise((resolve,reject)=>{
 const p=spawn(program,args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('isolated child deadline'));},20000);
 p.on('error',()=>{clearTimeout(timer);reject(Error('isolated child failed'));});p.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
});}
test('PG HTTP fixture rejects remote/query/canary before Prisma import',async()=>{
 for(const db of ['postgresql://secret-CANARY@remote.invalid/live',url+'?schema=public',url+'#CANARY']){
  const result=await child(process.execPath,[fileURLToPath(worker),'guard-only'],{RUN_POS_PG_RECOVERY:'1',DATABASE_URL:db});
  assert.equal(result.status,1);assert.equal(result.stderr,'ISOLATED_HTTP_PG_GUARD_REJECTED\n');assert.ok(!(result.stdout+result.stderr).includes('CANARY'));
 }
});
test('real HTTP authentication gates Prisma recovery and repeated strict CLI stays idempotent',{skip:!enabled,timeout:120000},async()=>{
 const {PrismaClient,Prisma}=await import('@prisma/client');
 const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(Prisma.prismaVersion.client,lock.packages['node_modules/@prisma/client'].version);
 const db=new PrismaClient({log:[]}),shop='http-pg-recovery.invalid';let server;
 const clear=async()=>{await db.inventoryWebhookObservation.deleteMany({});await db.inventoryChangeLog.deleteMany({});await db.session.deleteMany({});};
 try{
  const [v]=await db.$queryRawUnsafe('SHOW server_version_num');assert.ok(Number(v.server_version_num)>=160000&&Number(v.server_version_num)<170000);
  await clear();await db.session.create({data:{id:'offline-http-pg',shop,state:'synthetic',isOnline:false,accessToken:'synthetic-token-CANARY'}});
  for(const [time,qty,delta] of [['2026-01-03T02:00:00Z',10,0],['2026-01-04T02:00:00Z',8,-2]])await db.inventoryChangeLog.create({data:{shop,timestamp:new Date(time),date:time.slice(0,10),inventoryItemId:'11',locationId:'22',sku:'',locationName:'synthetic',activity:'admin_webhook',sourceType:'admin_webhook',quantityAfter:qty,delta,idempotencyKey:'http:'+time}});
  await db.inventoryWebhookObservation.create({data:{shop,inventoryItemId:'11',locationId:'22',available:10,timestamp:new Date('2026-01-04T02:00:10Z')}});
  const p=fork(worker,[],{env:{PATH:process.env.PATH,DATABASE_URL:url,RUN_POS_PG_RECOVERY:'1',INVENTORY_SNAPSHOT_API_KEY:key},stdio:['ignore','ignore','ignore','ipc']});
  server=p;const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('HTTP worker ready deadline')),20000);p.once('error',()=>{clearTimeout(timer);reject(Error('HTTP worker failed'));});p.on('message',m=>{if(m.phase==='ready'){clearTimeout(timer);resolve(m);}else if(m.phase==='failure'){clearTimeout(timer);reject(Error('HTTP worker rejected'));}});});
  assert.match(ready.url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/api\/inventory-snapshot-daily$/);assert.notEqual(ready.pid,process.pid);
  const denied=await fetch(ready.url,{method:'POST',headers:{Authorization:'Bearer wrong-synthetic-key'}});
  assert.equal(denied.status,401);assert.equal((await denied.json()).ok,false);
  assert.equal(await db.inventoryWebhookObservation.count(),1,'unauthorized HTTP must not drain stored observations');assert.equal(await db.inventoryChangeLog.count(),2,'unauthorized HTTP must not write history');
  const call=()=>child(process.execPath,[fileURLToPath(new URL('../scripts/call-inventory-snapshot-daily.js',import.meta.url))],{INVENTORY_SNAPSHOT_API_URL:ready.url,INVENTORY_SNAPSHOT_API_KEY:key});
  const first=await call();assert.equal(first.status,0,'authenticated HTTP CLI must complete DB recovery');assert.ok(!(first.stdout+first.stderr).includes('CANARY'));const body=JSON.parse(first.stdout);
  assert.equal(body.observationRecovery.completed,1);assert.equal(body.observationRecovery.failed,0);assert.equal(body.processed,1);assert.equal(body.total,1);
  assert.equal(await db.inventoryWebhookObservation.count(),0);
  const history=()=>db.inventoryChangeLog.findMany({where:{shop,timestamp:{gte:new Date('2026-01-04T00:00:00Z')}},orderBy:{timestamp:'asc'}});
  assert.deepEqual((await history()).map(r=>[r.quantityAfter,r.delta]),[[8,-2],[10,2]],'HTTP chain must persist the positive recovered delta');
  const second=await call();assert.equal(second.status,0);assert.equal(JSON.parse(second.stdout).observationRecovery.attempted,0);assert.equal((await history()).length,2,'repeated HTTP must not duplicate recovered history');
  console.log('HTTP_PG_CHAIN auth401_no_write=pass child_http_daily_prisma=pass delta_plus2=pass repeat_duplicate_free=pass external=0');
 }finally{
  if(server){server.send('stop');await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},5000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}
  await clear();await db.$disconnect();
 }
});
