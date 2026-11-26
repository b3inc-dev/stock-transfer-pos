/* global process, setTimeout */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../scripts/call-inventory-snapshot-daily.js',import.meta.url));
const key='SYNTHETIC-CRON-KEY-CANARY';
const privateBody='SYNTHETIC-PRIVATE-BODY-CANARY';
const recovery={scanned:1,attempted:1,completed:1,retained:0,failed:0,deferred:0,batchLimitReached:false};
const complete={ok:true,processed:1,total:1,observationRecovery:recovery,ignoredPrivate:privateBody};
function run(program,args,env){
 return new Promise((resolve,reject)=>{
  const child=spawn(program,args,{env:{PATH:process.env.PATH,...env},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('synthetic child exceeded its finite deadline'));},10000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,stdout,stderr});});
 });
}
async function fixture(t,respond){
 let requests=0;
 const server=createServer((request,response)=>{
  requests++;assert.equal(request.method,'POST');assert.equal(request.url,'/api/inventory-snapshot-daily');
  assert.equal(request.headers.authorization,'Bearer '+key);
  respond(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port+'/api/inventory-snapshot-daily';
 assert.match(url,/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/api\/inventory-snapshot-daily$/);
 return {url,requests:()=>requests};
}
const invoke=url=>run(process.execPath,[cli],{INVENTORY_SNAPSHOT_API_URL:url,INVENTORY_SNAPSHOT_API_KEY:key});
function anonymous(result){
 assert.equal(result.signal,null);
 assert.ok(!(result.stdout+result.stderr).includes(key),'credential must not reach child output');
 assert.ok(!(result.stdout+result.stderr).includes(privateBody),'raw response must not reach child output');
}
test('real child POST/auth and chunked HTTP success produce only anonymous counters',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});const body=JSON.stringify(complete);res.write(body.slice(0,21));setTimeout(()=>res.end(body.slice(21)),10);});
 const result=await invoke(f.url);anonymous(result);assert.equal(result.status,0);assert.equal(f.requests(),1);
 assert.deepEqual(JSON.parse(result.stdout),{ok:true,status:200,processed:1,total:1,errors:0,observationRecovery:recovery});
});
test('real curl exits zero for HTTP200 partial while strict child exits nonzero',async t=>{
 const body={...complete,processed:5,total:6,errors:[privateBody]};
 const f=await fixture(t,(_req,res)=>{res.writeHead(200);res.end(JSON.stringify(body));});
 const curl=await run('curl',['--silent','--show-error','--request','POST',f.url,'--header','Authorization: Bearer '+key],{});
 assert.equal(curl.status,0);assert.equal(JSON.parse(curl.stdout).processed,5);
 const strict=await invoke(f.url);anonymous(strict);assert.equal(strict.status,1);assert.equal(f.requests(),2);
 assert.equal(JSON.parse(strict.stdout).errors,1);assert.equal(JSON.parse(strict.stdout).ok,false);
});
for(const [name,status,body] of [
 ['HTTP500',500,{...complete,ok:false,error:privateBody}],
 ['malformed JSON',200,privateBody],
 ['recovery failure',200,{...complete,observationRecovery:{...recovery,completed:0,failed:1}}],
 ['malformed recovery flag',200,{...complete,observationRecovery:{...recovery,batchLimitReached:privateBody}}],
])test('real child rejects '+name+' without raw response output',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(status);res.end(typeof body==='string'?body:JSON.stringify(body));});
 const result=await invoke(f.url);anonymous(result);assert.equal(result.status,1);assert.equal(f.requests(),1);
 if(name!=='malformed JSON')assert.equal(JSON.parse(result.stdout).ok,false);
});
test('real socket failure is nonzero and has no raw transport error',async t=>{
 const f=await fixture(t,(req)=>req.socket.destroy());const result=await invoke(f.url);
 anonymous(result);assert.equal(result.status,1);assert.ok(f.requests()>=1);assert.equal(result.stdout,'');
 assert.equal(result.stderr,'Error calling API:\nSnapshot request failed; inspect the authenticated service logs.\n');
});
