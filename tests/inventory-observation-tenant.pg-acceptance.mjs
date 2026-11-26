import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fork} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {assertIsolatedRecoveryDatabase} from './fixtures/isolated-pg-guard.mjs';

const enabled=process.env.RUN_POS_PG_RECOVERY==='1';
if(enabled)assertIsolatedRecoveryDatabase();
function worker(mode,tenant='a'){
 return new Promise((resolve,reject)=>{
  const child=fork(new URL('./fixtures/retained-observation-tenant-worker.mjs',import.meta.url),[mode],{env:{...process.env,PG_RECOVERY_TENANT:tenant,INVENTORY_SNAPSHOT_API_KEY:'synthetic-only-daily-key'},stdio:['ignore','ignore','ignore','ipc']});
  let result;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('isolated tenant worker timeout'));},30000);
  child.on('message',message=>{if(message.phase==='result')result=message;});
  child.on('error',()=>{clearTimeout(timer);reject(Error('isolated tenant worker startup failed'));});
  child.on('exit',code=>{clearTimeout(timer);if(code!==0||!result)reject(Error('isolated tenant worker failed'));else resolve(result);});
 });
}

test('PG16 two-tenant recovery uses matching offline sessions and preserves missing-tenant history',{skip:!enabled,timeout:120000},async()=>{
 const {PrismaClient,Prisma}=await import('@prisma/client');
 const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(Prisma.prismaVersion.client,lock.packages['node_modules/@prisma/client'].version);
 const db=new PrismaClient({log:[]});const shops=['pg-recovery-a.invalid','pg-recovery-b.invalid'];
 const clear=async()=>{await db.inventoryWebhookObservation.deleteMany({});await db.inventoryChangeLog.deleteMany({});await db.session.deleteMany({});};
 const history=shop=>db.inventoryChangeLog.findMany({where:{shop,timestamp:{gte:new Date('2026-01-04T00:00:00Z')}},orderBy:{timestamp:'asc'}});
 try{
  const [v]=await db.$queryRawUnsafe('SHOW server_version_num');assert.ok(Number(v.server_version_num)>=160000&&Number(v.server_version_num)<170000);
  await clear();const seedA=await worker('seed','a'),seedB=await worker('seed','b');assert.notEqual(seedA.pid,seedB.pid);
  assert.equal(await db.inventoryWebhookObservation.count(),2,'both tenant observations are retained before recovery');
  const first=await worker('healthy');assert.equal(first.status,200);assert.equal(first.ok,false);
  assert.equal(first.recovery.completed,1);assert.equal(first.recovery.failed,1);
  assert.equal(await db.inventoryWebhookObservation.count({where:{shop:shops[0]}}),0);
  assert.equal(await db.inventoryWebhookObservation.count({where:{shop:shops[1]}}),1);
  assert.deepEqual((await history(shops[0])).map(r=>[r.quantityAfter,r.delta]),[[8,-2],[10,2]],'available tenant only uses own chronology');
  assert.deepEqual((await history(shops[1])).map(r=>[r.quantityAfter,r.delta]),[[90,-10]],'missing tenant stays pending without cross-tenant writes');
  const [held]=await db.inventoryWebhookObservation.findMany({where:{shop:shops[1]}});assert.equal(held.available,100);assert.ok(held.lastAttemptedAt);

  await db.session.create({data:{id:'offline-pg-recovery-b',shop:shops[1],state:'synthetic',isOnline:false,accessToken:'synthetic-only-token-b'}});
  const recovered=await worker('healthy','b');assert.notEqual(recovered.pid,first.pid);
  assert.equal(recovered.ok,true,'restored tenant must recover with matching offline session');
  assert.equal(recovered.recovery.completed,1);assert.equal(recovered.recovery.failed,0);
  assert.equal(await db.inventoryWebhookObservation.count(),0);
  assert.deepEqual((await history(shops[0])).map(r=>[r.quantityAfter,r.delta]),[[8,-2],[10,2]]);
  assert.deepEqual((await history(shops[1])).map(r=>[r.quantityAfter,r.delta]),[[90,-10],[100,10]],'restored tenant only uses own chronology');
  const repeat=await worker('healthy');assert.equal(repeat.recovery.attempted,0);assert.equal((await history(shops[0])).length,2);assert.equal((await history(shops[1])).length,2);
  console.log('PG_TWO_TENANT_RECOVERY missing_session_isolated=pass own_session_restored=pass distinct_deltas=pass duplicate_free=pass');
 }finally{await clear();await db.$disconnect();}
});
