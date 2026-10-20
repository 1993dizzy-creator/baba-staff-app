import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {setupKegSafety} from './helpers/keg-safety-fixture.mjs';
const migration='supabase/migrations/20261020120000_keg_safety_p0.sql',version='20261020120000',name='keg_safety_p0';
const sql=readFileSync(migration,'utf8'),cli=path.resolve(process.env.QA_SUPABASE_CLI_BIN||'.qa-review/keg-p0/cli-2.81.3/supabase.exe');
const run=(args,cwd,runtime)=>new Promise((resolve,reject)=>{
 const env={};for(const key of ['SystemRoot','SYSTEMROOT','PATH','TEMP','TMP','LOCALAPPDATA','APPDATA'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{CI:'true',USERPROFILE:cwd,DOCKER_CONFIG:cwd,PGSSLMODE:'disable'});
 const child=spawn(cli,args,{cwd,env,windowsHide:true});runtime?.trackChild(child);let output='';const timer=setTimeout(()=>child.kill(),30000);
 child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,output});});
});
const signatures=["inventory_preview_keg_change(text,bigint,bigint,timestamptz,date,text,numeric)","inventory_apply_keg_change(text,bigint,bigint,timestamptz,date,text,numeric,text,uuid,text,boolean)"];
async function history(db){return(await db.query('select version,name,statements from supabase_migrations.schema_migrations order by version')).rows;}
async function protectedState(db){return(await db.query("select jsonb_build_object('rpc',(select jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'owner',proowner,'acl',proacl,'config',proconfig) order by proname,pg_get_function_identity_arguments(oid)) from pg_proc where pronamespace='public'::regnamespace and proname in ('replace_inventory_keg','calculate_inventory_keg_sales')),'inventory',(select jsonb_agg(i order by id) from inventory i),'logs',(select jsonb_agg(l order by id) from inventory_logs l),'sessions',(select jsonb_agg(s order by id) from inventory_keg_sessions s),'acl',(select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl,'rls',relrowsecurity) order by relname) from pg_class where relnamespace='public'::regnamespace and relname in ('inventory','inventory_logs','inventory_keg_sessions','inventory_keg_tracking_mappings')),'triggers',(select jsonb_agg(pg_get_triggerdef(oid) order by tgname) from pg_trigger where not tgisinternal and tgrelid in ('inventory'::regclass,'inventory_logs'::regclass,'inventory_keg_sessions'::regclass))) state")).rows[0].state;}
async function objects(db){return(await db.query("select (select count(*)::int from pg_class where relnamespace='public'::regnamespace and relname='inventory_keg_safety_audit' and relkind='r') tables,(select count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname in ('inventory_preview_keg_change','inventory_apply_keg_change')) functions,(select count(*)::int from supabase_migrations.schema_migrations where version='20261020120000') history")).rows[0];}
async function assertFinalAcl(db){
 for(const signature of signatures)for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows[0].allowed,role==='service_role');
 const pubs=await db.query("select count(*)::int n from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.pronamespace='public'::regnamespace and p.proname in ('inventory_preview_keg_change','inventory_apply_keg_change') and a.grantee=0");assert.equal(pubs.rows[0].n,0);
 for(const role of ['anon','authenticated','service_role'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await db.query("select has_table_privilege($1,'inventory_keg_safety_audit',$2) allowed",[role,privilege])).rows[0].allowed,role==='service_role'&&privilege==='SELECT');
 assert.equal((await db.query("select relrowsecurity from pg_class where oid='inventory_keg_safety_audit'::regclass")).rows[0].relrowsecurity,true);
}

