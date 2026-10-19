import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,lstatSync,mkdirSync,rmdirSync,writeFileSync,unlinkSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {nativeInventoryPostgres,inspectNativePostgresLeftovers} from './helpers/inventory-native-postgres.mjs';
const enabled=Boolean(process.env.QA_POSTGRES_BIN);
const expectedPass=mode=>mode==='pass'||mode==='poisoned';
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const owned=()=>inspectNativePostgresLeftovers().filter(x=>x.id);
const bytes=dir=>readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>{const f=path.join(dir,e.name);return n+(e.isDirectory()?bytes(f):lstatSync(f).size);},0);
const child=mode=>new Promise((resolve,reject)=>{
 const env={};for(const key of ['SystemRoot','SYSTEMROOT','PATH','Path','TEMP','TMP','HOME','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{QA_POSTGRES_BIN:process.env.QA_POSTGRES_BIN,NATIVE_PG_CHILD_MODE:mode});
 if(mode==='poisoned')Object.assign(env,{PGHOST:'192.0.2.1',PGPORT:'1',PGDATABASE:'external_forbidden',PGUSER:'external_forbidden',PGPASSWORD:'injected-test-value',PGOPTIONS:'-c statement_timeout=1',PGSSLMODE:'require'});
 const proc=spawn(process.execPath,['--test','--test-reporter=tap','tests/helpers/native-postgres-lifecycle-child.mjs'],{env,windowsHide:true});
 let output='';const timer=setTimeout(()=>reject(Error('Lifecycle child exceeded 30 seconds')),30000);
 proc.stdout.on('data',x=>{output+=x;});proc.stderr.on('data',x=>{output+=x;});proc.on('error',reject);
 proc.on('close',(code,signal)=>{clearTimeout(timer);const match=output.match(/NATIVE_PATHS=(\{[^\r\n]+\})/);resolve({code,signal,output,paths:match?JSON.parse(match[1]):null});});
});
const deleted=runtime=>{
 assert.equal(existsSync(runtime.dir),false);
 const log=readFileSync(path.join(runtime.logDir,'server.log'));
 const diagnostics=json(path.join(runtime.logDir,'diagnostics.json'));
 assert.equal(createHash('sha256').update(log).digest('hex'),diagnostics.logSha256);
 assert.equal(diagnostics.server.code,0);assert.equal(diagnostics.server.signal,null);assert.equal(diagnostics.liveChildren,0);
};
test('native PostgreSQL lifecycle safety',{skip:!enabled,timeout:120000},async t=>{
 const before=owned().map(x=>x.path);
 await t.test('normal stop is idempotent and archives verified evidence',async()=>{
  const runtime=await nativeInventoryPostgres();
  try{const db=new runtime.Database();await db.exec('create table proof(value int);insert into proof values(7)');assert.equal((await db.query('select value from proof')).rows[0].value,7);}
  finally{const results=await Promise.all([runtime.stop(),runtime.stop(),runtime.stop()]);assert.ok(results.every(x=>x.status==='deleted'));}
  deleted(runtime);
 });
 for(const mode of ['pass','poisoned','failure','timeout'])await t.test('test runner '+mode+' preserves outcome and cleans data',async()=>{
  const run=await child(mode);assert.ok(run.paths,run.output);assert.equal(run.code,expectedPass(mode)?0:1,run.output);assert.equal(run.signal,null);
  deleted(run.paths);const diagnostics=json(path.join(run.paths.logDir,'diagnostics.json'));
  assert.equal(diagnostics.outcome.passed,expectedPass(mode));
  if(mode==='failure')assert.match(JSON.stringify(diagnostics),/EXPECTED_NATIVE_TEST_FAILURE/);
  if(mode==='timeout')assert.match(JSON.stringify(diagnostics),/timed out|timeout/i);
 });
 await t.test('pg_ctl failure preserves data and retry only stops the same child',async()=>{
  let fail=true;
  const runtime=await nativeInventoryPostgres({spawnProcess:(file,args,options)=>path.basename(file).startsWith('pg_ctl')&&fail?spawn(process.execPath,['-e',"process.stderr.write('EXPECTED_STOP_FAILURE');process.exit(9)"],options):spawn(file,args,options)});
  try{const result=await runtime.stop();assert.equal(result.status,'preserved');assert.match(result.reason,/EXPECTED_STOP_FAILURE/);assert.ok(existsSync(runtime.dir));assert.ok(existsSync(path.join(runtime.dir,'postmaster.pid')));assert.match(readFileSync(path.join(runtime.logDir,'commands.json'),'utf8'),/EXPECTED_STOP_FAILURE/);}
  finally{fail=false;assert.equal((await runtime.stop()).status,'deleted');}deleted(runtime);
 });
 await t.test('PID mismatch never stops another live cluster',async()=>{
  const [a,b]=await Promise.all([nativeInventoryPostgres(),nativeInventoryPostgres()]);
  const pidFile=path.join(a.dir,'postmaster.pid'),original=readFileSync(pidFile),foreignPid=readFileSync(path.join(b.dir,'postmaster.pid'),'utf8').split(/\r?\n/)[0];
  try{
   writeFileSync(pidFile,original.toString().replace(/^\d+/,foreignPid));
   assert.equal((await a.stop()).status,'preserved');assert.ok(existsSync(a.dir));
   const client=await b.connect('postgres');assert.equal((await client.query('select 1 as alive')).rows[0].alive,1);
   assert.equal(inspectNativePostgresLeftovers().find(x=>x.path===b.dir).status,'active-or-uncertain-preserved');
  }finally{writeFileSync(pidFile,original);await a.stop();await b.stop();}
  deleted(a);deleted(b);
 });
 await t.test('an altered ownership token forbids both shutdown and deletion',async()=>{
  const runtime=await nativeInventoryPostgres(),marker=path.join(runtime.dir,'.baba-native-postgres-owner.json'),original=readFileSync(marker);
  try{writeFileSync(marker,'{}');assert.equal((await runtime.stop()).status,'preserved');assert.ok(existsSync(path.join(runtime.dir,'postmaster.pid')));assert.ok(existsSync(runtime.dir));}
  finally{writeFileSync(marker,original);await runtime.stop();}deleted(runtime);
 });
 await t.test('archive failure preserves data until evidence can be verified',async()=>{
  const runtime=await nativeInventoryPostgres(),blocked=path.join(runtime.logDir,'server.log');mkdirSync(blocked);
  try{assert.equal((await runtime.stop()).status,'preserved');assert.ok(existsSync(runtime.dir));assert.ok(existsSync(path.join(runtime.dir,'server.log')));}
  finally{rmdirSync(blocked);assert.equal((await runtime.stop()).status,'deleted');}deleted(runtime);
 });
 await t.test('linked foreign data is protected',async()=>{
  const [a,b]=await Promise.all([nativeInventoryPostgres(),nativeInventoryPostgres()]);const link=path.join(a.dir,'foreign-cluster');
  try{symlinkSync(b.dir,link,process.platform==='win32'?'junction':'dir');assert.equal((await a.stop()).status,'preserved');assert.ok(existsSync(a.dir));const c=await b.connect('postgres');assert.equal((await c.query('select 2 as alive')).rows[0].alive,2);}
  finally{unlinkSync(link);await a.stop();await b.stop();}deleted(a);deleted(b);
 });
 await t.test('exclusive cleanup claim prevents duplicate directory deletion',async()=>{
  const runtime=await nativeInventoryPostgres(),lock=path.join(runtime.dir,'.baba-cleanup.lock');writeFileSync(lock,'another cleanup');
  try{assert.equal((await runtime.stop()).status,'preserved');assert.ok(existsSync(runtime.dir));}
  finally{unlinkSync(lock);await runtime.stop();}deleted(runtime);
 });
 await t.test('a registered test child must exit before data deletion',async()=>{
  const runtime=await nativeInventoryPostgres();
  const proc=runtime.trackChild(spawn(process.execPath,['-e','setTimeout(()=>{},2500)'],{windowsHide:true}));
  const closed=new Promise(resolve=>proc.once('close',resolve));
  try{assert.equal((await runtime.stop()).status,'preserved');assert.ok(existsSync(runtime.dir));}
  finally{await closed;assert.equal((await runtime.stop()).status,'deleted');}deleted(runtime);
 });
 await t.test('parallel clusters keep same database names and data isolated',async()=>{
  const [a,b]=await Promise.all([nativeInventoryPostgres(),nativeInventoryPostgres()]);
  try{assert.notEqual(a.dir,b.dir);assert.notEqual(a.id,b.id);const da=new a.Database(),db=new b.Database();assert.equal(da.name,db.name);await Promise.all([da.exec('create table proof(value int);insert into proof values(11)'),db.exec('create table proof(value int);insert into proof values(22)')]);assert.equal((await da.query('select value from proof')).rows[0].value,11);await a.stop();assert.equal((await db.query('select value from proof')).rows[0].value,22);}
  finally{await Promise.all([a.stop(),b.stop()]);}deleted(a);deleted(b);
 });
 await t.test('stopped orphan candidates are report-only and ambiguous ownership is retained',async()=>{
  const hooks=[],controller=new AbortController();
  const context={name:'simulated abandoned owner',signal:controller.signal,after:fn=>hooks.push(fn),afterEach:()=>{},diagnostic:()=>{}};
  const runtime=await nativeInventoryPostgres({testContext:context});
  const marker=path.join(runtime.dir,'.baba-native-postgres-owner.json'),original=readFileSync(marker);
  try{
   await runtime.stop();assert.equal(existsSync(runtime.dir),true);
   const report=inspectNativePostgresLeftovers().find(x=>x.path===runtime.dir);assert.equal(report.status,'owned-review-candidate');assert.equal(report.automaticDeletion,false);
   writeFileSync(marker,'{}');assert.equal(inspectNativePostgresLeftovers().find(x=>x.path===runtime.dir).status,'unowned-preserved');assert.equal(existsSync(runtime.dir),true);
  }finally{writeFileSync(marker,original);await hooks[0]({...context,passed:true,error:null});}deleted(runtime);
 });
 await t.test('a child registered after stop still blocks final deletion',async()=>{
  const hooks=[],controller=new AbortController();
  const context={name:'late child',signal:controller.signal,after:fn=>hooks.push(fn),afterEach:()=>{},diagnostic:()=>{}};
  const runtime=await nativeInventoryPostgres({testContext:context});await runtime.stop();
  const proc=runtime.trackChild(spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{windowsHide:true}));
  const closed=new Promise(resolve=>proc.once('close',resolve));
  try{await assert.rejects(hooks[0]({...context,passed:true,error:null}),/cleanup incomplete/);assert.equal(runtime.cleanupResult.status,'preserved');assert.ok(existsSync(runtime.dir));}
  finally{await closed;await hooks[0]({...context,passed:true,error:null});}deleted(runtime);
 });
 await t.test('three repeated executions retain small logs and zero new data clusters',async()=>{
  const samples=[];
  for(let i=0;i<3;i++){const runtime=await nativeInventoryPostgres();await runtime.stop();deleted(runtime);samples.push({remaining:owned().length,logBytes:bytes(runtime.logDir)});}
  assert.deepEqual(owned().map(x=>x.path),before);assert.ok(samples.every(s=>s.remaining===before.length&&s.logBytes<100000));t.diagnostic(JSON.stringify(samples));
 });
 assert.deepEqual(owned().map(x=>x.path),before);
});
