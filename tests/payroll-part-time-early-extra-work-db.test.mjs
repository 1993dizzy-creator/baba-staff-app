import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setup, decide, source, candidate, payload } from './helpers/payroll-extra-work-db.mjs';
const migration = 'supabase/migrations/20261017072217_part_time_early_extra_work_october.sql';
test('local PostgreSQL migration preserves history/payments/ledger and strict invoker permissions',async()=>{
  const db=await setup();
  try {
    await db.exec("update payroll_employee_payments set payment_status='pending' where id=2");
    const historical=payload(candidate({businessDate:'2026-09-04',attendanceRecordId:102,checkInAt:'2026-09-04T17:45:00+07:00',checkOutAt:'2026-09-05T00:00:00+07:00'}));
    await decide(db,historical);
    await decide(db,{...historical,p_decision:'rejected'});
    await db.exec("update payroll_employee_payments set payment_status='paid' where id=2");
    const preserved=async()=>(await db.query(`select
      (select jsonb_agg(to_jsonb(d) order by id) from payroll_part_time_extra_work_decisions d where business_date<'2026-10-01') as decisions,
      (select jsonb_agg(to_jsonb(p) order by id) from payroll_employee_payments p) as payments,
      (select jsonb_agg(to_jsonb(l) order by id) from ledger_sentinel l) as ledger`)).rows;
    const before=await preserved();
    await assert.rejects(decide(db),/INVALID_DECISION/);
    await db.exec(readFileSync(migration,'utf8'));
    assert.deepEqual(await preserved(),before);
    const proc=(await db.query("select oid::text,prosecdef from pg_proc where proname='payroll_admin_set_part_time_extra_work_decision_v1'")).rows;
    assert.equal(proc.length,1);
    assert.equal(proc[0].prosecdef,false);
    const privileges=(await db.query("select has_function_privilege('anon',$1::oid,'execute') as anon,has_function_privilege('authenticated',$1::oid,'execute') as authenticated,has_function_privilege('service_role',$1::oid,'execute') as service",[proc[0].oid])).rows[0];
    assert.deepEqual(privileges,{anon:false,authenticated:false,service:true});
    await db.exec('set role service_role');
    assert.equal((await decide(db)).status,'created');
    assert.equal((await decide(db)).status,'unchanged');
    await db.exec('reset role');
    assert.deepEqual(await preserved(),before);
    assert.deepEqual((await db.query('select candidate_minutes,before_schedule_minutes,after_schedule_minutes from payroll_part_time_extra_work_decisions where attendance_record_id=101')).rows,
      [{candidate_minutes:30,before_schedule_minutes:15,after_schedule_minutes:15}]);
  } finally {await db.close();}
});
test('RPC enforces sum threshold, policy source, dated contract, actor and attendance target',async()=>{
  const db=await setup();
  try {
    await db.exec(readFileSync(migration,'utf8'));
    for(const p of [{p_candidate_minutes:29},{p_candidate_minutes:31},{p_candidate_minutes:15},
      {p_source_snapshot:{...source,extraWorkPolicy:'old'}},{p_source_snapshot:{...source,payType:'monthly'}},
      {p_source_snapshot:{...source,contractRevision:99}},{p_source_snapshot:{...source,candidateAmount:1}},
      {p_attendance_record_id:102}]) await assert.rejects(decide(db,p),/INVALID_/);
    for(const p_actor_user_id of [7,99]) await assert.rejects(decide(db,{p_actor_user_id}),/FORBIDDEN/);
    await db.exec("update payroll_contract_versions set calculation_basis='fixed_monthly'");
    await assert.rejects(decide(db),/INVALID_CONTRACT/);
    await db.exec("update payroll_contract_versions set calculation_basis='minute',pay_type='daily',base_salary=175000");
    assert.equal((await decide(db,{p_source_snapshot:{...source,payType:'daily'}})).status,'created');
    await db.exec("update payroll_contract_versions set pay_type='monthly',base_salary=4550000");
    await assert.rejects(decide(db),/INVALID_DECISION/);
    const monthly = candidate({payType:'monthly',checkOutAt:'2026-10-02T00:00:00+07:00'});
    await db.query('update attendance_records set check_out_at=$1 where id=101',[monthly.checkOutAt]);
    assert.equal((await decide(db,payload(monthly))).status,'created');
    assert.equal((await db.query('select count(*)::int as n from payroll_part_time_extra_work_decisions where cancelled_at is null')).rows[0].n,1);
  } finally {await db.close();}
});
test('approve/cancel/reapprove preserves audit history, one active decision and paid employee lock',async()=>{
  const db=await setup();
  try {
    await db.exec(readFileSync(migration,'utf8'));
    const first=await decide(db);
    await db.query("select payroll_admin_cancel_part_time_extra_work_decision_v1(101,'manager cancelled',1)");
    const next=await decide(db);
    assert.notEqual(next.id,first.id);
    assert.equal((await decide(db)).status,'unchanged');
    assert.deepEqual((await db.query('select count(*)::int as total,count(*) filter(where cancelled_at is null)::int as active from payroll_part_time_extra_work_decisions')).rows[0],{total:2,active:1});
    await db.exec("insert into payroll_employee_payments values(3,3,7,'paid','{}')");
    await assert.rejects(decide(db),/LOCKED_FOR_PAID/);
    await assert.rejects(db.query("select payroll_admin_cancel_part_time_extra_work_decision_v1(101,'cancel',1)"),/PAYROLL_EXTRA_WORK_LOCKED_FOR_PAID_EMPLOYEE/);
    for(const [id,date] of [[102,'2026-09-04'],[103,'2026-08-04']]) {
      await assert.rejects(decide(db,{p_attendance_record_id:id,p_business_date:date,p_payroll_month:`${date.slice(0,7)}-01`,p_candidate_minutes:60,p_after_schedule_minutes:60}),/LOCKED_FOR_PAID/);
    }
  } finally {await db.close();}
});

