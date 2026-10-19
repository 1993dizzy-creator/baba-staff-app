import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {appendFileSync,existsSync,lstatSync,mkdtempSync,mkdirSync,openSync,closeSync,readFileSync,readdirSync,realpathSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
const {Client}=pg;
const marker='.baba-native-postgres-owner.json';
const hash=data=>createHash('sha256').update(data).digest('hex');
const describe=e=>e?{name:e.name,message:e.message,stack:e.stack,cause:e.cause?{message:e.cause.message,stack:e.cause.stack}:undefined}:null;
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PostgreSQL lifecycle timeout')),ms);})]);}finally{clearTimeout(timer);}}
function save(file,data){writeFileSync(file,data);if(hash(readFileSync(file))!==hash(data))throw Error('Evidence verification failed');}
function noLinks(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name),s=lstatSync(f);if(s.isSymbolicLink())throw Error('Linked data is protected');if(s.isDirectory())noLinks(f);}}

// Existing fixture API. spawnProcess is injectable only for fault tests.
export async function nativeInventoryPostgres({testContext,spawnProcess=spawn}={}){
 if(!process.env.QA_POSTGRES_BIN)throw Error('QA_POSTGRES_BIN must name local PostgreSQL binaries');
 const bin=path.resolve(process.env.QA_POSTGRES_BIN),root=path.resolve('.qa-review');mkdirSync(root,{recursive:true});
 if(lstatSync(root).isSymbolicLink()||realpathSync(root)!==root)throw Error('Linked QA root is protected');
 const logRoot=path.join(root,'pg-native-logs');mkdirSync(logRoot,{recursive:true});
 if(lstatSync(logRoot).isSymbolicLink())throw Error('Linked log root is protected');
 const id=randomUUID();
 const dir=mkdtempSync(path.join(root,'pg-native-test-'+id+'-')),identity=lstatSync(dir,{bigint:true});
 const logDir=path.join(logRoot,path.basename(dir));mkdirSync(logDir);
 const owner={format:'baba-native-postgres-v1',id,dir,createdAt:new Date().toISOString(),ownerPid:process.pid};
 const ownerText=JSON.stringify(owner,null,2);save(path.join(logDir,'owner.json'),ownerText);
 const serverLog=path.join(dir,'server.log'),clients=new Set(),children=new Set(),failures=[],commands=[];
 let server,serverClosed,serverResult,closing=false,initialized=false,shutdownPromise,cleanupPromise,result,loggingError;
 let startupDone;const startupFinished=new Promise(resolve=>{startupDone=resolve;});
 const record=e=>{if(e)failures.push(describe(e));};
 const trackChild=child=>{children.add(child);child.once('close',()=>children.delete(child));child.once('error',record);return child;};
 const exe=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
 // No .env loading, PG* settings, URLs or production credentials in child env.
 const env={};for(const k of ['SystemRoot','SYSTEMROOT','PATH','Path','TEMP','TMP','HOME','USERPROFILE','LD_LIBRARY_PATH','DYLD_LIBRARY_PATH'])if(process.env[k])env[k]=process.env[k];
 Object.assign(env,{LANG:'C',LC_ALL:'C'});
 const owned=()=>{
  if(path.dirname(path.resolve(dir))!==root||!path.basename(dir).startsWith('pg-native-test-'))throw Error('Data path escaped QA root');
  const stat=lstatSync(dir,{bigint:true});
  if(stat.isSymbolicLink()||stat.ino!==identity.ino||realpathSync(dir)!==dir)throw Error('Data directory identity changed');
  if(readFileSync(path.join(logDir,'owner.json'),'utf8')!==ownerText||readFileSync(path.join(dir,marker),'utf8')!==ownerText)throw Error('Ownership not verified');
 };
 const run=(name,args)=>new Promise((resolve,reject)=>{
  const child=spawnProcess(exe(name),args,{env,windowsHide:true});children.add(child);let output='',error,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill();reject(Error(name+' timed out'));},30000);
  child.stdout?.on('data',x=>{output+=x;});child.stderr?.on('data',x=>{output+=x;});child.once('error',e=>{error=e;});
  child.once('close',(code,signal)=>{clearTimeout(timer);children.delete(child);commands.push({name,args,code,signal,timedOut,output});if(error||timedOut||code!==0)reject(error??Error(name+' failed: '+output));else resolve(output);});
 });
 const archive=(status,outcome)=>{
  if(loggingError)throw loggingError;
  if(lstatSync(logDir).isSymbolicLink()||path.dirname(realpathSync(logDir))!==realpathSync(logRoot))throw Error('Log directory changed');
  const log=existsSync(serverLog)?readFileSync(serverLog):Buffer.alloc(0);
  save(path.join(logDir,'server.log'),log);save(path.join(logDir,'commands.json'),JSON.stringify(commands,null,2));
  save(path.join(logDir,'diagnostics.json'),JSON.stringify({owner,status,outcome,testName:testContext?.name,failures,server:serverResult??null,liveChildren:children.size,logSha256:hash(log)},null,2));
  return {logSha256:hash(log),logBytes:log.length};
 };
 const shutdown=()=>{
  if(shutdownPromise)return shutdownPromise;
  closing=true;
  shutdownPromise=(async()=>{try{
   await bounded(startupFinished,35000);owned();
   const endings=Promise.allSettled([...clients].map(c=>c.end()));
   await bounded(endings,200).catch(()=>{});
   // An exited child can still have open pipes; never signal its old PID.
   if(server&&!serverResult&&(server.exitCode!==null||server.signalCode!==null))await bounded(serverClosed,8000);
   if(server&&!serverResult){
    const pidFile=path.join(dir,'postmaster.pid');
    // Both the live ChildProcess handle and its own PID file must agree.
    if(!existsSync(pidFile)||Number(readFileSync(pidFile,'utf8').split(/\r?\n/)[0])!==server.pid)throw Error('Cannot prove live server identity');
    await run('pg_ctl',['-D',dir,'-m','fast','-w','-t','5','stop']);await bounded(serverClosed,8000);
   }
   if(server&&(serverResult?.code!==0||serverResult?.signal))throw Error('Server did not exit normally');
   if(children.size||existsSync(path.join(dir,'postmaster.pid')))throw Error('Cluster or helper child may still be active');
   if(!initialized)throw Error('Initialization incomplete');
   if((await bounded(endings,3000)).some(x=>x.status==='rejected'))throw Error('Client closure failed');
   if(server&&!readFileSync(serverLog,'utf8').includes('database system is shut down'))throw Error('Normal shutdown evidence missing');
   return {status:'stopped'};
  }catch(e){record(e);return {status:'preserved',reason:e.message};}})();
  return shutdownPromise.then(r=>{if(r.status==='preserved')shutdownPromise=undefined;return r;});
 };
 const cleanup=outcome=>{
  if(result?.status==='deleted')return Promise.resolve(result);
  if(cleanupPromise)return cleanupPromise;
  cleanupPromise=(async()=>{let claimed=false;try{
   const stopped=await shutdown(),evidence=archive(stopped.status,outcome);
   if(stopped.status!=='stopped')return result={...stopped,dir,logDir};
   owned();noLinks(dir);
   if(children.size)throw Error('Test child is still running');
   const lock=openSync(path.join(dir,'.baba-cleanup.lock'),'wx');
   try{writeFileSync(lock,id);claimed=true;}finally{closeSync(lock);}
   if(children.size||server&&!serverResult||existsSync(path.join(dir,'postmaster.pid')))throw Error('Cluster or test child may be in use');
   if(hash(readFileSync(serverLog))!==evidence.logSha256)throw Error('Log changed after archive');owned();
   // Only this invocation's identity-checked absolute directory is removed.
   rmSync(dir,{recursive:true});result={status:'deleted',dir,logDir,...evidence};
   save(path.join(logDir,'result.json'),JSON.stringify({result,outcome,failures},null,2));
   testContext?.diagnostic('Native PostgreSQL evidence: '+logDir+'; data deleted');return result;
  }catch(e){record(e);return result={status:existsSync(dir)?'preserved':'deleted',reason:e.message,dir,logDir};}
  finally{if(claimed&&existsSync(dir)){try{owned();const lockFile=path.join(dir,'.baba-cleanup.lock');if(readFileSync(lockFile,'utf8')===id)unlinkSync(lockFile);}catch(e){record(e);}}}})();
  return cleanupPromise.finally(()=>{if(result?.status!=='deleted')cleanupPromise=undefined;});
 };
 const stop=async()=>{
  if(result?.status==='deleted')return result;
  if(!testContext)return cleanup({failures});
  return shutdown();
 };
 const abort=()=>{record(testContext.signal.reason);void shutdown();};
 if(testContext){
  testContext.afterEach(context=>record(context.error));
  testContext.after(async context=>{
   record(context.error);const r=await cleanup({passed:context.passed,error:describe(context.error),abortReason:describe(context.signal.reason)});
   testContext.signal.removeEventListener('abort',abort);
   if(r.status!=='deleted'){
    context.diagnostic('Native PostgreSQL data preserved: '+dir+'; '+r.reason);
    // Do not replace an existing test failure with a teardown failure.
    if(context.passed)throw Error('Native PostgreSQL cleanup incomplete: '+r.reason);
   }
  },{timeout:45000});
  testContext.signal.addEventListener('abort',abort,{once:true});
 }
 const initialize=async()=>{
  await run('initdb',['-D',dir,'-U','postgres','--auth=trust','--locale=C','--encoding=UTF8']);initialized=true;
  save(path.join(dir,marker),ownerText);save(serverLog,'');
  if(closing||testContext?.signal.aborted)throw Error('Test cancelled during initialization');
  const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise((resolve,reject)=>probe.close(e=>e?reject(e):resolve()));
  server=spawnProcess(exe('postgres'),['-D',dir,'-h','127.0.0.1','-p',String(port),'-c','cluster_name=baba-qa-'+id,'-c','log_lock_waits=on','-c','deadlock_timeout=100ms'],{env,windowsHide:true});
  serverClosed=new Promise(resolve=>server.once('close',(code,signal)=>{serverResult={code,signal};resolve(serverResult);}));
  await new Promise((resolve,reject)=>{
   let logs='';const timer=setTimeout(()=>reject(Error('PostgreSQL startup timeout')),8000),clear=()=>clearTimeout(timer);
   const data=x=>{try{appendFileSync(serverLog,x);}catch(e){loggingError=e;clear();reject(e);}logs+=x;if(logs.includes('ready to accept connections')){clear();resolve();}};
   server.stderr.on('data',data);server.stdout.on('data',data);server.on('error',e=>{clear();reject(e);});server.once('close',()=>{clear();reject(Error('PostgreSQL exited during startup'));});
  });
  const config={host:'127.0.0.1',port,user:'postgres',database:'postgres',password:'baba-local-test-only',options:'-c statement_timeout=0',ssl:false,connectionTimeoutMillis:3000,application_name:'baba-qa-'+id};
  const connect=async database=>{if(closing)throw Error('Test PostgreSQL is stopping');const c=new Client({...config,database});clients.add(c);c.on('error',record);await c.connect();return c;};
  const admin=await connect('postgres');
  if(path.resolve((await admin.query('show data_directory')).rows[0].data_directory)!==dir||(await admin.query('show cluster_name')).rows[0].cluster_name!=='baba-qa-'+id)throw Error('Unexpected test cluster identity');
  const version=(await admin.query('select version() as version')).rows[0].version;let counter=0;
  class Database{
   constructor(){this.name='qa_case_'+(++counter);this.ready=(async()=>{await admin.query('create database '+this.name);this.client=await connect(this.name);})();}
   async exec(sql){await this.ready;const roles='create role anon; create role authenticated; create role service_role;';if(counter>1)sql=sql.replace(roles,'');return this.client.query(sql);}
   async query(sql,args=[]){await this.ready;return this.client.query(sql,args);}
   async close(){if(this.client){await this.client.end();clients.delete(this.client);}}
  }
  return {Database,connect,version,dir,id,logDir,stop,trackChild,get cleanupResult(){return result;}};
 };
 try{return await initialize().finally(startupDone);}catch(e){record(e);await cleanup({startupError:describe(e)});throw e;}
}

