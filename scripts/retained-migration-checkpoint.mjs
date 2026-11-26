import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function assertMigrationFixture(env=process.env){
 assert.ok(env.RUN_POS_MIGRATION_REHEARSAL==='1','explicit isolated migration rehearsal opt-in required');
 assert.ok(env.DATABASE_URL==='postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test','only the exact disposable migration database is allowed');
}
const tail='20261126063000_inventory_webhook_observation';
const shops=['migration-a.invalid','migration-b.invalid'];
const historyIds=['migration-history-a','migration-history-b'];
async function checkpoint(stage){
 assertMigrationFixture();
 assert.ok(['baseline','upgrade','rerun'].includes(stage),'explicit fixture stage required');
 const {PrismaClient,Prisma}=await import('@prisma/client');
 const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 assert.equal(Prisma.prismaVersion.client,lock.packages['node_modules/@prisma/client'].version);
 const db=new PrismaClient({log:[]});
 try{
  const [version]=await db.$queryRawUnsafe('SHOW server_version_num');assert.ok(Number(version.server_version_num)>=160000&&Number(version.server_version_num)<170000);
  const dirs=(await readdir(new URL('../prisma/migrations/',import.meta.url),{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name).sort();
  assert.equal(dirs.length,13);assert.equal(dirs.at(-1),tail);
  const applied=await db.$queryRawUnsafe('SELECT migration_name,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name');
  assert.ok(applied.every(x=>x.finished_at!==null&&x.rolled_back_at===null));
  assert.deepEqual(applied.map(x=>x.migration_name),stage==='baseline'?dirs.filter(x=>x!==tail):dirs);
  const [table]=await db.$queryRawUnsafe('SELECT to_regclass(\'"InventoryWebhookObservation"\')::text AS name');
  if(stage==='baseline'){
   assert.equal(table.name,null,'baseline must not pre-create the candidate table');
   for(let i=0;i<2;i++)await db.inventoryChangeLog.create({data:{id:historyIds[i],shop:shops[i],timestamp:new Date('2026-01-01T00:00:00Z'),date:'2026-01-01',inventoryItemId:'11',locationId:'22',sku:'synthetic',locationName:'synthetic',activity:'admin_webhook',sourceType:'admin_webhook',delta:i===0?2:10,quantityAfter:i===0?12:100,idempotencyKey:'migration-history',note:'migration-preserve'}});
   await db.session.create({data:{id:'migration-offline-a',shop:shops[0],state:'synthetic-preserve',isOnline:false,accessToken:'synthetic-only-token'}});
   console.log('MIGRATION_BASELINE applied=12 history_seed=2 session_seed=1 candidate_table=absent');
  }else{
   assert.ok(table.name,'candidate migration must create the observation table');
   const rows=await db.inventoryChangeLog.findMany({where:{id:{in:historyIds}},orderBy:{id:'asc'}});
   assert.deepEqual(rows.map(r=>[r.id,r.shop,r.quantityAfter,r.delta,r.note]),[[historyIds[0],shops[0],12,2,'migration-preserve'],[historyIds[1],shops[1],100,10,'migration-preserve']]);
   const session=await db.session.findUnique({where:{id:'migration-offline-a'}});assert.ok(session&&session.shop===shops[0]&&session.state==='synthetic-preserve'&&session.accessToken==='synthetic-only-token');
   if(stage==='upgrade'){
    assert.equal(await db.inventoryWebhookObservation.count(),0);
    for(let i=0;i<2;i++)await db.inventoryWebhookObservation.create({data:{shop:shops[i],idempotencyKey:'shared-synthetic-observation',inventoryItemId:'11',locationId:'22',timestamp:new Date('2026-01-02T00:00:00Z'),available:i===0?13:101}});
   }
   await assert.rejects(db.inventoryWebhookObservation.create({data:{shop:shops[0],idempotencyKey:'shared-synthetic-observation',inventoryItemId:'11',locationId:'22',timestamp:new Date('2026-01-02T00:00:00Z'),available:999}}),error=>error.code==='P2002');
   const observations=await db.inventoryWebhookObservation.findMany({orderBy:{shop:'asc'}});
   assert.deepEqual(observations.map(r=>[r.shop,r.available,r.lastAttemptedAt]),[[shops[0],13,null],[shops[1],101,null]]);
   console.log('MIGRATION_'+stage.toUpperCase()+' applied=13 history_preserved=2 session_preserved=1 observations_preserved=2 scoped_unique=pass client='+Prisma.prismaVersion.client);
  }
 }finally{await db.$disconnect();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv[2]==='guard-only')assertMigrationFixture();else await checkpoint(process.argv[2]);}
 catch(error){console.error('ISOLATED_MIGRATION_CHECKPOINT_FAILED code='+(/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'CHECKPOINT'));process.exitCode=1;}
}
