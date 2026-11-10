import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setup as baseSetup, decide, candidate, payload } from './helpers/payroll-extra-work-db.mjs';
import { calculateCompensatedPayrollRates } from '../lib/payroll/compensation.ts';
import { calculateEmployeeLevel } from '../lib/employee-level/calculate.ts';
import { selectEmployeeLevelProgramVersionsForDates } from '../lib/employee-level/version-selection.ts';
import { normalizeAttendanceDayFacts } from '../lib/payroll/attendance-facts.ts';
import { mapContract, mapSchedule } from '../lib/payroll/db-mappers.ts';
async function setup(){const db=await baseSetup();await db.exec("alter table users add column level_base_mode text;alter table employee_level_program_versions add column salary_raise_enabled boolean default true");return db}
const migration=readFileSync('supabase/migrations/20261110134802_hourly_level_extra_work_rate.sql','utf8');
const legacyMigration=readFileSync('supabase/migrations/20261017082432_part_time_early_extra_work_october.sql.sql','utf8');

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
  const override=program ? (program.baseDateMode==='hire_date'?null:program.baseDate) : user.level_base_date_override;
  const info=calculateEmployeeLevel({role:user.role,levelProgramEnabled:enabled,hireDate:user.hire_date,
    levelBaseDateOverride:override,levelBaseMode:program?.baseDateMode,levelHireDateBase:program?.baseDateMode==='hire_date'?program.baseDate:null,salaryRaiseEnabled:program?.salaryRaiseEnabled,terminationDate:user.termination_date,isSystemAccount:user.is_system_account,asOfDate:date});
  const facts=normalizeAttendanceDayFacts({userId:7,businessDate:date,schedule,attendanceRecord:null});
  const compensation=calculateCompensatedPayrollRates({...contract,standardMinutesPerDay:facts.scheduledMinutes},info,contract);
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


async function fixture(){const db=await setup();await db.exec(legacyMigration);await db.exec(migration);return db}
async function policy(db,{level=1,minutes=420,days=26,enabled=true,raise=true,mode='hire_month'}={}){await prepare(db);const base=new Date(Date.UTC(2026,9-level*3,1)).toISOString().slice(0,10);await db.query('update payroll_contract_versions set standard_minutes_per_day=$1,standard_workdays=$2 where id=11',[minutes,days]);await db.query("update users set hire_date=$1,level_base_mode='hire_month' where id=7",[base]);await db.query('insert into employee_level_program_versions values(1,7,$1,$2,null,$3,$4,1,$5)',[enabled,base,base,mode,raise]);}
test('SQL authoritative hourly rates match TS for Lv0-7, original contract denominator, 7h/7.5h/null26 and salary exclusion',async()=>{const db=await fixture();try{for(const config of [...Array.from({length:8},(_,level)=>({level})),{minutes:450},{days:null},{enabled:false},{raise:false}]){await policy(db,config);const {row,compensation}=await acceptActual(db);const count=config.enabled===false||config.raise===false?0:config.level??1;assert.equal(row.hourlyRateAmount,Math.round(35000+count*500000/((config.minutes??420)*(config.days??26)/60)));assert.equal(compensation.hourlyStandardMonthlyHours,count?((config.minutes??420)*(config.days??26)/60):undefined);await rejectForged(db,row)}}finally{await db.close()}});
test('SQL respects dated legacy and month versions at promotion boundary',async()=>{const db=await fixture();try{for(const [mode,base,expected]of [['hire_month','2026-07-01',37747],['override_month','2026-07-01',37747],['hire_date','2026-07-02',35000],['override','2026-07-02',35000]]){await policy(db);await db.query('update employee_level_program_versions set base_date=$1,base_date_mode=$2 where id=1',[base,mode]);const {row}=await acceptActual(db);assert.equal(row.hourlyRateAmount,expected)}}finally{await db.close()}});
test('invalid hourly contract hours fail closed on both JS and authoritative SQL',async()=>{const db=await fixture();try{await policy(db);const {row}=await actualCandidate(db);for(const minutes of [0,-1]){await db.query('update payroll_contract_versions set standard_minutes_per_day=$1',[minutes]);assert.equal((await actualCandidate(db)).compensation.rates,null);await assert.rejects(decide(db,payload(row)),/INVALID_RATE_SOURCE/);assert.equal((await db.query('select count(*)::int n from payroll_part_time_extra_work_decisions')).rows[0].n,0)}}finally{await db.close()}});
test('daily/monthly rate branches are byte-preserved; paid and ledger images never rewritten',async()=>{const db=await fixture();try{const images=async()=>Promise.all(['payroll_employee_payments','ledger_sentinel'].map(async t=>(await db.query('select to_jsonb(t) row from '+t+' t order by id')).rows));const before=await images();for(const payType of ['daily','monthly']){await prepare(db,payType);await acceptActual(db)}assert.deepEqual(await images(),before);const branch=s=>s.slice(s.indexOf("  elsif v_pay_type = 'daily' then"),s.indexOf('  if v_minute_rate is null'));assert.equal(branch(migration),branch(legacyMigration));assert.doesNotMatch(migration,/update public\.(payroll_employee_payments|payroll_contract_versions|attendance_records|employee_level_audit_logs)/)}finally{await db.close()}});