test('approval recomputes opening-clipped early-only and split candidates from real calculator snapshots',async()=>{
  const db=await setup();
  try {
    await db.exec(readFileSync(migration,'utf8'));
    for(const [changes,before,after,excluded] of [
      [{checkInAt:'2026-10-01T17:30:00+07:00',checkOutAt:'2026-10-01T23:00:00+07:00'},30,0,0],
      [{},15,15,0],
      [{checkInAt:'2026-10-01T17:30:00.000001+07:00',checkOutAt:'2026-10-01T23:00:00+07:00'},30,0,0],
      [{checkInAt:'2026-10-01T15:30:00+07:00',checkOutAt:'2026-10-01T23:00:00+07:00',scheduleStartTime:'16:30'},30,0,30],
      [{checkInAt:'2026-10-01T23:45:00+07:00',checkOutAt:'2026-10-02T01:00:00+07:00',scheduleStartTime:'00:30',scheduleEndTime:'01:00'},45,0,0],
    ]) {
      const row=candidate(changes);
      await db.query('update attendance_records set check_in_at=$1,check_out_at=$2 where id=101',[row.checkInAt,row.checkOutAt]);
      await db.query('update employee_work_schedule_versions set start_time=$1,end_time=$2 where id=21',[row.scheduleStartTime,row.scheduleEndTime]);
      assert.equal((await decide(db,payload(row))).status,'created');
      const saved=(await db.query('select * from payroll_part_time_extra_work_decisions where cancelled_at is null')).rows[0];
      assert.equal(saved.before_schedule_minutes,before);
      assert.equal(saved.after_schedule_minutes,after);
      assert.equal(saved.excluded_before_open_minutes,excluded);
      assert.equal(saved.candidate_minutes,before+after);
      assert.equal(Number(saved.candidate_amount),row.candidateAmount);
      assert.equal(saved.source_hash,row.sourceHash);
    }
  } finally {await db.close();}
});

test('DB rejects modified source hash, inflated matching snapshot amount and fabricated early minutes',async()=>{
  const db=await setup();
  try {
    await db.exec(readFileSync(migration,'utf8'));
    for(const p of [
      {p_source_hash:'b'.repeat(64)},
      {p_candidate_amount:35000,p_source_snapshot:{...source,candidateAmount:35000}},
      {p_before_schedule_minutes:30,p_candidate_minutes:45,p_candidate_amount:26250,
        p_source_snapshot:{...source,beforeScheduleMinutes:30,candidateMinutes:45,candidateAmount:26250}},
      {p_source_snapshot:{...source,extraField:'untrusted'}},
      {p_source_snapshot:{...source,storeOpenTime:'15:00'}},
    ]) await assert.rejects(decide(db,p),/INVALID_SOURCE|INVALID_WORK_WINDOW/);
    await db.query("update attendance_records set check_in_at='2026-10-01T17:44:00+07:00' where id=101");
    await assert.rejects(decide(db),/STALE_SOURCE/);
    assert.equal((await db.query('select count(*)::int n from payroll_part_time_extra_work_decisions')).rows[0].n,0);
  } finally {await db.close();}
});