// Reporting only: a PID is never sufficient proof to delete an orphan.
export function inspectNativePostgresLeftovers(){
 const root=path.resolve('.qa-review');if(!existsSync(root))return [];
 if(lstatSync(root).isSymbolicLink())return [{path:root,status:'unowned-preserved',automaticDeletion:false}];
 return readdirSync(root).filter(n=>/^pg-native-(?:test|smoke)-/.test(n)).map(name=>{
  const dir=path.join(root,name);
  try{
   if(lstatSync(dir).isSymbolicLink())throw Error('Linked cluster');
   const owner=JSON.parse(readFileSync(path.join(dir,marker),'utf8')),archiveOwner=JSON.parse(readFileSync(path.join(root,'pg-native-logs',name,'owner.json'),'utf8'));
   if(owner.format!=='baba-native-postgres-v1'||!/^[-0-9a-f]{36}$/.test(owner.id)||owner.dir!==dir||JSON.stringify(owner)!==JSON.stringify(archiveOwner))throw Error('Ownership not verified');
   return {path:dir,id:owner.id,status:existsSync(path.join(dir,'postmaster.pid'))?'active-or-uncertain-preserved':'owned-review-candidate',automaticDeletion:false};
  }catch(e){return {path:dir,status:'unowned-preserved',automaticDeletion:false,reason:e.message};}
 });
}
