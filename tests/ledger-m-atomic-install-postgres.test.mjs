import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { nativeRecloseFixture, preserved } from './helpers/ledger-aug-sep-reclose-native-fixture.mjs';
import { buildBundles, migrations, signature, expectedBodyHash } from '../scripts/ledger/m-stage-bundles.mjs';

const install=readFileSync('scripts/ledger/m-stage-install.sql','utf8').replaceAll('\r\n','\n');
const register=readFileSync('scripts/ledger/m-stage-register.sql','utf8').replaceAll('\r\n','\n');
const one=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0];
const installed=async c => (await one(c,'select to_regprocedure($1)::text name',[signature])).name;
const history=async c => (await c.query("select * from supabase_migrations.schema_migrations order by version")).rows;
const bodyHash=async c => (await one(c,"select md5(regexp_replace(prosrc,'\\s+','','g')) hash from pg_proc where oid=$1::regprocedure",[signature])).hash;
const failCode=(code,pattern)=>e=>e.code===code && (!pattern || pattern.test(e.message));
async function blocked(observer,a,b) {
  const pa=(await one(a,'select pg_backend_pid() pid')).pid;
  // b cannot run another query while its installation is pending.
  const pb=b.processID;
  assert.notEqual(pa,pb);
  for(let i=0;i<150;i++) {
    const r=await one(observer,'select pg_blocking_pids($1) pids',[pb]);
    if(r.pids.includes(pa))return;
    await delay(10);
  }
  throw Error('No real installer/registrar lock wait observed');
}

