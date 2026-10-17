// Runs only in an owned loopback cluster. Never reads .env or accepts a DB URL.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { setup, decide } from './helpers/payroll-extra-work-db.mjs';

const bins = [process.env.QA_POSTGRES_BIN,
  '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin',
  '.qa-review/pg-runtime/node_modules/@embedded-postgres/windows-x64/native/bin'].filter(Boolean);
const bin = bins.find(p => existsSync(join(p, process.platform === 'win32' ? 'postgres.exe' : 'postgres')));
assert.ok(bin, 'Set QA_POSTGRES_BIN to local PostgreSQL binaries; no external database is used');
process.env.QA_POSTGRES_BIN = resolve(bin);

test('real PostgreSQL approval/cancellation contention and duplicate approval', {timeout:120_000}, async t => {
  const native = await nativeInventoryPostgres();
  const db = await setup(native.Database);
  const a = await native.connect(db.name), b = await native.connect(db.name);
  let unexpectedDeadlocks = 0;
  const observe = promise => promise.catch(error => { if(error.code === '40P01') unexpectedDeadlocks++; throw error; });
  const waitEmployee = async client => {
    const deadline = Date.now()+5000;
    while(Date.now()<deadline) {
      const locks=(await db.query("select classid::int,objid::int from pg_locks where pid=$1 and locktype='advisory' and not granted",[client.processID])).rows;
      if(locks.length) { assert.deepEqual(locks,[{classid:82119,objid:7}]); return; }
      await new Promise(r=>setTimeout(r,5));
    }
    assert.fail('expected real employee advisory-lock contention');
  };
  const cancel = client => client.query("select payroll_admin_cancel_part_time_extra_work_decision_v1(101,'concurrent manager cancellation',1) as result");
  const reset = async () => {
    await a.query('rollback'); await b.query('rollback');
    await db.exec("truncate payroll_part_time_extra_work_decisions restart identity; delete from payroll_employee_payments where id=3; update attendance_records set check_in_at='2026-10-01T17:45:00+07:00' where id=101");
  };
  const counts = async(total,active) => {
    assert.deepEqual((await db.query('select count(*)::int as total,count(*) filter(where cancelled_at is null)::int as active from payroll_part_time_extra_work_decisions')).rows[0],{total,active});
  };
  try {
    await db.exec(readFileSync('supabase/migrations/20261017072217_part_time_early_extra_work_october.sql','utf8'));
    for(const client of [a,b]) await client.query("set statement_timeout='8s'; set deadlock_timeout='100ms'; set role service_role");
    await t.test('negative control reproduces row -> employee versus employee -> row deadlock', async()=>{
      await decide(db);
      await db.exec(`create function qa_old_cancel() returns void language plpgsql as $$
        begin
          perform 1 from payroll_part_time_extra_work_decisions where attendance_record_id=101 and cancelled_at is null for update;
          perform pg_advisory_xact_lock(82119,7);
        end $$;`);
      await a.query('begin'); await a.query('select pg_advisory_xact_lock(82119,7)');
      const old = b.query('select qa_old_cancel()').then(value=>({value}),error=>({error}));
      await waitEmployee(b);
      const approval = decide(a).then(value=>({value}),error=>({error}));
      const results = await Promise.all([old,approval]);
      assert.equal(results.filter(r=>r.error?.code==='40P01').length,1);
      await a.query('rollback'); await b.query('rollback');
      await db.exec('drop function qa_old_cancel()');
    });
    await t.test('approval first: cancellation waits before any decision row and cancels the replacement',async()=>{
      for(let i=0;i<10;i++) {
        await reset(); const original=await decide(db);
        await a.query('begin'); const replacement=await decide(a,{p_decision:'rejected'});
        const waiting=observe(cancel(b)); await waitEmployee(b);
        await a.query('commit');
        const cancelled=(await waiting).rows[0].result;
        assert.equal(String(cancelled.id),String(replacement.id));
        assert.notEqual(String(cancelled.id),String(original.id));
        assert.equal(cancelled.status,'cancelled');
        const saved=(await db.query('select * from payroll_part_time_extra_work_decisions where id=$1',[cancelled.id])).rows[0];
        assert.equal(saved.decision,'rejected');
        assert.equal(saved.cancellation_reason,'concurrent manager cancellation');
        await counts(2,0);
      }
    });
    await t.test('cancellation first: approval waits, re-reads and appends one new decision',async()=>{
      for(let i=0;i<10;i++) {
        await reset(); const original=await decide(db);
        await a.query('begin'); await cancel(a);
        const waiting=observe(decide(b)); await waitEmployee(b);
        await a.query('commit'); const next=await waiting;
        assert.notEqual(String(next.id),String(original.id));
        await counts(2,1);
      }
    });
    await t.test('concurrent identical approvals and reapprovals are idempotent with one active row',async()=>{
      for(const reapprove of [false,true]) for(let i=0;i<10;i++) {
        await reset();
        if(reapprove) {await decide(db); await cancel(db);}
        await a.query('begin'); const first=await decide(a);
        const waiting=observe(decide(b)); await waitEmployee(b);
        await a.query('commit'); const duplicate=await waiting;
        assert.equal(first.status,'created'); assert.equal(duplicate.status,'unchanged');
        assert.equal(String(first.id),String(duplicate.id));
        await counts(reapprove?2:1,1);
      }
    });
    await t.test('payment committed during a lock wait prevents approval and cancellation',async()=>{
      for(const action of [decide,cancel]) {
        await reset(); await decide(db);
        await a.query('begin'); await a.query('select pg_advisory_xact_lock(82119,7)');
        // The fixture payment write uses the same employee lock as the real payment RPC.
        await db.query("insert into payroll_employee_payments values(3,3,7,'pending','{}')");
        // a is service_role; fixture grants are deliberately minimal.
        await a.query('reset role');
        await a.query("update payroll_employee_payments set payment_status='paid' where id=3");
        const waiting=observe(action(b)).then(value=>({value}),error=>({error}));
        await waitEmployee(b); await a.query('commit'); await a.query('set role service_role');
        assert.equal((await waiting).error?.code,'55000');
        await counts(1,1);
      }
    });
    await t.test('attendance changed during an approval lock wait invalidates the old snapshot',async()=>{
      await reset(); await a.query('begin'); await a.query('select pg_advisory_xact_lock(82119,7)');
      await a.query('reset role');
      await a.query("update attendance_records set check_in_at='2026-10-01T17:44:00+07:00' where id=101");
      const waiting=observe(decide(b)).then(value=>({value}),error=>({error}));
      await waitEmployee(b); await a.query('commit'); await a.query('set role service_role');
      assert.match((await waiting).error?.message??'',/STALE_SOURCE/);
      await counts(0,0);
    });
    await t.test('schedule, opening hours, dated store version and contract changes during a wait reject stale approvals',async()=>{
      for(const mutation of [
        "update employee_work_schedule_versions set revision=5 where id=21",
        "update store_business_hours set open_time='17:30' where weekday=4",
        "insert into store_setting_versions values(32,6,'active','2026-10-01'); insert into store_business_hours select 32,d,false,'16:00','01:00' from generate_series(0,6) d",
        "update payroll_contract_versions set revision=4 where id=11",
      ]) {
        await reset(); await a.query('begin'); await a.query('select pg_advisory_xact_lock(82119,7)');
        await a.query('reset role'); await a.query(mutation);
        const waiting=observe(decide(b)).then(value=>({value}),error=>({error}));
        await waitEmployee(b); await a.query('commit'); await a.query('set role service_role');
        assert.match((await waiting).error?.message??'',/STALE_SOURCE/);
        await counts(0,0);
        await db.exec("update employee_work_schedule_versions set revision=4 where id=21; update store_business_hours set open_time='16:00' where setting_version_id=31; delete from store_business_hours where setting_version_id=32; delete from store_setting_versions where id=32; update payroll_contract_versions set revision=3 where id=11");
      }
    });

    await t.test('salary changed during an employee-lock wait rejects even a self-consistent old rate snapshot',async()=>{
      await reset(); await a.query('begin'); await a.query('select pg_advisory_xact_lock(82119,7)');
      await a.query('reset role');
      await a.query('update payroll_contract_versions set base_salary=70000 where id=11');
      const waiting=observe(decide(b)).then(value=>({value}),error=>({error}));
      await waitEmployee(b); await a.query('commit'); await a.query('set role service_role');
      assert.match((await waiting).error?.message??'',/RATE_MISMATCH/);
      await counts(0,0);
      await db.exec('update payroll_contract_versions set base_salary=35000 where id=11');
    });

    assert.equal(unexpectedDeadlocks,0);
    t.diagnostic(`${native.version}; 40 deterministic approval/cancellation/duplicate schedules; unexpected deadlocks=0`);
  } finally {
    await Promise.allSettled([a.query('rollback'),b.query('rollback')]);
    await db.close(); await native.stop();
  }
});
