import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertMigrationFixture} from '../scripts/retained-migration-checkpoint.mjs';
const expected='postgresql://postgres:test-only-local@127.0.0.1:5432/commercor_test';
test('migration fixture exact opt-in URL accepts without importing Prisma',()=>assert.doesNotThrow(()=>assertMigrationFixture({RUN_POS_MIGRATION_REHEARSAL:'1',DATABASE_URL:expected})));
test('migration fixture rejects unsafe or normalization-only URLs without secret error metadata',()=>{
 for(const value of [undefined,' '+expected,expected+'\n',expected+'?',expected+'#',expected+'?host=remote.invalid',expected.replace('127.0.0.1','remote.invalid'),expected.replace('test-only-local','SENSITIVE-CANARY'),expected.replace('/commercor_test','/live')]){
  let error;try{assertMigrationFixture({RUN_POS_MIGRATION_REHEARSAL:'1',DATABASE_URL:value});}catch(e){error=e;}
  assert.ok(error);assert.doesNotMatch(String(error.stack)+JSON.stringify(error),/SENSITIVE-CANARY/);
 }
});
test('migration fixture missing or malformed opt-in fails before database setup',()=>{
 for(const value of [undefined,'0','true','SENSITIVE-CANARY']){
  let error;try{assertMigrationFixture({RUN_POS_MIGRATION_REHEARSAL:value,DATABASE_URL:expected});}catch(e){error=e;}
  assert.ok(error);assert.doesNotMatch(String(error.stack)+JSON.stringify(error),/SENSITIVE-CANARY/);
 }
});
