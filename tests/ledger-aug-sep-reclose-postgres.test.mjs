import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { nativeRecloseFixture, preserved } from './helpers/ledger-aug-sep-reclose-native-fixture.mjs';

const migrationPath='supabase/migrations/20261027112354_aug_sep_reclose_corrections.sql';
const migration=readFileSync(migrationPath,'utf8');
const fixPath='supabase/migrations/20261027175537_reclose_patch_line_endings.sql';
const lockFix=readFileSync(fixPath,'utf8');
const signature='public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint)';
const one=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0];
const correct=async(c,month='2026-09-01') => (await one(c,'select public.ledger_aug_sep_reclose_corrections_v1($1::date,1,1) r',[month])).r;
const reopen=async(c) => (await one(c,"select ledger_reopen_month_v1('2026-09-01','native concurrency',1) r")).r;
const close=async(c) => (await one(c,"select ledger_close_month_v1('2026-09-01','fresh','{}','{}',repeat('a',64),1) r")).r;
const versionPlan=async(c,prefix='store-rent') => (await one(c,"select ledger_create_recurring_plan_version_v1('native future rent',3,50000000,1::smallint,'2026-10-01',null,$1,'native plan version',1) r",[prefix])).r;
const settle=p=>p.then(value=>({value}),error=>({error}));
const unwrap=r=>{if(r.error)throw r.error;return r.value;};

async function counts(c) {
  return one(c,`select
    (select count(*)::int from ledger_transactions where correction_of_id is not null) corrections,
    (select count(*)::int from ledger_transactions where source_type='recurring_expense') rents,
    (select count(*)::int from ledger_audit_logs where action='correction_created') correction_audits,
    (select count(*)::int from ledger_audit_logs where action='recurring_expense_created') rent_audits`);
}
const empty={corrections:0,rents:0,correction_audits:0,rent_audits:0};
const september={corrections:2,rents:1,correction_audits:2,rent_audits:1};

async function waitForLock(observer,blocker,waiter) {
  for(let attempt=0;attempt<200;attempt++) {
    const state=await one(observer,`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers
      from pg_stat_activity where pid=$1`,[waiter]);
    if(state?.wait_event_type==='Lock' && state.blockers.includes(blocker)) return state;
    await delay(10);
  }
  throw Error('Expected independent backend lock wait was not observed');
}

