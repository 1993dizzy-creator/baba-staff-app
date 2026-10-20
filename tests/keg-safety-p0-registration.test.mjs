import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {setupKegSafety,seedKegSafety,kegSafetyApi} from './helpers/keg-safety-fixture.mjs';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
const migration='supabase/migrations/20261020120000_keg_safety_p0.sql';
const draftExpected='39b13e6911a83782e0e207f0ab8cee00efd8073fbf517d82aec5c5e3d67cbc31';
const expected='80f63d9d5aefa4e85ef2e67365c3e10de799c938822239cf132794a02015eb19';
const sql=readFileSync(migration,'utf8'),sha=b=>createHash('sha256').update(b).digest('hex');
test('registered migration differs from the preserved approved draft by only the two transaction-control lines',()=>{
 const bytes=readFileSync(migration);assert.equal(sha(bytes),expected);const draft=readFileSync('supabase/drafts/keg_safety_p0.sql');assert.equal(sha(draft),draftExpected);const lines=draft.toString('utf8').match(/[^\n]*\n|[^\n]+$/g);assert.deepEqual(lines.filter(l=>/^begin;\r?\n?$|^commit;\r?\n?$/i.test(l)).map(l=>l.trim()),['begin;','commit;']);assert.equal(bytes.toString('utf8'),lines.filter(l=>!/^begin;\r?\n?$|^commit;\r?\n?$/i.test(l)).join(''));
 const names=readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql'));
 assert.deepEqual(names.filter(n=>n.startsWith('20261020120000_')),['20261020120000_keg_safety_p0.sql']);
 assert.deepEqual(names.filter(n=>sha(readFileSync('supabase/migrations/'+n))===expected),['20261020120000_keg_safety_p0.sql']);
});
test('real PATCH/POST named RPC args match registered SQL and preview/save/replay JSON contracts',async()=>{
 const db=new PGlite();try{await setupKegSafety(db,{installDraft:false});await db.exec(sql);
 for(const action of ['edit-start','replace']){
  await seedKegSafety(db);const s=kegSafetyApi(db),body=action==='replace'?{itemId:3,expectedQuantity:10,replacementAt:'2026-07-10T11:00Z'}:{startedAt:'2026-07-10T10:30Z'};
  const invoke=async body=>{const req=new Request('http://local/keg',{method:action==='replace'?'POST':'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return action==='replace'?s.replace.POST(req):s.session.PATCH(req,{params:Promise.resolve({id:'23'})});};
  const named=async c=>{assert.match(c.name,/^inventory_(preview|apply)_keg_change$/);const entries=Object.entries(c.args);for(const [k]of entries)assert.match(k,/^p_[a-z_]+$/);return(await db.query('select '+c.name+'('+entries.map(([k],i)=>k+' => $'+(i+1)).join(',')+') result',entries.map(([,v])=>v))).rows[0].result;};
  const response=await invoke({...body,dryRun:true}),p=await response.json();assert.equal(response.status,200);assert.equal(p.ok,true);assert.equal(p.action,action);assert.equal(p.writesPerformed,false);assert.match(p.previewToken,/^[a-f0-9]{64}$/);
  const preview=s.calls.at(-1);assert.equal(preview.name,'inventory_preview_keg_change');const args=['p_action','p_item_id','p_session_id','p_at','p_business_date','p_actor_username','p_expected_quantity'];assert.deepEqual(Object.keys(preview.args),args);assert.equal(preview.args.p_item_id,action==='replace'?3:null);assert.equal(preview.args.p_session_id,action==='replace'?null:23);assert.deepEqual(await named(preview),p);
  const savedResponse=await invoke({...body,previewToken:p.previewToken,requestId:'10000000-0000-4000-8000-000000000001',reason:'Final API contract'}),saved=await savedResponse.json();assert.equal(savedResponse.status,200);assert.equal(saved.ok,true);
  const apply=s.calls.at(-1);assert.equal(apply.name,'inventory_apply_keg_change');assert.deepEqual(Object.keys(apply.args),[...args,'p_preview_token','p_request_id','p_reason','p_confirm']);const replay=await named(apply);assert.equal(replay.replayed,true);delete replay.replayed;assert.deepEqual(replay,saved);if(action==='replace')assert.equal(saved.quantity,9);else assert.equal(saved.session.id,23);
 }
 }finally{await db.close();}
});

test('local PostgreSQL reproduces explicit-COMMIT/history split; in-memory runner-owned transaction proposal rolls everything back',{skip:!process.env.QA_POSTGRES_BIN},async t=>{
 // No CLI apply/db push/migration up is invoked. This is an isolated SQL protocol fixture.
 const runtime=await nativeInventoryPostgres({testContext:t});const evidence={version:runtime.version,actualCliInvoked:false,scenarios:[]};
 try{for(const explicit of [true,false])await t.test(explicit?'approved bytes leave DDL committed when the following history INSERT fails':'proposal without top-level BEGIN/COMMIT rolls DDL and history back together',async()=>{
  const db=new runtime.Database();try{await setupKegSafety(db,{installDraft:false});await db.exec("create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[],constraint qa_history_rejected check(version<>'20261020120000'));insert into inventory(id,quantity,unit) values(3,10,'Keg');");
  const state=async()=> (await db.query("select jsonb_build_object('rpc',(select jsonb_agg(jsonb_build_object('def',pg_get_functiondef(oid),'acl',proacl) order by proname) from pg_proc where pronamespace='public'::regnamespace and proname in ('replace_inventory_keg','calculate_inventory_keg_sales')),'inventory',(select jsonb_agg(i order by id) from inventory i),'sessions',(select jsonb_agg(s order by id) from inventory_keg_sessions s)) s")).rows[0].s;
  const before=await state();const text=explicit?readFileSync('supabase/drafts/keg_safety_p0.sql','utf8'):sql;
  await assert.rejects(db.exec(text+"\ninsert into supabase_migrations.schema_migrations values('20261020120000','keg_safety_p0',array['local injected history failure']);"),/qa_history_rejected/);await db.exec('rollback');
  const objects=(await db.query("select to_regclass('public.inventory_keg_safety_audit') audit,(select count(*)::int from pg_proc where pronamespace='public'::regnamespace and proname in ('inventory_preview_keg_change','inventory_apply_keg_change')) functions,(select count(*)::int from supabase_migrations.schema_migrations) history")).rows[0];assert.equal(objects.history,0);assert.equal(objects.functions,explicit?2:0);assert.equal(Boolean(objects.audit),explicit);assert.deepEqual(await state(),before);
  if(explicit){await db.exec(readFileSync('supabase/verification/20261020120000_keg_safety_p0_postflight.sql','utf8'));assert.deepEqual(await state(),before);}
  evidence.scenarios.push({explicitBeginCommit:explicit,...objects,existingRpcAndDataUnchanged:true,postflightParsedReadOnly:explicit});
  }finally{await db.close();}
 });writeFileSync('.qa-review/keg-p0/registration-runner-evidence.json',JSON.stringify(evidence,null,2));
 }finally{await runtime.stop();}
 assert.equal(sha(readFileSync(migration)),expected);assert.equal(sha(readFileSync('supabase/drafts/keg_safety_p0.sql')),draftExpected);
});