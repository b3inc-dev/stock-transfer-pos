import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';

import { assertIsolatedRecoveryDatabase } from './fixtures/isolated-pg-guard.mjs';

const enabled=process.env.RUN_POS_PG_RECOVERY==='1';
if(enabled&&process.argv[2]!=='seed'&&!['refresh-failure','healthy','concurrent','delete-failure'].includes(process.argv[2]))assertIsolatedRecoveryDatabase();

function worker(mode){
 const child=fork(new URL('./fixtures/retained-observation-pg-worker.mjs',import.meta.url),[mode],{
  env:{...process.env,INVENTORY_SNAPSHOT_API_KEY:'synthetic-only-daily-key'},stdio:['ignore','ignore','ignore','ipc'],
 });
 const messages=[];let selectedResolve,selectedReject;const selected=new Promise((resolve,reject)=>{selectedResolve=resolve;selectedReject=reject;});
 const done=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('isolated worker timeout'));},30000);
  child.on('message',message=>{messages.push(message);if(message.phase==='selected')selectedResolve(message);});
  child.on('error',()=>{clearTimeout(timer);reject(Error('isolated worker startup failed'));});
  child.on('exit',code=>{clearTimeout(timer);const result=messages.find(x=>x.phase==='result');if(mode==='concurrent'&&!messages.some(x=>x.phase==='selected'))selectedReject(Error('worker exited before barrier'));if(code!==0||!result)reject(Error('isolated worker did not complete'));else resolve(result);});
 });
 return {child,selected,done};
}

// Worker imports only the guard; do not register parent tests inside a child.
if(!['seed','refresh-failure','healthy','concurrent','delete-failure'].includes(process.argv[2])){
 test('PG16 Prisma recovery persists across process restart, concurrent drains and committed cleanup failure',{skip:!enabled,timeout:180000},async()=>{
  const {PrismaClient}=await import('@prisma/client');const db=new PrismaClient({log:[]});
  const shop='pg-recovery.invalid';
  const clear=async()=>{await db.inventoryWebhookObservation.deleteMany({});await db.inventoryChangeLog.deleteMany({});await db.session.deleteMany({});};
  const states=async()=>({observations:await db.inventoryWebhookObservation.count(),history:await db.inventoryChangeLog.findMany({where:{shop,timestamp:{gte:new Date('2026-01-04T00:00:00Z')}},orderBy:{timestamp:'asc'}})});
  try{
   const [v]=await db.$queryRawUnsafe('SHOW server_version_num');assert.ok(Number(v.server_version_num)>=160000&&Number(v.server_version_num)<170000,'actual PostgreSQL16 required');
   await clear();await worker('seed').done;assert.equal((await states()).observations,1);
   const failed=await worker('refresh-failure').done;assert.equal(failed.ok,false);assert.equal(failed.recovery.failed,1);assert.equal((await states()).observations,1);
   const recovered=await worker('healthy').done;assert.equal(recovered.ok,true);assert.equal(recovered.recovery.completed,1);
   let state=await states();assert.equal(state.observations,0);assert.deepEqual(state.history.map(r=>[r.quantityAfter,r.delta]),[[8,-2],[10,2]]);
   const repeat=await worker('healthy').done;assert.equal(repeat.recovery.attempted,0);assert.equal((await states()).history.length,2);

   await clear();await worker('seed').done;
   const left=worker('concurrent'),right=worker('concurrent');const selected=await Promise.all([left.selected,right.selected]);
   assert.notEqual(selected[0].pid,selected[1].pid);assert.equal(selected[0].selected,1);assert.equal(selected[1].selected,1);
   left.child.send('release');right.child.send('release');await Promise.all([left.done,right.done]);
   state=await states();assert.equal(state.observations,0);assert.deepEqual(state.history.map(r=>[r.quantityAfter,r.delta]),[[8,-2],[10,2]]);

   await clear();await worker('seed').done;
   const cleanupFailure=await worker('delete-failure').done;assert.equal(cleanupFailure.ok,false);assert.equal(cleanupFailure.recovery.failed,1);
   state=await states();assert.equal(state.observations,1);assert.equal(state.history.length,2,'history commit survives injected post-write cleanup failure');
   await worker('healthy').done;state=await states();assert.equal(state.observations,0);assert.equal(state.history.length,2,'fresh process cleanup retry never duplicates committed history');
   console.log('PG16_PRISMA_RECOVERY restart=pass concurrent_two_processes=pass post_commit_cleanup_retry=pass');
  }finally{await clear();await db.$disconnect();}
 });
}
