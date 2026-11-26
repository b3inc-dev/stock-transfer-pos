/* global process */
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export function assertQualityFixture(env=process.env,root=process.cwd()){
 assert.ok(env.CI==='true'&&env.GITHUB_ACTIONS==='true','quality observation requires isolated Actions');
 assert.ok(env.GITHUB_WORKSPACE===root,'quality observation must use the isolated checkout');
 assert.ok(env.DATABASE_URL==='postgresql://quality:synthetic-only@127.0.0.1:1/no_connection','no live/shared database is permitted');
 assert.ok(env.SHOPIFY_APP_URL==='https://quality.invalid','only the synthetic application URL is permitted');
 assert.ok(env.SHOPIFY_API_KEY==='00000000000000000000000000000000'&&env.SHOPIFY_API_SECRET==='synthetic-quality-only','only synthetic build credentials are permitted');
}
const normalize=(text,roots)=>roots.reduce((s,r)=>s.replaceAll(r,'<workspace>'),text).replace(/\u001b\[[0-9;]*m/g,'');
function typeDiagnostics(text,roots){
 const out=[];let current;
 for(const line of normalize(text,roots).split('\n')){
  const match=line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if(match){current={file:match[1],line:Number(match[2]),column:Number(match[3]),code:match[4],message:match[5]};out.push(current);}
  else if(current&&/^\s+\S/.test(line))current.message+=' '+line.trim();
  else current=null;
 }
 return out;
}
function lintDiagnostics(text,root,roots){
 let results;
 for(const line of text.split('\n'))if(line.trim().startsWith('[')){try{const value=JSON.parse(line);if(Array.isArray(value))results=value;}catch{ /* npm preamble is not the formatter payload */ }}
 assert.ok(results,'lint JSON formatter must be observed, never inferred as zero');
 return results.flatMap(result=>(result.messages??[]).filter(m=>m.severity===2).map(m=>({file:path.relative(root,result.filePath),line:m.line,column:m.column,code:m.ruleId??'fatal',message:normalize(m.message,roots)})));
}
function addedDiagnostics(before,after){
 const counts=new Map();const key=d=>JSON.stringify([d.file,d.code,d.message]);
 for(const d of before)counts.set(key(d),(counts.get(key(d))??0)+1);
 return after.filter(d=>{const k=key(d),n=counts.get(k)??0;if(n){counts.set(k,n-1);return false;}return true;});
}
async function observe(baseline){
 const root=process.cwd();assertQualityFixture();
 const temporary=await realpath(process.env.RUNNER_TEMP),base=await realpath(baseline);
 assert.ok(base.startsWith(temporary+path.sep),'baseline must be an isolated temporary archive');
 assert.equal(await realpath(path.join(base,'node_modules')),await realpath(path.join(root,'node_modules')));
 const mainLock=await readFile(path.join(base,'package-lock.json')),candidateLock=await readFile(path.join(root,'package-lock.json'));
 assert.ok(mainLock.equals(candidateLock),'both snapshots require the same exact repository lock');
 const logs=[];
 const run=(cwd,program,args,label)=>{
  const result=spawnSync(program,args,{cwd,env:{...process.env,FORCE_COLOR:'0'},encoding:'utf8',maxBuffer:64*1024*1024});
  assert.ok(!result.error&&result.status!==null,'quality command must actually finish');
  const text=(result.stdout??'')+(result.stderr??'');logs.push([label,text]);return {status:result.status,text};
 };
 const snapshots=[];
 for(const [label,cwd] of [['main',base],['candidate',root]]){
  assert.equal(run(cwd,path.join(root,'node_modules/.bin/prisma'),['generate','--schema',path.join(cwd,'prisma/schema.prisma')],label+'-generate').status,0);
  const type=run(cwd,'npm',['run','typecheck','--','--pretty','false'],label+'-type');
  const lint=run(cwd,'npm',['run','lint','--','--format','json'],label+'-lint');
  const build=run(cwd,'npm',['run','build'],label+'-build');
  const types=typeDiagnostics(type.text,[root,base]);
  if(type.status!==0&&!types.length)process.stdout.write('POS_TYPE_TOOL_UNOBSERVED '+label+' '+JSON.stringify(type.text.slice(-6000))+'\n');
  let lints;try{lints=lintDiagnostics(lint.text,cwd,[root,base]);}catch(error){process.stdout.write('POS_LINT_TOOL_UNOBSERVED '+label+' '+JSON.stringify(lint.text.slice(-6000))+'\n');throw error;}
  assert.ok(type.status===0||types.length>0,'failed type tool with no diagnostics is unobserved, not green');
  snapshots.push({label,typeExit:type.status,lintExit:lint.status,buildExit:build.status,types,lints});
 }
 for(const [name,text] of logs)await writeFile(path.join(temporary,'pos-'+name+'.log'),text);
 const [main,candidate]=snapshots,addedTypes=addedDiagnostics(main.types,candidate.types),addedLint=addedDiagnostics(main.lints,candidate.lints);
 const summary={main:{typeExit:main.typeExit,typeErrors:main.types.length,lintExit:main.lintExit,lintErrors:main.lints.length,buildExit:main.buildExit},candidate:{typeExit:candidate.typeExit,typeErrors:candidate.types.length,lintExit:candidate.lintExit,lintErrors:candidate.lints.length,buildExit:candidate.buildExit},addedTypeErrors:addedTypes.length,addedLintErrors:addedLint.length,fullQualityGreen:candidate.typeExit===0&&candidate.lintExit===0&&candidate.buildExit===0,lockSha256:createHash('sha256').update(candidateLock).digest('hex')};
 const report={...summary,addedTypes,addedLint,comparison:'normalized file+code+fullmessage multiset, positions retained but not used to tolerate shifted lines; not semantic whole-program equivalence',limitations:['Existing debt remains an integration gate','Lint observations are not waived by this report','No real database/Shopify/Store/device/deployment acceptance']};
 await writeFile(path.join(temporary,'pos-quality-report.json'),JSON.stringify(report,null,2));
 process.stdout.write('POS_QUALITY_OBSERVATION '+JSON.stringify(summary)+'\n');
 process.stdout.write('POS_QUALITY_ADDED_TYPES '+JSON.stringify(addedTypes.slice(0,30))+'\n');
 process.stdout.write('POS_QUALITY_ADDED_LINT '+JSON.stringify(addedLint.slice(0,30))+'\n');
 if(main.buildExit!==0||candidate.buildExit!==0){process.stdout.write('POS_QUALITY_BUILD_FAILURE '+logs.filter(([n])=>n.endsWith('-build')).map(([n,t])=>n+'\n'+t.split('\n').slice(-25).join('\n')).join('\n'));process.exitCode=1;}
 else if(addedTypes.length){process.stdout.write('POS_QUALITY_BLOCKED=new_type_diagnostics\n');process.exitCode=1;}
 else process.stdout.write('POS_QUALITY_SCOPE=build_and_type_delta_observed full_quality_green='+summary.fullQualityGreen+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv[2]==='guard-only')assertQualityFixture();else await observe(process.argv[2]);}
 catch(error){process.stderr.write('ISOLATED_QUALITY_OBSERVATION_FAILED code='+(/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'OBSERVATION')+'\n');process.exitCode=1;}
}