test('October monthly approvals keep after-only work beyond close up to 03:00 and round real fractional rates',async()=>{
  const db=await setup();
  try {
    await db.exec(readFileSync(migration,'utf8'));
    await db.exec("update payroll_contract_versions set pay_type='monthly'");
    for(const baseSalary of [15600000, 18000001]) {
      await db.query('update payroll_contract_versions set base_salary=$1 where id=11',[baseSalary]);
      const minuteRateAmount=baseSalary/26/420;
      const row=candidate({payType:'monthly',minuteRateAmount,hourlyRateAmount:Math.round(minuteRateAmount*60),
        checkInAt:'2026-10-01T16:00:00+07:00',checkOutAt:'2026-10-02T03:30:00+07:00',scheduleEndTime:'01:00'});
      assert.equal(row.beforeScheduleMinutes,120);
      assert.equal(row.candidateMinutes,120);
      assert.equal(row.excludedAfterCloseMinutes,30);
      assert.equal(row.sourceSnapshot.extraWorkPolicy,undefined);
      await db.query('update attendance_records set check_in_at=$1,check_out_at=$2 where id=101',[row.checkInAt,row.checkOutAt]);
      await db.query('update employee_work_schedule_versions set start_time=$1,end_time=$2 where id=21',[row.scheduleStartTime,row.scheduleEndTime]);
      assert.equal((await decide(db,payload(row))).status,'created');
    }
  } finally {await db.close();}
});

test('new cancellation RPC keeps invoker permissions, actor checks, missing-decision errors and audit reason',async()=>{
  const db=await setup();
  try {
    await db.exec(readFileSync(migration,'utf8'));
    const proc=(await db.query("select oid::text,prosecdef from pg_proc where proname='payroll_admin_cancel_part_time_extra_work_decision_v1'")).rows[0];
    assert.equal(proc.prosecdef,false);
    const acl=(await db.query("select has_function_privilege('anon',$1::oid,'execute') a,has_function_privilege('authenticated',$1::oid,'execute') u,has_function_privilege('service_role',$1::oid,'execute') s",[proc.oid])).rows[0];
    assert.deepEqual(acl,{a:false,u:false,s:true});
    await assert.rejects(db.query("select payroll_admin_cancel_part_time_extra_work_decision_v1(101,'reason',7)"),/FORBIDDEN/);
    await assert.rejects(db.query("select payroll_admin_cancel_part_time_extra_work_decision_v1(101,' ',1)"),/REASON_REQUIRED/);
    assert.deepEqual((await db.query("select payroll_admin_cancel_part_time_extra_work_decision_v1(101,'reason',1) r")).rows[0].r,{status:'not_active'});
    await decide(db);
    await db.exec('set role service_role');
    const cancelled=(await db.query("select payroll_admin_cancel_part_time_extra_work_decision_v1(101,'  manager reason  ',1) r")).rows[0].r;
    assert.deepEqual(cancelled,{id:1,status:'cancelled'});
    const saved=(await db.query('select * from payroll_part_time_extra_work_decisions where id=1')).rows[0];
    assert.equal(saved.cancellation_reason,'manager reason');
    assert.equal(Number(saved.cancelled_by),1);
    assert.ok(saved.cancelled_at);
    assert.equal(saved.source_hash,candidate().sourceHash);
    assert.equal(Number(saved.candidate_amount),17500);
  } finally {await db.close();}
});

test('pre-October unpaid approval remains unchanged and its old after-only threshold stays enforced',async()=>{
  const db=await setup();
  try {
    await db.exec("update payroll_employee_payments set payment_status='pending' where id=2");
    const historical=payload(candidate({businessDate:'2026-09-04',attendanceRecordId:102,checkInAt:'2026-09-04T17:45:00+07:00',checkOutAt:'2026-09-05T00:00:00+07:00'}));
    const before=await decide(db,historical);
    const rows=(await db.query('select * from payroll_part_time_extra_work_decisions')).rows;
    await db.exec(readFileSync(migration,'utf8'));
    assert.deepEqual((await db.query('select * from payroll_part_time_extra_work_decisions')).rows,rows);
    const same=await decide(db,historical);
    assert.equal(String(same.id),String(before.id)); assert.equal(same.status,'unchanged');
    await assert.rejects(decide(db,{...historical,p_candidate_minutes:30,p_after_schedule_minutes:15}),/INVALID_DECISION/);
  } finally {await db.close();}
});