test('actual Supabase CLI 2.81.3: Keg DDL + history atomicity, visibility and replay',{skip:!process.env.QA_POSTGRES_BIN,timeout:120000},async t=>{
 const checked=await run(['--version'],path.dirname(cli));assert.equal(checked.code,0,checked.output);assert.match(checked.output,/^2\.81\.3\s*$/m);
 const runtime=await nativeInventoryPostgres({testContext:t}),fixtures=[];const evidence={cliVersion:'2.81.3',cliSha256:createHash('sha256').update(readFileSync(cli)).digest('hex'),postgres:runtime.version,migrationSha256:createHash('sha256').update(sql).digest('hex'),actualCliInvoked:true,command:'supabase.exe db push --db-url <owned loopback qa_case_N URL> --workdir <isolated workspace> --yes',scenarios:[]};
 async function fixture(text=sql){
  const db=new runtime.Database();await setupKegSafety(db,{installDraft:false});await db.exec("create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);insert into supabase_migrations.schema_migrations values('202607230003','unify_keg_sales_calculation',array['isolated baseline already applied']);insert into users values(1,'alice','Alice','staff',true);insert into inventory(id,quantity,unit,package_content_quantity,package_content_unit) values(3,10,'Keg',20000,'ml');insert into inventory_logs(id,item_id,source) values(77,3,'keg_replace');insert into inventory_keg_sessions(id,inventory_item_id,status,started_at,started_business_date,capacity_quantity) values(141,3,'active','2026-10-15T10:00Z','2026-10-15',20000)");
  const dir=mkdtempSync(path.resolve('.qa-review/keg-p0/cli-work-'));mkdirSync(path.join(dir,'supabase','migrations'),{recursive:true});writeFileSync(path.join(dir,'supabase','config.toml'),'project_id = "keg-safety-isolated-test"\n[db]\nmajor_version = 17\n');writeFileSync(path.join(dir,'supabase','migrations','202607230003_unify_keg_sales_calculation.sql'),readFileSync('supabase/migrations/202607230003_unify_keg_sales_calculation.sql'));writeFileSync(path.join(dir,'supabase','migrations',version+'_'+name+'.sql'),text);
  const {host,port,database}=db.client.connectionParameters;assert.equal(host,'127.0.0.1');assert.match(database,/^qa_case_\d+$/);assert.ok(Number(port)>1024);const url=new URL('postgresql://postgres@127.0.0.1:'+port+'/'+database);url.searchParams.set('sslmode','disable');
  const f={db,dir,apply:()=>run(['db','push','--db-url',url.toString(),'--workdir',dir,'--yes'],dir,runtime)};fixtures.push(f);return f;
 }
 const save=(label,result,extra={})=>{evidence.scenarios.push({label,...extra,cliExit:result.code,output:result.output});};let success;
 try{
  await t.test('success commits one audit table, two RPCs and one history row; existing data and RPC ACLs stay unchanged',async()=>{
   success=await fixture();const old=await protectedState(success.db),before=await history(success.db),result=await success.apply();assert.equal(result.code,0,result.output);assert.doesNotMatch(result.output,/no transaction in progress|already a transaction/i);assert.deepEqual(await objects(success.db),{tables:1,functions:2,history:1});assert.deepEqual(await protectedState(success.db),old);await assertFinalAcl(success.db);
   const after=await history(success.db);assert.equal(after.length,before.length+1);assert.deepEqual(after[0],before[0]);const entry=after.find(r=>r.version===version);assert.equal(entry.name,name);assert.ok(entry.statements.length>1);assert.ok(!entry.statements.some(s=>/^\s*(begin|commit|rollback)\s*;/i.test(s.replace(/--[^\r\n]*/g,''))));
   await success.db.exec(readFileSync('supabase/verification/20261020120000_keg_safety_p0_postflight.sql','utf8'));save('success',result,{objects:await objects(success.db),postflightReadOnly:true});
  });
  await t.test('runner history INSERT failure rolls back every new table/function/ACL and preserves baseline history',async()=>{
   const f=await fixture();await f.db.exec("create function qa_reject_keg_history() returns trigger language plpgsql as $$begin if new.version='20261020120000' then raise exception 'qa_history_insert_failure';end if;return new;end$$;create trigger qa_reject before insert on supabase_migrations.schema_migrations for each row execute function qa_reject_keg_history()");const old=await protectedState(f.db),before=await history(f.db),result=await f.apply();assert.notEqual(result.code,0,result.output);assert.match(result.output,/qa_history_insert_failure/);assert.deepEqual(await objects(f.db),{tables:0,functions:0,history:0});assert.deepEqual(await protectedState(f.db),old);assert.deepEqual(await history(f.db),before);save('history INSERT failure',result,{objects:await objects(f.db)});
  });
  await t.test('SQL failure after creating the table and preview RPC rolls back DDL/default ACL and history',async()=>{
   const f=await fixture(sql.replace('create function public.inventory_apply_keg_change(','select 1/0;\ncreate function public.inventory_apply_keg_change(')),old=await protectedState(f.db),before=await history(f.db),result=await f.apply();assert.notEqual(result.code,0,result.output);assert.match(result.output,/division by zero/);assert.deepEqual(await objects(f.db),{tables:0,functions:0,history:0});assert.deepEqual(await protectedState(f.db),old);assert.deepEqual(await history(f.db),before);save('SQL failure after partial DDL',result,{objects:await objects(f.db)});
  });
  await t.test('other connection cannot see staged objects/default PUBLIC execute before REVOKE or final ACL before history commit',async()=>{
   const key1=810021001,key2=810021002,text=sql.replace('create function public.inventory_apply_keg_change(',`select pg_advisory_xact_lock(${key1});\ncreate function public.inventory_apply_keg_change(`)+`\nselect pg_advisory_xact_lock(${key2});\n`,f=await fixture(text),observer=await runtime.connect(f.db.name),blocker=await runtime.connect(f.db.name);try{
    const defaultPublic=(await observer.query("select exists(select 1 from aclexplode(acldefault('f',(select oid from pg_roles where rolname='postgres'))) where grantee=0 and privilege_type='EXECUTE') allowed")).rows[0].allowed;assert.equal(defaultPublic,true);
    await blocker.query('select pg_advisory_lock($1),pg_advisory_lock($2)',[key1,key2]);const pending=f.apply();let error;const gates=[];
    const blocked=async key=>{const end=Date.now()+10000;while(Date.now()<end){const r=await observer.query("select count(*)::int n from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database() and l.locktype='advisory' and not l.granted and l.objid=$1",[key]);if(r.rows[0].n>0)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Runner never reached advisory gate '+key);};
    try{for(const key of [key1,key2]){await blocked(key);const state=await objects(observer);assert.deepEqual(state,{tables:0,functions:0,history:0});for(const signature of signatures)assert.equal((await observer.query('select to_regprocedure($1) fn',[signature])).rows[0].fn,null);gates.push({key,objects:state});await blocker.query('select pg_advisory_unlock($1)',[key]);}}
    catch(e){error=e;}finally{await blocker.query('select pg_advisory_unlock_all()');}
    const result=await pending;if(error)throw error;assert.equal(result.code,0,result.output);assert.deepEqual(await objects(observer),{tables:1,functions:2,history:1});await assertFinalAcl(observer);save('visibility before REVOKE and before history',result,{defaultPublicExecute:true,gates,objects:await objects(observer)});
   }finally{await observer.end();await blocker.end();}
  });
  await t.test('successful migration rerun skips safely with unchanged DDL/ACL/data/full history',async()=>{
   const before={protected:await protectedState(success.db),history:await history(success.db),objects:await objects(success.db)},result=await success.apply();assert.equal(result.code,0,result.output);assert.doesNotMatch(result.output,/Applying migration 20261020120000/);assert.deepEqual({protected:await protectedState(success.db),history:await history(success.db),objects:await objects(success.db)},before);await assertFinalAcl(success.db);save('rerun skip',result,{objects:before.objects});
  });
 }finally{writeFileSync('.qa-review/keg-p0/cli-atomicity-evidence.json',JSON.stringify(evidence,null,2));for(const f of fixtures)await f.db.close();await runtime.stop();}
});