test('M atomic SQL Editor artifacts on native PostgreSQL',{
  skip:!process.env.QA_POSTGRES_BIN && 'No existing native PostgreSQL configured',timeout:100000,
},async t=>{
  assert.deepEqual({install,register},buildBundles(),'checked-in SQL must match both immutable source migrations exactly');
  const runtime=await nativeInventoryPostgres({testContext:t});t.diagnostic(runtime.version);
  async function scenario(name,fn) {
    await t.test(name,{timeout:15000},async()=>{
      const db=await nativeRecloseFixture(runtime.Database,{installCorrections:false});
      await db.exec(`create schema supabase_migrations;
        create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
        insert into supabase_migrations.schema_migrations values('20000101000000','unrelated',array['select 1;']);`);
      const a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
      try {
        for(const c of [a,b])await c.query("set statement_timeout='12s'");
        await fn({db,a,b,pending:p=>{pending=p.then(value=>({value}),error=>({error}));return pending;}});
        for(const c of [a,b]) await c.query('select pg_stat_force_next_flush()');
        await db.query('select pg_stat_clear_snapshot()');
        assert.equal(Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks),0);
      } finally {
        await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});
        if(pending)await pending;await a.end();await b.end();await db.close();
      }
    });
  }

  await scenario('original function stays invisible until patched function commits; history is a separate verified phase',async({db,a,b})=>{
    const before=await preserved(db),audit=(await db.query('select * from ledger_audit_logs order by id')).rows;
    const at=install.indexOf('-- M_STAGE_FIX_BEGIN');assert.ok(at>0);
    await a.query(install.slice(0,at));
    assert.equal(await installed(db),null,'unpatched CREATE must not escape transaction');
    await assert.rejects(b.query("select public.ledger_aug_sep_reclose_corrections_v1('2026-09-01'::date,1::bigint,1::bigint)"),failCode('42883'));
    await a.query(install.slice(at));assert.equal(await bodyHash(db),expectedBodyHash);
    assert.equal((await history(db)).length,1,'installation must not register history before verification');
    assert.deepEqual(await preserved(db),before);
    assert.deepEqual((await db.query('select * from ledger_audit_logs order by id')).rows,audit);
    await a.query(register);const first=await history(db);assert.equal(first.length,3);
    for(const m of migrations)assert.deepEqual(first.find(r=>r.version===m.version),{version:m.version,name:m.name,statements:[m.sql]});
    await a.query(register);assert.deepEqual(await history(db),first,'identical two-version registration is a no-op');
    await assert.rejects(a.query(install),failCode('P0001',/M_STAGE_FUNCTION_ALREADY_EXISTS/));await a.query('rollback');
    assert.equal(await bodyHash(db),expectedBodyHash);assert.deepEqual(await history(db),first);
  });

  for(const stage of ['before fix','before commit']) await scenario('installation failure '+stage+' rolls back both DDL migrations',async({db,a})=>{
    const before=await preserved(db);
    const failing=stage==='before fix'?install.replace('-- M_STAGE_FIX_BEGIN','select 1/0;\n-- M_STAGE_FIX_BEGIN'):install.replace('\ncommit;','\nselect 1/0;\ncommit;');
    await assert.rejects(a.query(failing),failCode('22012'));await a.query('rollback');
    assert.equal(await installed(db),null);assert.equal((await history(db)).length,1);
    assert.deepEqual(await preserved(db),before);
    await a.query(install);assert.equal(await bodyHash(db),expectedBodyHash);
  });

  await scenario('two installers serialize; second refuses reinstallation after first commits corrected function',async({db,a,b,pending})=>{
    const at=install.indexOf('-- M_STAGE_FIX_BEGIN');await a.query(install.slice(0,at));
    const p=pending(b.query(install));await blocked(db,a,b);assert.equal(await installed(db),null);
    await a.query(install.slice(at));assert.match((await p).error.message,/M_STAGE_FUNCTION_ALREADY_EXISTS/);
    await b.query('rollback');assert.equal(await bodyHash(db),expectedBodyHash);assert.equal((await history(db)).length,1);
  });

  await scenario('two registrars serialize and preserve exactly both approved statements once',async({db,a,b,pending})=>{
    await a.query(install);const at=register.indexOf('do $m_stage_verify$');await a.query(register.slice(0,at));
    const p=pending(b.query(register));await blocked(db,a,b);await a.query(register.slice(at));
    const r=await p;if(r.error)throw r.error;
    assert.equal((await history(db)).length,3);
    for(const m of migrations)assert.deepEqual((await history(db)).find(row=>row.version===m.version).statements,[m.sql]);
  });

  await scenario('registrar waits behind unfinished installer and only observes the committed patched function',async({db,a,b,pending})=>{
    const at=install.indexOf('-- M_STAGE_FIX_BEGIN');await a.query(install.slice(0,at));
    const p=pending(b.query(register));await blocked(db,a,b);
    assert.equal(await installed(db),null);assert.equal((await history(db)).length,1);
    await a.query(install.slice(at));const r=await p;if(r.error)throw r.error;
    assert.equal(await bodyHash(db),expectedBodyHash);assert.equal((await history(db)).length,3);
  });

  await scenario('history without a function prevents blind reinstall or implicit repair',async({db,a})=>{
    await db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3)',[migrations[0].version,migrations[0].name,[migrations[0].sql]]);
    const before=await history(db);
    await assert.rejects(a.query(install),failCode('P0001',/M_STAGE_HISTORY_ALREADY_EXISTS/));await a.query('rollback');
    assert.equal(await installed(db),null);assert.deepEqual(await history(db),before);
  });

  await scenario('retired failed version blocks installation and registration without rewriting history',async({db,a})=>{
    await a.query(install);
    await db.query("insert into supabase_migrations.schema_migrations values('20261027160650','retired',array['unverified old source'])");
    const before=await history(db);
    await assert.rejects(a.query(register),failCode('P0001',/M_STAGE_RETIRED_VERSION_PRESENT/));await a.query('rollback');
    assert.deepEqual(await history(db),before);
    await db.query(`drop function ${signature}`);
    await assert.rejects(a.query(install),failCode('P0001',/M_STAGE_HISTORY_ALREADY_EXISTS/));await a.query('rollback');
    assert.equal(await installed(db),null);assert.deepEqual(await history(db),before);
  });

  await scenario('second-version content collision aborts first-version registration too; unrelated history is preserved',async({db,a})=>{
    await a.query(install);
    await db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3)',[migrations[1].version,'wrong',['select 2;']]);
    const before=await history(db);await assert.rejects(a.query(register),failCode('P0001',/M_STAGE_HISTORY_CONTENT_MISMATCH/));
    await a.query('rollback');assert.deepEqual(await history(db),before);assert.equal(await bodyHash(db),expectedBodyHash);
  });

  await scenario('second history INSERT fails after first INSERT; both registrations roll back',async({db,a})=>{
    await a.query(install);const before=await history(db);
    await db.exec(`create function qa_fail_second_history() returns trigger language plpgsql as $$begin
      if new.version='20261027175537' then raise exception 'QA_SECOND_HISTORY_FAILURE';end if;return new;end$$;
      create trigger qa_fail_second_history before insert on supabase_migrations.schema_migrations for each row execute function qa_fail_second_history();`);
    await assert.rejects(a.query(register),failCode('P0001',/QA_SECOND_HISTORY_FAILURE/));await a.query('rollback');
    assert.deepEqual(await history(db),before);assert.equal(await bodyHash(db),expectedBodyHash);
  });

  await scenario('registration refuses missing function and refuses altered final privileges',async({db,a})=>{
    await assert.rejects(a.query(register),failCode('P0001',/M_STAGE_FINAL_FUNCTION_INVALID/));await a.query('rollback');
    assert.equal((await history(db)).length,1);await a.query(install);
    await db.query(`grant execute on function ${signature} to anon`);
    await assert.rejects(a.query(register),failCode('P0001',/M_STAGE_FINAL_FUNCTION_INVALID/));await a.query('rollback');
    assert.equal((await history(db)).length,1);
  });
});
