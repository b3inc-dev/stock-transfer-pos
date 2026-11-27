import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {assertMigrationFixture} from './retained-migration-checkpoint.mjs';

// Test-only. Refuse every non-fixture target before importing Prisma or touching DDL.
assertMigrationFixture();
assert.equal(process.env.CI,'true');
assert.equal(process.env.GITHUB_ACTIONS,'true');
const mode=process.argv[2];
assert.ok(['capture','verify'].includes(mode));
const temp=await realpath(process.env.RUNNER_TEMP);
const file=join(temp,'pos-logical-restore-checkpoint.json');
const {PrismaClient}=await import('@prisma/client');
const db=new PrismaClient({log:[]});
const digest=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v)).digest('hex');
try{
 const [version]=await db.$queryRawUnsafe('SHOW server_version_num');
 assert.ok(Number(version.server_version_num)>=160000&&Number(version.server_version_num)<170000);
 const tables=(await db.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(r=>r.tablename);
 assert.ok(tables.includes('_prisma_migrations')&&tables.includes('InventoryWebhookObservation'));
 const schema={
  columns:await db.$queryRawUnsafe("SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position"),
  constraints:await db.$queryRawUnsafe("SELECT c.relname AS table_name,o.conname,pg_get_constraintdef(o.oid,true) AS definition FROM pg_constraint o JOIN pg_class c ON c.oid=o.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,o.conname"),
  indexes:await db.$queryRawUnsafe("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")
 };
 const rows=[];
 for(const table of tables){
  assert.match(table,/^[A-Za-z_][A-Za-z0-9_]*$/);
  const values=await db.$queryRawUnsafe('SELECT to_jsonb(r)::text AS value FROM public."'+table+'" r ORDER BY to_jsonb(r)::text');
  rows.push({table,count:values.length,sha256:digest(values.map(r=>r.value))});
 }
 const sequences=await db.$queryRawUnsafe("SELECT schemaname,sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
 const migrations=await db.$queryRawUnsafe('SELECT migration_name,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name');
 assert.equal(migrations.length,13);
 assert.ok(migrations.every(r=>r.finished_at!==null&&r.rolled_back_at===null));
 const actual={tables,schema_sha256:digest(schema),rows,sequences_sha256:digest(sequences),migrations_sha256:digest(migrations)};
 if(mode==='capture')await writeFile(file,JSON.stringify(actual),'utf8');
 else assert.deepEqual(actual,JSON.parse(await readFile(file,'utf8')),'restored fixture schema/all-table rows/sequences/history must exactly match the captured fixture');
 console.log('POS_LOGICAL_RESTORE '+JSON.stringify({mode,postgres:16,table_count:tables.length,total_rows:rows.reduce((n,r)=>n+r.count,0),migration_count:13,schema_sha256:actual.schema_sha256,rows_sha256:digest(rows),sequences_sha256:actual.sequences_sha256,migrations_sha256:actual.migrations_sha256,synthetic_only:true}));
}finally{await db.$disconnect();}
