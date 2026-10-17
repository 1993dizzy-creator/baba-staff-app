import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setup, decide, candidate, payload } from './helpers/payroll-extra-work-db.mjs';
import { calculateCompensatedPayrollRates } from '../lib/payroll/compensation.ts';
import { calculateEmployeeLevel } from '../lib/employee-level/calculate.ts';
import { selectEmployeeLevelProgramVersionsForDates } from '../lib/employee-level/version-selection.ts';
import { normalizeAttendanceDayFacts } from '../lib/payroll/attendance-facts.ts';
import { mapContract, mapSchedule } from '../lib/payroll/db-mappers.ts';
const migration=readFileSync('supabase/migrations/20261017072217_part_time_early_extra_work_october.sql','utf8');

// Use the actual JS policy modules as the oracle, not a second test rate formula.
async function actualCandidate(db) {
  const raw=(await db.query('select to_jsonb(a) r from attendance_records a where id=101')).rows[0].r;
  const date=String(raw.work_date).slice(0,10);
  const user=(await db.query('select to_jsonb(u) r from users u where id=7')).rows[0].r;
  const contract=mapContract((await db.query('select to_jsonb(c) r from payroll_contract_versions c where user_id=7 and effective_from<=$1 and (effective_to is null or effective_to>$1)',[date])).rows[0].r);
  const schedule=mapSchedule((await db.query('select to_jsonb(s) r from employee_work_schedule_versions s where user_id=7 and effective_from<=$1 and (effective_to is null or effective_to>$1)',[date])).rows[0].r);
  const programs=(await db.query('select to_jsonb(v) r from employee_level_program_versions v where user_id=7 order by revision desc')).rows.map(row=>row.r);
  const versions=selectEmployeeLevelProgramVersionsForDates(programs,[date,date.slice(0,7)+'-01']);
  const program=versions.get(date)?.get(7) ?? versions.get(date.slice(0,7)+'-01')?.get(7);
  const enabled=program ? program.enabled : user.level_program_enabled;
  const override=program ? (program.baseDateMode==='override'?program.baseDate:null) : user.level_base_date_override;
  const info=calculateEmployeeLevel({role:user.role,levelProgramEnabled:enabled,hireDate:user.hire_date,
    levelBaseDateOverride:override,terminationDate:user.termination_date,isSystemAccount:user.is_system_account,asOfDate:date});
  const facts=normalizeAttendanceDayFacts({userId:7,businessDate:date,schedule,attendanceRecord:null});
  const compensation=calculateCompensatedPayrollRates({...contract,standardMinutesPerDay:facts.scheduledMinutes},info);
  if(!compensation.rates) return {row:null,info,compensation};
  const minuteRateAmount=compensation.rates.minuteRate;
  const row=candidate({payType:contract.payType,businessDate:date,contractId:contract.id,contractRevision:contract.revision,
    checkInAt:`${date}T17:45:00+07:00`,checkOutAt:`${date}T23:45:00+07:00`,
    scheduleId:schedule.id,scheduleRevision:schedule.revision,scheduleStartTime:schedule.startTime,scheduleEndTime:schedule.endTime,
    minuteRateAmount,hourlyRateAmount:Math.round(minuteRateAmount*60)});
  return {row,info,compensation};
}
async function prepare(db, payType='hourly') {
  await db.exec("delete from payroll_part_time_extra_work_decisions; delete from employee_level_program_versions; update users set role='staff',hire_date='2025-01-31',termination_date=null,level_program_enabled=true,level_base_date_override=null,is_system_account=false where id=7; update attendance_records set work_date='2026-10-01',check_in_at='2026-10-01T17:45:00+07:00',check_out_at='2026-10-01T23:45:00+07:00' where id=101; update employee_work_schedule_versions set start_time='18:00',end_time='23:00',unpaid_break_minutes=30 where id=21");
  const salary=payType==='hourly'?35000:payType==='daily'?360000:9100000;
  await db.query('update payroll_contract_versions set pay_type=$1,base_salary=$2,fixed_raise_amount=170003,standard_workdays=26,standard_minutes_per_day=600 where id=11',[payType,salary]);
}
async function acceptActual(db) {
  const {row,...rest}=await actualCandidate(db);
  assert.ok(row);
  await db.query('update attendance_records set check_in_at=$1,check_out_at=$2 where id=101',[row.checkInAt,row.checkOutAt]);
  assert.equal((await decide(db,payload(row))).status,'created');
  return {row,...rest};
}
async function rejectForged(db,row,changes={}) {
  // The real calculator creates an internally valid snapshot and recomputes SHA-256.
  const forged=candidate({...row,payType:row.sourceSnapshot.payType??'monthly',decision:undefined,
    minuteRateAmount:row.minuteRateAmount*2,hourlyRateAmount:Math.round(row.minuteRateAmount*2*60),...changes});
  assert.ok(forged); assert.notEqual(forged.sourceHash,row.sourceHash);
  assert.equal(forged.candidateAmount,Math.round(forged.minuteRateAmount*forged.candidateMinutes));
  const before=(await db.query('select * from payroll_part_time_extra_work_decisions order by id')).rows;
  await assert.rejects(decide(db,payload(forged)),/PAYROLL_EXTRA_WORK_RATE_MISMATCH/);
  assert.deepEqual((await db.query('select * from payroll_part_time_extra_work_decisions order by id')).rows,before);
}

