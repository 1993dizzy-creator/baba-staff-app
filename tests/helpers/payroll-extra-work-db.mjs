import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

import { calculatePartTimeExtraWork, partTimeExtraWorkSourceHash } from '../../lib/payroll/part-time-extra-work.ts';
export async function setup(Database = PGlite) {
  const db = new Database();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table users(id bigint primary key, role text, is_active boolean default true, is_system_account boolean default false, hire_date date, termination_date date, level_program_enabled boolean default false, level_base_date_override date);
    insert into users(id,role) values (1,'owner'),(7,'staff');
    create table attendance_records(id bigint primary key, user_id bigint, work_date date, check_in_at timestamptz, check_out_at timestamptz);
    insert into attendance_records values (101,7,'2026-10-01','2026-10-01T17:45:00+07:00','2026-10-01T23:15:00+07:00'),(102,7,'2026-09-04',null,null),(103,7,'2026-08-04',null,null);
    create table payroll_contract_versions(id bigint primary key, user_id bigint, revision int, pay_type text,
      calculation_basis text, effective_from date, effective_to date, base_salary bigint default 35000, fixed_raise_amount bigint default 0, standard_workdays int default 26, standard_minutes_per_day int default 600);
    insert into payroll_contract_versions values (11,7,3,'hourly','minute','2026-01-01',null);
    create table employee_work_schedule_versions(id bigint primary key, user_id bigint, revision int, start_time time, end_time time, effective_from date, effective_to date, unpaid_break_minutes int default 0);
    insert into employee_work_schedule_versions values(21,7,4,'18:00','23:00','2026-01-01',null);
    create table employee_level_program_versions(id bigint primary key, user_id bigint, enabled boolean, effective_from date, effective_to date, base_date date, base_date_mode text, revision int);
    create table store_setting_versions(id bigint primary key, revision int, state text, effective_from_business_date date);
    insert into store_setting_versions values(31,5,'active','2026-01-01');
    create table store_business_hours(setting_version_id bigint, weekday int, is_closed boolean, open_time time, close_time time);
    insert into store_business_hours select 31,d,false,'16:00','01:00' from generate_series(0,6) d;
    create table payroll_payment_batches(id bigint primary key, payroll_month date);
    create table payroll_employee_payments(id bigint primary key, payroll_batch_id bigint, user_id bigint, payment_status text, calculation_snapshot jsonb);
    insert into payroll_payment_batches values (1,'2026-08-01'),(2,'2026-09-01'),(3,'2026-10-01');
    insert into payroll_employee_payments values (1,1,7,'paid','{"month":"August"}'),(2,2,7,'paid','{"month":"September"}');
    create table ledger_sentinel(id bigint primary key, amount bigint, snapshot jsonb);
    insert into ledger_sentinel values (1,123456,'{"source":"paid-payroll"}');`);
  for (const name of ['20260909064418_add_part_time_extra_work_decisions','20260909064505_tighten_part_time_extra_work_privileges',
    '20260909064732_add_part_time_extra_work_decision_rpcs','20260912070744_fix_extra_work_after_schedule_compatibility',
    '20260912075601_fix_extra_work_decision_rpc_after_schedule']) {
    await db.exec(readFileSync(`supabase/migrations/${name}.sql`,'utf8'));
  }
  await db.exec('grant select on users,attendance_records,payroll_contract_versions,employee_work_schedule_versions,employee_level_program_versions,store_setting_versions,store_business_hours,payroll_payment_batches,payroll_employee_payments to service_role');
  return db;
}
export const candidate = (changes = {}) => calculatePartTimeExtraWork({
  payType:'hourly', attendanceRecordId:101, userId:7, businessDate:'2026-10-01',
  checkInAt:'2026-10-01T17:45:00+07:00', checkOutAt:'2026-10-01T23:15:00+07:00',
  contractId:11, contractRevision:3, minuteRateAmount:35000/60, hourlyRateAmount:35000,
  scheduleId:21, scheduleRevision:4, scheduleStartTime:'18:00', scheduleEndTime:'23:00',
  storeSettingId:31, storeSettingRevision:5, storeOpenTime:'16:00', storeCloseTime:'01:00', ...changes,
});
export const source = candidate().sourceSnapshot;
export function payload(row) {
  return {p_attendance_record_id:row.attendanceRecordId,p_user_id:row.userId,p_business_date:row.businessDate,
    p_payroll_month:row.businessDate.slice(0,7)+'-01',p_candidate_minutes:row.candidateMinutes,p_candidate_amount:row.candidateAmount,
    p_hourly_rate_amount:row.hourlyRateAmount,p_before_schedule_minutes:row.beforeScheduleMinutes,p_after_schedule_minutes:row.afterScheduleMinutes,
    p_excluded_before_open_minutes:row.excludedBeforeOpenMinutes,p_excluded_after_close_minutes:row.excludedAfterCloseMinutes,
    p_schedule_start_time:row.scheduleStartTime,p_schedule_end_time:row.scheduleEndTime,p_store_open_time:row.storeOpenTime,p_store_close_time:row.storeCloseTime,
    p_source_hash:row.sourceHash,p_source_snapshot:row.sourceSnapshot};
}
export async function decide(db, overrides={}) {
  const p = {p_attendance_record_id:101,p_user_id:7,p_payroll_month:'2026-10-01',p_business_date:'2026-10-01',
    p_decision:'approved',p_candidate_minutes:30,p_candidate_amount:17500,p_hourly_rate_amount:35000,
    p_before_schedule_minutes:15,p_after_schedule_minutes:15,p_excluded_before_open_minutes:0,p_excluded_after_close_minutes:0,
    p_schedule_start_time:'18:00',p_schedule_end_time:'23:00',p_store_open_time:'16:00',p_store_close_time:'01:00',
    p_source_hash:partTimeExtraWorkSourceHash(overrides.p_source_snapshot ?? source),p_source_snapshot:source,p_decision_reason:null,p_actor_user_id:1,...overrides};
  const types=['bigint','bigint','date','date','text','integer','bigint','bigint','integer','integer','integer','integer','time','time','time','time','text','jsonb','text','bigint'];
  return (await db.query(`select payroll_admin_set_part_time_extra_work_decision_v1(${Object.keys(p).map((k,i)=>`${k} => $${i+1}::${types[i]}`).join(',')}) as result`,Object.values(p))).rows[0].result;
}
