/* global process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('./fixtures/production-start-fetch.mjs',import.meta.url));
const dbUrl='postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test';
assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUN_POS_MIGRATION_REHEARSAL,'1');assert.equal(process.env.RUN_POS_PG_RECOVERY,'1');assert.equal(process.env.DATABASE_URL,dbUrl);
const key='synthetic-only-daily-key',wait=ms=>new Promise(r=>setTimeout(r,ms));
async function run(program,args,env,cwd){return new Promise((resolve,reject)=>{const p=spawn(program,args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('isolated legacy caller deadline'));},20000);p.on('error',()=>{clearTimeout(timer);reject(Error('isolated legacy caller startup'));});p.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});});}
test('deployed compiled runtime and legacy CLI preserve the forward migrated retained data before candidate recovery',{timeout:150000},async()=>{
 const legacy=await realpath(process.env.POS_LEGACY_ROOT),temporary=await realpath(process.env.RUNNER_TEMP);
 assert.equal(legacy,resolve(temporary,'legacy-root'),'only the exact isolated legacy archive is permitted');
 const {PrismaClient}=await import('@prisma/client');const db=new PrismaClient({log:[]});
 const capture=async()=>({migrations:await db.$queryRawUnsafe('SELECT * FROM _prisma_migrations ORDER BY migration_name'),history:await db.$queryRawUnsafe('SELECT * FROM "InventoryChangeLog" ORDER BY id'),sessions:await db.$queryRawUnsafe('SELECT * FROM "Session" ORDER BY id'),observations:await db.$queryRawUnsafe('SELECT * FROM "InventoryWebhookObservation" ORDER BY id')});
 const before=await capture();assert.equal(before.migrations.length,13);assert.equal(before.history.length,2);assert.equal(before.sessions.length,1);assert.equal(before.observations.length,1);
 const dir=await mkdtemp(join(tmpdir(),'pos-start-rollback-')),audit=join(dir,'fetch-audit.jsonl');let server,output='';
 try{
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const url='http://127.0.0.1:'+port+'/api/inventory-snapshot-daily';
  server=spawn('npm',['run','start'],{cwd:legacy,detached:true,env:{PATH:process.env.PATH,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),NODE_OPTIONS:'--import='+fixture,RUN_POS_PG_RECOVERY:'1',POS_START_FIXTURE:'1',POS_START_AUDIT_FILE:audit,DATABASE_URL:dbUrl,INVENTORY_SNAPSHOT_API_KEY:key,SHOPIFY_APP_URL:'https://runtime-fixture.invalid',SHOPIFY_API_KEY:'00000000000000000000000000000000',SHOPIFY_API_SECRET:'synthetic-quality-only',SCOPES:'read_products'},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);server.on('error',()=>{});
  let ready;for(let n=0;n<100;n++){try{ready=await fetch(url);break}catch{await wait(100)}}
  assert.ok(ready,'exact deployed compiled runtime must start on the forward migrated DB');assert.equal(ready.status,400);
  const result=await run(process.execPath,[join(legacy,'scripts/call-inventory-snapshot-daily.js')],{PATH:process.env.PATH,INVENTORY_SNAPSHOT_API_URL:url,INVENTORY_SNAPSHOT_API_KEY:key},legacy);
  assert.equal(result.status,0,'the actual old CLI must complete its synthetic snapshot');assert.ok(result.stdout.startsWith('Success:'));const summary=JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  assert.equal(summary.ok,true);assert.equal(summary.processed,1);assert.equal(summary.total,1);assert.equal(summary.observationRecovery,undefined,'legacy runtime must not pretend to drain new retained observations');
  assert.deepEqual(await capture(),before,'old runtime must preserve all captured retained/history/session/migration columns');
  const events=(await readFile(audit,'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.ok(events.filter(e=>e.kind==='synthetic_graphql').length>=3);assert.equal(events.filter(e=>e.kind==='denied_fetch').length,0);assert.equal(events.filter(e=>e.kind==='denied_interval').length,0);assert.ok(!(output+result.stdout+result.stderr).includes('synthetic-token-CANARY'));
  console.log('LEGACY_RUNTIME_FORWARD_DB exact_main=94fb3ea579904f65b9df9306aa7da31f84d16d06 compiled_start=pass old_cli=pass migrations13_fullrow=unchanged history2_session1_retained1_fullrow=unchanged unknown_new_table_ignored=pass denied_fetch=0');
 }finally{
  if(server?.pid){try{process.kill(-server.pid,'SIGTERM');}catch{}for(let n=0;n<100;n++){try{process.kill(-server.pid,0);await wait(20);}catch{break;}}try{process.kill(-server.pid,'SIGKILL');}catch{}}
  await db.$disconnect();await rm(dir,{recursive:true,force:true});
 }
});