test('hourly and daily reject jointly forged rates, amounts, snapshots and hashes against actual dated contracts',async()=>{
  const db=await setup();
  try {
    await db.exec(migration);
    for(const payType of ['hourly','daily']) {
      await prepare(db,payType);
      const {row,compensation}=await acceptActual(db);
      assert.equal(compensation.fixedRaiseAmount,0);
      assert.equal(compensation.levelRaiseAmount,0);
      assert.equal(row.minuteRateAmount,payType==='hourly'?35000/60:360000/270);
      await rejectForged(db,row);
      if(payType==='daily') await rejectForged(db,row,{minuteRateAmount:360000/600,hourlyRateAmount:36000});
    }
  } finally {await db.close();}
});

test('monthly authoritative rate matches JS dated raises, role eligibility, termination, caps and calendar anniversaries',async()=>{
  const db=await setup();
  try {
    await db.exec(migration);
    for(const mutation of [
      "select 1",
      "update users set level_program_enabled=false where id=7",
      "update users set level_program_enabled=null where id=7",
      "update users set role='owner',level_program_enabled=true where id=7",
      "update users set role='owner',level_program_enabled=null where id=7",
      "update users set role='viewer' where id=7",
      "update users set is_system_account=true where id=7",
      "update users set hire_date='2020-01-01' where id=7",
      "update users set hire_date='2027-01-01' where id=7",
      "update users set termination_date='2025-04-30' where id=7",
      "update users set level_base_date_override='2026-07-01' where id=7",
      "insert into employee_level_program_versions values(1,7,true,'2026-10-01',null,'2026-07-01','override',1)",
      "insert into employee_level_program_versions values(1,7,false,'2026-10-01',null,null,'hire_date',1)",
      "insert into employee_level_program_versions values(1,7,true,'2026-10-01','2026-10-10','2026-07-01','override',1); update attendance_records set work_date='2026-10-17' where id=101",
      "update users set hire_date='2026-07-31' where id=7; update attendance_records set work_date='2026-10-30' where id=101",
      "update users set hire_date='2026-07-31' where id=7; update attendance_records set work_date='2026-10-31' where id=101",
      "update users set hire_date='2026-11-30' where id=7; update attendance_records set work_date='2027-02-28' where id=101",
    ]) {
      await prepare(db,'monthly'); await db.exec(mutation);
      const {row}=await acceptActual(db);
      assert.equal(row.candidateMinutes,45); // monthly still excludes early work
      await rejectForged(db,row);
    }
  } finally {await db.close();}
});

test('missing monthly level base fails closed, and ignored or ineligible raises cannot be forged',async()=>{
  const db=await setup();
  try {
    await db.exec(migration);
    await prepare(db,'monthly'); const {row}=await acceptActual(db);
    await db.exec('update users set hire_date=null where id=7');
    assert.equal((await actualCandidate(db)).compensation.rates,null);
    await assert.rejects(decide(db,payload(row)),/INVALID_RATE_SOURCE/);
    await db.exec('update users set level_program_enabled=false where id=7');
    const {row:disabled}=await acceptActual(db);
    await rejectForged(db,disabled);
  } finally {await db.close();}
});

test('new pre-October requests cannot forge salary rates and historical approved rows remain unchanged',async()=>{
  const db=await setup();
  try {
    await db.exec(migration); await prepare(db,'hourly');
    await db.exec("update payroll_employee_payments set payment_status='pending' where id=2; update attendance_records set work_date='2026-09-04' where id=101");
    const {row}=await acceptActual(db);
    assert.equal(row.candidateMinutes,45);
    const forged=candidate({...row,payType:'hourly',minuteRateAmount:70000/60,hourlyRateAmount:70000});
    await assert.rejects(decide(db,payload(forged)),/RATE_MISMATCH/);
    const saved=(await db.query('select * from payroll_part_time_extra_work_decisions')).rows;
    assert.equal((await decide(db,payload(row))).status,'unchanged');
    assert.deepEqual((await db.query('select * from payroll_part_time_extra_work_decisions')).rows,saved);
  } finally {await db.close();}
});

test('cancellation returns the exact Production contract while preserving audit rows',async()=>{
  const db=await setup();
  try {
    await db.exec(migration);
    const cancel=(id=101,reason='manager reason')=>db.query('select payroll_admin_cancel_part_time_extra_work_decision_v1($1,$2,1) r',[id,reason]);
    assert.deepEqual((await cancel()).rows[0].r,{status:'not_active'});
    assert.deepEqual((await cancel(999)).rows[0].r,{status:'not_active'});
    await assert.rejects(cancel(101,''),error=>error.message==='PAYROLL_EXTRA_WORK_CANCEL_REASON_REQUIRED'&&error.code==='22023');
    const first=await decide(db);
    await db.exec("insert into payroll_employee_payments values(3,3,7,'paid','{}')");
    await assert.rejects(cancel(),error=>error.message==='PAYROLL_EXTRA_WORK_LOCKED_FOR_PAID_EMPLOYEE'&&error.code==='55000');
    await db.exec('delete from payroll_employee_payments where id=3');
    assert.deepEqual((await cancel()).rows[0].r,{id:Number(first.id),status:'cancelled'});
    const saved=(await db.query('select * from payroll_part_time_extra_work_decisions')).rows;
    assert.equal(saved[0].cancellation_reason,'manager reason');
    assert.deepEqual((await cancel()).rows[0].r,{status:'not_active'});
    assert.deepEqual((await db.query('select * from payroll_part_time_extra_work_decisions')).rows,saved);
  } finally {await db.close();}
});
