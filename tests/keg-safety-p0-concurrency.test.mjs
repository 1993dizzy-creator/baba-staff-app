import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import {setupKegSafety,seedKegSafety,previewKeg,applyKeg,kegState} from './helpers/keg-safety-fixture.mjs';

// Explicit opt-in, new disposable cluster, loopback only. No env file or remote DB URL.
test('native PostgreSQL locks: same-key retry, two actors, replacement/time race, rollback and query plans',{skip:!process.env.KEG_TEST_PG_BIN},async t=>{
 const bin=path.resolve(process.env.KEG_TEST_PG_BIN),dir=mkdtempSync(path.resolve('.qa-review/keg-p0/native-'));
 const run=(exe,args)=>new Promise((resolve,reject)=>{const p=spawn(path.join(bin,exe+'.exe'),args,{windowsHide:true});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('close',code=>code?reject(Error(output)):resolve(output));});
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const clients=[];let started=false;
 try{
  await run('initdb',['-D',dir,'-U','postgres','--auth=trust','--locale=C','--encoding=UTF8']);
  const server=spawn(path.join(bin,'postgres.exe'),['-D',dir,'-h','127.0.0.1','-p',String(port)],{windowsHide:true});started=true;
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(text)),10000);server.stderr.on('data',b=>{text+=b;if(text.includes('ready to accept connections')){clearTimeout(timer);resolve();}});server.on('error',reject);});
  const connect=async()=>{const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await c.connect();await c.query("set statement_timeout='8s'");c.exec=sql=>c.query(sql);clients.push(c);return c;};
  const admin=await connect(),a=await connect(),b=await connect();await setupKegSafety(admin,{installDraft:false});
  const report={version:(await admin.query('select version() v')).rows[0].v,scenarios:[]};
  await t.test('complete DDL/RLS/ACL file is one transaction: every intermediate failure rolls back and no other connection sees partial objects',async()=>{
   const sql=readFileSync('supabase/drafts/keg_safety_p0.sql','utf8');
   // Dollar bodies, quoted literals and comments are single tokens; only top-level semicolons split.
   const tokens=sql.match(/--[^\r\n]*|\/\*[\s\S]*?\*\/|\$\$[\s\S]*?\$\$|'(?:''|[^'])*'|"(?:""|[^"])*"|[^'"$;/-]+|./gs);
   const statements=[];let statement='';for(const token of tokens){statement+=token;if(token===';'){statements.push(statement);statement='';}}assert.equal(statement.trim(),'');
   const clean=s=>s.replace(/--[^\r\n]*/g,'').trim();assert.equal(clean(statements[0]).toLowerCase(),'begin;');assert.equal(clean(statements.at(-1)).toLowerCase(),'commit;');
   const catalog=async()=> (await b.query("select jsonb_build_object('rpc',(select jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(oid),'acl',proacl) order by proname) from pg_proc where pronamespace='public'::regnamespace and proname in ('replace_inventory_keg','calculate_inventory_keg_sales')),'triggers',(select jsonb_agg(pg_get_triggerdef(oid) order by tgname) from pg_trigger where not tgisinternal),'tableAcl',(select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl,'rls',relrowsecurity) order by relname) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p'))) state")).rows[0].state;
   const old=await catalog(),invisible=async()=>{const r=(await b.query("select to_regclass('public.inventory_keg_safety_audit') audit,(select count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname in ('inventory_preview_keg_change','inventory_apply_keg_change')) functions")).rows[0];assert.equal(r.audit,null);assert.equal(r.functions,0);assert.deepEqual(await catalog(),old);};
   for(let failAfter=1;failAfter<statements.length-1;failAfter++){
    for(const s of statements.slice(0,failAfter+1))await admin.query(s);
    await assert.rejects(admin.query('select 1/0'),/division by zero/);await invisible();await admin.query('rollback');await invisible();
   }
   for(const s of statements.slice(0,-1)){await admin.query(s);await invisible();}
   await admin.query(statements.at(-1));assert.ok((await b.query("select to_regclass('public.inventory_keg_safety_audit') audit")).rows[0].audit);
   const installed=await catalog();assert.deepEqual(installed.rpc,old.rpc);assert.deepEqual(installed.triggers,old.triggers);assert.deepEqual(installed.tableAcl.filter(r=>r.name!=='inventory_keg_safety_audit'),old.tableAcl);
   report.ddlTransaction={failurePoints:statements.length-2,partialObjectsVisible:false,existingRpcTriggerAclUnchanged:true};
  });
  const blocked=async()=>{for(let i=0;i<200;i++){const n=(await admin.query('select count(*) n from pg_locks where pid=$1 and not granted',[b.processID])).rows[0].n;if(Number(n)>0)return;await new Promise(r=>setTimeout(r,5));}assert.fail('Expected actual lock contention');};
  await t.test('same UUID blocks then replays the committed result with exactly one deduction',async()=>{
   await seedKegSafety(admin);const p=await previewKeg(admin,{action:'replace',at:'2026-07-10T11:00Z'});await a.query('begin');const first=await applyKeg(a,p);const pending=applyKeg(b,p);await blocked();await a.query('commit');const retry=await pending;
   assert.equal(retry.logId,first.logId);assert.equal(retry.replayed,true);const s=await kegState(admin);assert.equal(s.inventory[0].quantity,9);assert.equal(s.audit.length,1);assert.equal(s.logs.length,2);report.scenarios.push('same-key replay');
  });
  await t.test('two staff with different UUIDs serialize; second stale replacement makes no deduction',async()=>{
   await seedKegSafety(admin);const p=await previewKeg(admin,{action:'replace',at:'2026-07-10T11:00Z'}),q=await previewKeg(admin,{action:'replace',at:'2026-07-10T11:00Z',actor:'bob'});
   await a.query('begin');await applyKeg(a,p);const pending=applyKeg(b,q,{actor:'bob',key:'20000000-0000-4000-8000-000000000002'}).then(value=>({value}),error=>({error}));await blocked();await a.query('commit');const result=await pending;assert.match(result.error?.message||'',/KEG_QUANTITY_CONFLICT|KEG_STALE_PREVIEW/);assert.equal((await kegState(admin)).inventory[0].quantity,9);report.scenarios.push('two staff');
  });
  await t.test('simultaneous time edits and time-edit/replacement race reject stale boundaries',async()=>{
   for(const otherAction of ['edit-start','replace']){
    await seedKegSafety(admin);const p=await previewKeg(admin),q=await previewKeg(admin,{action:otherAction,at:'2026-07-10T11:00Z',actor:'bob'});
    await a.query('begin');await applyKeg(a,p);const pending=applyKeg(b,q,{actor:'bob',key:'20000000-0000-4000-8000-000000000002'}).then(value=>({value}),error=>({error}));await blocked();await a.query('commit');const result=await pending;assert.match(result.error?.message||'',/KEG_STALE_PREVIEW/);const state=await kegState(admin);assert.equal(state.inventory[0].quantity,10);assert.equal(state.audit.length,1);
   }report.scenarios.push('time/time and time/replace');
  });
  await t.test('failure after audit INSERT rolls back stock, log, sessions, and audit on native PostgreSQL',async()=>{
   await seedKegSafety(admin);const p=await previewKeg(admin,{action:'replace',at:'2026-07-10T11:00Z'}),before=await kegState(admin);
   await admin.query("create function qa_fail() returns trigger language plpgsql as $$begin raise exception 'injected after insert';end$$;create trigger qa_fail after insert on inventory_keg_safety_audit for each row execute function qa_fail()");await assert.rejects(applyKeg(admin,p),/injected after insert/);assert.deepEqual(await kegState(admin),before);await admin.query('drop trigger qa_fail on inventory_keg_safety_audit;drop function qa_fail()');report.scenarios.push('full rollback');
  });
  await t.test('existing item/active indexes bound the query to one item; no historical index is added',async()=>{
   await seedKegSafety(admin);await admin.query("insert into inventory(id) select n from generate_series(100,10099) n;insert into inventory_keg_sessions(inventory_item_id,status,started_at,started_business_date,capacity_quantity) select n,'active','2026-01-01','2026-01-01',30000 from generate_series(100,10099) n;analyze inventory_keg_sessions");
   const plan=(await admin.query("explain (analyze, buffers, format json) select * from inventory_keg_sessions where inventory_item_id=3 and status='closed' and ended_log_id=77")).rows[0]['QUERY PLAN'];assert.match(JSON.stringify(plan),/inventory_keg_sessions_item_started_idx/);report.plan=plan;
   const active=(await admin.query("explain (analyze, buffers, format json) select * from inventory_keg_sessions where inventory_item_id=3 and status='active'")).rows[0]['QUERY PLAN'];assert.match(JSON.stringify(active),/inventory_keg_sessions_one_active_uidx/);report.activePlan=active;
  });
  writeFileSync('.qa-review/keg-p0/native-evidence.json',JSON.stringify(report,null,2));
 }finally{for(const c of clients)await c.end().catch(()=>{});if(started)await run('pg_ctl',['-D',dir,'-m','fast','-w','stop']);}
});