test('M: native PostgreSQL independent sessions, immutable base plus lock-order fix',{
  skip:!process.env.QA_POSTGRES_BIN && 'No existing native PostgreSQL binaries configured',timeout:150000,
},async t=>{
  const runtime=await nativeInventoryPostgres({testContext:t});
  const results={version:runtime.version,clusterId:runtime.id,logDir:runtime.logDir,
    migrationPath,migrationSha256:createHash('sha256').update(migration).digest('hex'),
    fixPath,fixSha256:createHash('sha256').update(lockFix).digest('hex'),cases:[],locks:[]};
  t.diagnostic(runtime.version);
  t.after(()=>{
    mkdirSync('.tmp-baba/m-native-postgres',{recursive:true});
    results.cleanup=runtime.cleanupResult;
    writeFileSync('.tmp-baba/m-native-postgres/results.json',JSON.stringify(results,null,2));
  });
  async function scenario(name,fn) {
    await t.test(name,{timeout:20000},async()=>{
      const db=await nativeRecloseFixture(runtime.Database);
      const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
      const connections=[a,b],pending=[];
      const start=p=>{const r=settle(p);pending.push(r);return r;};
      const record={name,database:db.name};results.cases.push(record);
      try {
        for(const c of connections) await c.query("set statement_timeout='15s';set deadlock_timeout='100ms'");
        const pidA=(await one(a,'select pg_backend_pid() pid')).pid,pidB=(await one(b,'select pg_backend_pid() pid')).pid;
        const pidObserver=(await one(db,'select pg_backend_pid() pid')).pid;
        assert.equal(new Set([pidA,pidB,pidObserver]).size,3);
        record.pids=[pidA,pidB,pidObserver];
        const lock=async(blocker=pidA,waiter=pidB)=>{
          const state=await waitForLock(db,blocker,waiter);results.locks.push({name,...state});return state;
        };
        await fn({db,a,b,pidA,pidB,lock,start,record});record.status='PASS';
      }catch(error){record.status='FAIL';record.error={code:error.code,message:error.message};throw error;}
      finally {
        for(const c of connections) await c.query('rollback').catch(()=>{});
        await Promise.allSettled(pending);
        // Publish backend statistics before inspecting deadlocks. No scenario
        // in the fixed suite is allowed to accept 40P01, including the old one.
        for(const c of connections) await c.query('select pg_stat_force_next_flush()');
        for(let attempt=0;attempt<60;attempt++) {
          await db.query('select pg_stat_clear_snapshot()');
          record.deadlocks=Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks);
          if(record.deadlocks>0 || attempt===5)break;
          await delay(50);
        }
        assert.equal(record.deadlocks,0,name+' unexpectedly deadlocked');
        await a.end();await b.end();await db.close();
      }
    });
  }

  for(const month of ['2026-08-01','2026-09-01']) await scenario('same-month corrections serialize: '+month,async({db,a,b,lock,start})=>{
    await reopen(db);
    if(month==='2026-08-01') await db.query("select ledger_reopen_month_v1('2026-08-01','native',1)");
    const before=await preserved(db);await a.query('begin');
    const first=await correct(a,month),p=start(correct(b,month));
    assert.equal((await lock()).wait_event,'advisory');
    assert.deepEqual(await counts(db),empty,'uncommitted writes must be invisible');
    await a.query('commit');const second=unwrap(await p);
    assert.equal(first.correctionsCreated,month==='2026-08-01'?1:2);
    assert.equal(second.correctionsCreated,0);assert.equal(second.recurring.createdCount,0);
    assert.deepEqual(await counts(db),month==='2026-08-01'?{...september,corrections:1,correction_audits:1}:september);
    assert.deepEqual(await preserved(db),before);
  });

  await scenario('correction then close waits and closes after complete correction',async({db,a,b,lock,start})=>{
    await reopen(db);const before=await preserved(db);await a.query('begin');await correct(a);
    const p=start(close(b));await lock();await a.query('commit');
    assert.equal(unwrap(await p).status,'closed');assert.deepEqual(await counts(db),september);
    assert.deepEqual(await preserved(db),before);
  });
  await scenario('close then correction waits and rejects closed month without writes',async({db,a,b,lock,start})=>{
    await reopen(db);await a.query('begin');assert.equal((await close(a)).status,'closed');
    const p=start(correct(b));await lock();await a.query('commit');
    assert.match((await p).error.message,/LEDGER_MONTH_CLOSED/);assert.deepEqual(await counts(db),empty);
  });
  await scenario('reopen then correction waits and sees committed reopened state',async({db,a,b,lock,start})=>{
    await a.query('begin');assert.equal((await reopen(a)).status,'reopened');
    const p=start(correct(b));await lock();await a.query('commit');
    assert.equal(unwrap(await p).status,'ok');assert.deepEqual(await counts(db),september);
  });
  await scenario('closed correction fails; waiting reopen proceeds after transaction rollback',async({db,a,b,lock,start})=>{
    await a.query('begin;savepoint attempt');await assert.rejects(correct(a),/LEDGER_MONTH_CLOSED/);
    // A failed statement releases its subtransaction locks. Hold the real close
    // serial lock explicitly after rollback-to-savepoint to test the boundary.
    await a.query("rollback to savepoint attempt;select pg_advisory_xact_lock(hashtext('ledger_month_close_serial'))");
    const p=start(reopen(b));await lock();await a.query('rollback');
    assert.equal(unwrap(await p).status,'reopened');assert.deepEqual(await counts(db),empty);
  });

  await scenario('ordinary writer waits for correction; rolled-back payment leaves all protected rows unchanged',async({db,a,b,lock,start})=>{
    await reopen(db);const before=await preserved(db);await a.query('begin');await correct(a);await b.query('begin');
    const p=start(b.query("insert into ledger_transactions(id,type,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,confirmed_by) values(40000,'expense','2026-09-30','2026-09-01',1000,75,'confirmed','manual','native-writer','{}',1)"));
    assert.equal((await lock()).wait_event,'relation');await a.query('commit');unwrap(await p);
    await b.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values(40000,2,-1000)');
    await b.query('rollback');assert.deepEqual(await preserved(db),before);assert.deepEqual(await counts(db),september);
  });
  await scenario('ordinary source writer commits first; waiting correction detects drift and does not overwrite writer',async({db,a,b,lock,start})=>{
    await reopen(db);const before=await preserved(db);await a.query('begin;update ledger_transactions set amount=9728001 where id=2191');
    const p=start(correct(b));assert.equal((await lock()).wait_event,'relation');await a.query('commit');
    assert.match((await p).error.message,/RECLOSE_SOURCE_DRIFT: 2191/);assert.deepEqual(await counts(db),empty);
    const after=await preserved(db);assert.equal(after.originals.find(r=>r.id==='2191').amount,'9728001');
    after.originals.find(r=>r.id==='2191').amount='9728000';assert.deepEqual(after,before);
  });

  await scenario('real 5s lock timeout before writes; retry creates only one correction set',async({db,a,b,lock,start,record})=>{
    await reopen(db);const before=await preserved(db);await a.query('begin;lock table ledger_transactions in row exclusive mode');
    const began=Date.now(),p=start(correct(b));await lock();const failure=(await p).error;
    record.elapsedMs=Date.now()-began;record.sqlstate=failure.code;
    assert.equal(failure.code,'55P03');assert.ok(record.elapsedMs>=4800 && record.elapsedMs<9000);
    assert.deepEqual(await counts(db),empty);await a.query('rollback');await correct(b);
    assert.equal((await correct(b)).correctionsCreated,0);assert.deepEqual(await counts(db),september);
    assert.deepEqual(await preserved(db),before);
  });
  await scenario('real 5s timeout after correction, R1 row and both audits were attempted; all roll back',async({db,a,b,lock,start,record})=>{
    await reopen(db);const before=await preserved(db);
    await db.exec(`create table qa_timeout_gate(id int);
      create function qa_timeout_after_rent_audit() returns trigger language plpgsql as $$begin
        if new.action='recurring_expense_created' then insert into qa_timeout_gate values(1);end if;return new;end$$;
      create trigger qa_timeout_after_rent_audit after insert on ledger_audit_logs for each row execute function qa_timeout_after_rent_audit();`);
    await a.query('begin;lock table qa_timeout_gate in share mode');
    const began=Date.now(),p=start(correct(b));await lock();const failure=(await p).error;
    record.elapsedMs=Date.now()-began;record.sqlstate=failure.code;
    assert.equal(failure.code,'55P03');assert.ok(record.elapsedMs>=4800 && record.elapsedMs<9000);
    assert.match(failure.where,/qa_timeout_after_rent_audit/);
    assert.deepEqual(await counts(db),empty);assert.deepEqual(await preserved(db),before);
    await a.query('rollback');await correct(b);assert.equal((await correct(b)).correctionsCreated,0);
    assert.deepEqual(await counts(db),september);assert.deepEqual(await preserved(db),before);
  });

  await scenario('C3 failure rolls back C2; concurrent waiting retry commits once',async({db,a,b,lock,start})=>{
    await reopen(db);const before=await preserved(db);
    await db.exec(`create function qa_fail_c3() returns trigger language plpgsql as $$begin
      if new.correction_of_id=2192 and current_setting('qa.fail_c3',true)='on' then raise exception 'QA_C3_FAILURE';end if;return new;end$$;
      create trigger qa_fail_c3 before insert on ledger_transactions for each row execute function qa_fail_c3();`);
    await a.query("begin;select pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));set local qa.fail_c3='on'");
    const p=start(correct(b));await lock();await assert.rejects(correct(a),/QA_C3_FAILURE/);await a.query('rollback');
    assert.equal(unwrap(await p).correctionsCreated,2);assert.equal((await correct(b)).correctionsCreated,0);
    assert.deepEqual(await counts(db),september);assert.deepEqual(await preserved(db),before);
  });

  await scenario('installed function owner, security, search_path, real role calls and duplicate-install rejection',async({db,b,record})=>{
    const meta=await one(db,`select p.prosecdef,r.rolname owner,p.proconfig,
      pg_get_functiondef(p.oid) definition,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') public_execute
      from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`,[signature]);
    record.metadata={securityDefiner:meta.prosecdef,owner:meta.owner,config:meta.proconfig,publicExecute:meta.public_execute};
    assert.equal(meta.prosecdef,true);assert.equal(meta.owner,'postgres');assert.equal(meta.public_execute,false);
    assert.ok(meta.proconfig.includes('search_path=pg_catalog, public'));assert.ok(meta.proconfig.includes('lock_timeout=5s'));
    for(const role of ['anon','authenticated']) {
      assert.equal((await one(db,"select has_function_privilege($1,$2,'execute') allowed",[role,signature])).allowed,false);
      await b.query('set role '+role);await assert.rejects(correct(b),e=>e.code==='42501');await b.query('reset role');
    }
    await reopen(db);await b.query('set role service_role');assert.equal((await correct(b)).status,'ok');await b.query('reset role');
    const before=await counts(db);await assert.rejects(db.exec(migration),e=>e.code==='42723');
    assert.equal((await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature])).definition,meta.definition);
    assert.deepEqual(await counts(db),before);
    await db.exec(lockFix); // Reapplying the follow-up is a no-op, not CREATE.
    assert.equal((await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature])).definition,meta.definition);
  });

  await scenario('former 40P01 schedule: R1 prefix holder writes and commits while correction waits before transaction table',async({db,a,b,pidB,lock,start,record})=>{
    await reopen(db);const before=await preserved(db);
    await a.query("begin;select pg_advisory_xact_lock(hashtext('ledger_recurring:store-rent:2026-09'))");
    const correction=start(correct(b));await lock();
    // Same schedule as the original reproducer. This MUST succeed, never
    // accept 40P01 as a successful regression result.
    const locks=await one(db,"select count(*)::int n from pg_locks where pid=$1 and relation='public.ledger_transactions'::regclass and mode='ShareRowExclusiveLock' and granted",[pidB]);
    assert.equal(locks.n,0,'correction must not own the transaction table while waiting for R1');
    const writer=unwrap(await start(a.query("select ledger_sync_recurring_expenses_v2('2026-09-01',1) r")));
    assert.equal(writer.rows[0].r.createdCount,1);await a.query('commit');
    const result=unwrap(await correction);assert.equal(result.correctionsCreated,2);
    assert.equal(result.recurring.createdCount,0);record.sqlstate='00000';
    assert.equal((await correct(db)).correctionsCreated,0);
    assert.deepEqual(await counts(db),september);assert.deepEqual(await preserved(db),before);
  });

  await scenario('R1 prefix contention expires with 55P03 after 5s, never 40P01, then retries once',async({db,a,b,lock,start,record})=>{
    await reopen(db);const before=await preserved(db);
    await a.query("begin;select pg_advisory_xact_lock(hashtext('ledger_recurring:store-rent:2026-09'))");
    const began=Date.now(),p=start(correct(b));assert.equal((await lock()).wait_event,'advisory');
    const failure=(await p).error;record.sqlstate=failure.code;record.elapsedMs=Date.now()-began;
    assert.equal(failure.code,'55P03');assert.ok(record.elapsedMs>=4800 && record.elapsedMs<9000);
    assert.deepEqual(await counts(db),empty);await a.query('rollback');
    await a.query("select ledger_sync_recurring_expenses_v2('2026-09-01',1)");
    assert.equal((await correct(b)).recurring.createdCount,0);assert.equal((await correct(b)).correctionsCreated,0);
    assert.deepEqual(await counts(db),september);assert.deepEqual(await preserved(db),before);
  });

  await scenario('same-prefix plan version first completes; correction validates changed plan and aborts without writes',async({db,a,b,lock,start})=>{
    await reopen(db);const before=await preserved(db);
    await a.query("begin;select pg_advisory_xact_lock(hashtext('ledger_recurring_plan:store-rent'))");
    const p=start(correct(b));assert.equal((await lock()).wait_event,'advisory');
    assert.equal((await versionPlan(a)).status,'created');await a.query('commit');
    assert.match((await p).error.message,/RECLOSE_RENT_PLAN_DRIFT/);
    assert.deepEqual(await counts(db),empty);assert.deepEqual(await preserved(db),before);
  });
  for(const prefix of ['store-rent','other-future-plan']) await scenario('correction first; plan version waits without deadlock: '+prefix,async({db,a,b,lock,start})=>{
    await reopen(db);const before=await preserved(db);await a.query('begin');await correct(a);
    const p=start(versionPlan(b,prefix));
    assert.equal((await lock()).wait_event,prefix==='store-rent'?'advisory':'relation');
    await a.query('commit');assert.equal(unwrap(await p).status,'created');
    assert.deepEqual(await counts(db),september);assert.deepEqual(await preserved(db),before);
  });

  await scenario('multiple active plans abort before table lock or acquiring another R1 prefix',async({db,a,b})=>{
    await reopen(db);
    await db.query("select ledger_create_recurring_plan_version_v1('native extra',4,1000,1::smallint,'2026-08-01',null,'extra-plan','native validation',1)");
    await a.query("begin;select pg_advisory_xact_lock(hashtext('ledger_recurring:extra-plan:2026-09'));lock table ledger_transactions in row exclusive mode");
    const began=Date.now();await assert.rejects(correct(b),/RECLOSE_RENT_PLAN_DRIFT/);
    assert.ok(Date.now()-began<2000,'validation must reject before waiting on transaction table');
    assert.deepEqual(await counts(db),empty);await a.query('rollback');
  });

  await scenario('plan version, correction and close overlap across three executing backends without a cycle',async({db,a,b,pidB,lock,start})=>{
    await reopen(db);await a.query("begin;select pg_advisory_xact_lock(hashtext('ledger_recurring_plan:store-rent'))");
    const p=start(correct(b));await lock();const c=await runtime.connect(db.name);
    try {
      await c.query("set statement_timeout='15s'");const pidC=(await one(c,'select pg_backend_pid() pid')).pid;
      const closing=start(close(c));results.locks.push({name:'plan/correction/close',...await waitForLock(db,pidB,pidC)});
      assert.equal((await versionPlan(a)).status,'created');await a.query('commit');
      assert.match((await p).error.message,/RECLOSE_RENT_PLAN_DRIFT/);
      assert.equal(unwrap(await closing).status,'closed');assert.deepEqual(await counts(db),empty);
    } finally {await c.query('rollback').catch(()=>{});await c.end();}
  });

  await scenario('follow-up rejects accounting body drift and retains function metadata',async({db})=>{
    const definition=(await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature])).definition;
    await db.exec(definition.replace('RECLOSE_INVALID_MONTH','QA_UNAPPROVED_BODY_DRIFT'));
    await assert.rejects(db.exec(lockFix),/RECLOSE_LOCK_ORDER_FUNCTION_DRIFT/);
    assert.equal((await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature])).definition,definition.replace('RECLOSE_INVALID_MONTH','QA_UNAPPROVED_BODY_DRIFT'));
  });

  await scenario('history registration serializes duplicate requests and rejects version-content mismatch',async({db,a,b,lock,start})=>{
    // A local model of the standard migration-history columns, never remote.
    await db.exec('create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text)');
    const register=async(c,sql=migration)=>{
      await c.query("select pg_advisory_xact_lock(hashtext('baba_migration_history:20261027112354'))");
      await c.query("insert into supabase_migrations.schema_migrations(version,statements,name) values('20261027112354',array[$1]::text[],'aug_sep_reclose_corrections') on conflict(version) do nothing",[sql]);
      const row=await one(c,"select name,statements from supabase_migrations.schema_migrations where version='20261027112354'");
      assert.equal(row.name,'aug_sep_reclose_corrections');assert.deepEqual(row.statements,[sql]);
    };
    await a.query('begin');await register(a);await b.query('begin');const p=start(register(b));await lock();
    await a.query('commit');unwrap(await p);await b.query('commit');
    assert.equal((await one(db,'select count(*)::int n from supabase_migrations.schema_migrations')).n,1);
    await b.query('begin');await assert.rejects(register(b,migration+'\n-- mismatch'));await b.query('rollback');
    assert.equal((await one(db,'select statements[1] sql from supabase_migrations.schema_migrations')).sql,migration);
  });
});
