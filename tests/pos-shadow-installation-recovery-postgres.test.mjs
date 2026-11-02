import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {writerFixture,rows as q} from './helpers/inventory-writer-integration-fixture.mjs';
import {readMigration,capture,claim} from './helpers/pos-shadow-fixture.mjs';
const manifest=JSON.parse(readFileSync('supabase/verification/20261102_pos_p1_3a2_installation_manifest.json','utf8'));
const files=manifest.files.map(f=>({...f,sql:readMigration(f.file)}));
function definition(sql,name){
 const start=sql.search(new RegExp('create (?:or replace )?function '+name.replaceAll('.','\\.')+'\\('));assert.ok(start>=0);
 const chunk=sql.slice(start),delimiter=chunk.match(/\bas\s+(\$\w*\$)/i)[1];
 return chunk.slice(0,chunk.indexOf(delimiter+';',chunk.indexOf(delimiter)+delimiter.length)+delimiter.length+1);
}
async function state(db){
 const business={};
 for(const {n} of await q(db,"select relname n from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1"))
  business[n]=(await q(db,`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') r from public."${n}" t`))[0].r;
 const catalog=await q(db,`select n.nspname,p.proname,p.oid,md5(p.prosrc) body,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' or n.nspname in ('pos_inventory_shadow','pos_ingest_private','inventory_writer_private','pos_signed_private') order by n.nspname,p.oid`);
 const relations=await q(db,`select c.oid,c.relname,c.relacl::text,c.relrowsecurity,a.attname,a.atttypid,a.atttypmod from pg_class c join pg_namespace n on n.oid=c.relnamespace
  left join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where (n.nspname='public' or n.nspname in ('pos_inventory_shadow','pos_ingest_private','inventory_writer_private','pos_signed_private')) and c.relkind='r' order by c.oid,a.attnum`);
 const triggers=await q(db,"select oid,tgname,tgrelid,tgenabled,pg_get_triggerdef(oid) def from pg_trigger where not tgisinternal order by oid");
 return {business,catalog,relations,triggers};
}
test('9 immutable files: owned transactions, injected DDL failures, group-B rollback, resume and postflight',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t}),db=new rt.Database();
 try{
  for(const f of files)assert.equal(createHash('sha256').update(f.sql.replace(/\r\n?/g,'\n')).digest('hex'),f.sha256,f.file);
  const texts=new Set(files.map(f=>f.sql));
  await writerFixture(new Proxy(db,{get(target,name){if(name==='exec')return async sql=>{if(!texts.has(sql))return target.exec(sql)};const v=target[name];return typeof v==='function'?v.bind(target):v}}));
  // Financial behavior is covered by the existing billed/ledger PASS. These
  // schema-only row types permit compilation; this test does not call finances.
  await db.exec('create table ledger_payables(id bigint primary key)');
  // Normal receipts for only newly executed migrations; no repair of old rows.
  await db.exec("create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);insert into supabase_migrations.schema_migrations values('20260917094840','preexisting_untouched',null)");
  const record=async f=>q(db,'insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[f.file.split('_')[0],f.file.slice(15,-4)]);
  // The E writer fixture exercises financial RPCs separately. This installation
  // preflight must include their actual definitions in the same registry.
  for(const [file,name] of [
   ['20260914161954_link_inventory_purchase_corrections.sql','public.inventory_apply_purchase_correction_v1'],
   ['20261010140729_atomic_inventory_edit_and_versioned_correction.sql','public.inventory_apply_purchase_correction_v2'],
   ['20261011165833_safe_same_day_inventory_correction.sql','public.inventory_apply_purchase_correction_v3'],
   ['20261030150000_inventory_purchase_billed_amount.sql','public.inventory_apply_purchase_receipt_edit_v1'],
  ])await db.exec(definition(readMigration(file),name));
  await db.exec(`create function public.qa_fail_ddl() returns event_trigger language plpgsql as $$ begin
   if exists(select 1 from pg_event_trigger_ddl_commands() where classid='pg_proc'::regclass and objid::regprocedure::text like current_setting('qa.fail_function',true)||'(%') then raise exception 'SYNTHETIC_INSTALLATION_FAILURE';end if;end $$;
   create event trigger qa_fail on ddl_command_end execute function public.qa_fail_ddl();`);
  const original=await state(db);
  const failAt=async f=>q(db,"select set_config('qa.fail_function',$1,false)",[f.sql.match(/create (?:or replace )?function ([\w.]+)\(/i)[1].replace(/^public\./,'')]);
  const clear=()=>q(db,"select set_config('qa.fail_function','',false)");
  for(const f of files.slice(0,4)){
   const before=await state(db);await failAt(f);await assert.rejects(db.exec(f.sql),/SYNTHETIC_INSTALLATION_FAILURE/);await db.exec('rollback');
   assert.deepEqual(await state(db),before,'A file rollback '+f.file);await clear();await db.exec(f.sql);await record(f);
   t.diagnostic('A checkpoint '+f.order+'; committed original file, do not replay after ACK loss');
  }
  const checkpoint=await state(db);
  for(const target of files.slice(4)){
   assert.ok(files.slice(4).every(f=>!/^\s*(begin|commit);/im.test(f.sql)));
   await failAt(target);await db.exec('begin');
   await assert.rejects(async()=>{for(const f of files.slice(4))await db.exec(f.sql)},/SYNTHETIC_INSTALLATION_FAILURE/);
   await db.exec('rollback');assert.deepEqual(await state(db),checkpoint,'B rollback restores RPCs, grants, triggers and rows at '+target.file);
   t.diagnostic('B failure rollback '+target.order);
  }
  await clear();const postflight=readFileSync('supabase/verification/20261102_pos_p1_3a2_postflight_readonly.sql','utf8');
  // A postflight failure must roll back the entire B group as well.
  await db.exec('begin');for(const f of files.slice(4))await db.exec(f.sql);
  await db.exec('revoke update(image_path) on inventory from service_role');
  await assert.rejects(q(db,postflight),e=>e.code==='22012');await db.exec('rollback');assert.deepEqual(await state(db),checkpoint);
  await db.exec('begin');for(const f of files.slice(4))await db.exec(f.sql);
  const post=await q(db,postflight);assert.equal(post[0].passed,true,JSON.stringify(post));
  for(const f of files.slice(4))await record(f);await db.exec('commit');
  assert.deepEqual((await q(db,'select version from supabase_migrations.schema_migrations order by version')).map(r=>r.version),['20260917094840',...files.map(f=>f.file.split('_')[0])]);
  assert.deepEqual((await state(db)).business,original.business);
  const observationPolicy={disposition:'raw_only',reasons:['legacy_reprocess_baseline_requires_reconciliation','external_writer_coverage_unverified'],automaticConfirmation:false};
  await capture(db,{seq:null,key:'raw-historical-policy',evidence:{timeBasis:'unknown',proof:'synthetic historical observation only',blockingReason:'source_snapshot_incomplete',observationPolicy}});
  assert.deepEqual((await q(db,"select payload#>'{evidence,observationPolicy}' p from pos_inventory_shadow.observations order by id desc limit 1"))[0].p,observationPolicy);
  const job=await claim(db);if(job.result==='leased')await q(db,"select pos_shadow_settle($1,$2,'owner')",[job.jobId,job.token]);
  await q(db,"select inventory_writer_shadow_drain(1,'owner')");await q(db,"select pos_signed_compare(1,'owner')");
  assert.deepEqual((await state(db)).business,original.business,'enabled observation: every public business row unchanged');
  assert.equal((await q(db,readFileSync('supabase/verification/20261102_pos_p1_3a2_postflight_readonly.sql','utf8')))[0].passed,true);
 }finally{await db.close();const c=await rt.connect('postgres');await c.query('checkpoint');await c.end();}
});
