import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';

const goodRecovery={scanned:1,attempted:1,completed:1,retained:0,failed:0,deferred:0,batchLimitReached:false};
for(const [name,body,status,exit] of [
 ['complete',{ok:true,processed:1,total:1,observationRecovery:goodRecovery},200,0],
 ['snapshot partial',{ok:true,processed:5,total:6,errors:['SENSITIVE-CANARY'],observationRecovery:goodRecovery},200,1],
 ['recovery failure',{ok:true,processed:1,total:1,observationRecovery:{...goodRecovery,completed:0,failed:1}},200,1],
 ['budget deferred',{ok:true,processed:1,total:1,observationRecovery:{...goodRecovery,scanned:2,deferred:1}},200,1],
 ['inconsistent counters',{ok:true,processed:1,total:1,observationRecovery:{...goodRecovery,completed:0}},200,1],
 ['malformed batch flag string',{ok:true,processed:1,total:1,observationRecovery:{...goodRecovery,batchLimitReached:'SENSITIVE-CANARY'}},200,1],
 ['malformed batch flag object',{ok:true,processed:1,total:1,observationRecovery:{...goodRecovery,batchLimitReached:{secret:'SENSITIVE-CANARY'}}},200,1],
 ['HTTP error',{ok:false,processed:0,total:1,error:'SENSITIVE-CANARY',observationRecovery:goodRecovery},500,1],
])test(`cron result ${name} uses exact counts and redacts raw bodies`,()=>{
 const source=`globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(body))},{status:${status}});await import(${JSON.stringify(new URL('../scripts/call-inventory-snapshot-daily.js',import.meta.url).href)});`;
 const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{env:{INVENTORY_SNAPSHOT_API_URL:'https://synthetic.invalid',INVENTORY_SNAPSHOT_API_KEY:'synthetic-test-key'},encoding:'utf8'});
 assert.equal(result.status,exit,result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/SENSITIVE-CANARY|synthetic-test-key|synthetic\.invalid/);
 const summary=JSON.parse(result.stdout.trim());assert.equal(summary.ok,exit===0);assert.equal(summary.status,status);
});
