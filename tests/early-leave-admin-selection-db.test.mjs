import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync('supabase/migrations/20261001061230_add_early_leave_admin_selection.sql','utf8');
async function database(){
 const db=new PGlite();
 await db.exec(`
 create role anon; create role authenticated; create role service_role;
 create table users(id bigint primary key,role text,is_active boolean,work_end_time time);
 create table attendance_records(id bigint primary key,user_id bigint,work_date date,status text,check_in_at timestamptz,check_out_at timestamptz,late_minutes integer,early_leave_minutes integer,updated_at timestamptz);
 create table store_setting_versions(id bigint primary key,state text,effective_from_business_date date,business_day_cutoff_time time);
 create table store_attendance_policies(setting_version_id bigint,early_leave_grace_minutes integer);
 create table store_business_hours(setting_version_id bigint,weekday integer,is_closed boolean,close_time time);
 create table store_business_day_overrides(business_date date,state text,actual_close_time time);
 create table employee_work_schedule_versions(id bigint,user_id bigint,effective_from date,effective_to date,end_time time);
 create table payroll_payment_batches(id bigint primary key,payroll_month date);
 create table payroll_employee_payments(user_id bigint,payroll_batch_id bigint,payment_status text);
 create table attendance_record_audit_logs(id bigint generated always as identity,attendance_record_id bigint,source_attendance_record_id bigint,target_user_id bigint,work_date date,action text,actor_user_id bigint,before_snapshot jsonb,after_snapshot jsonb,reason text);
 insert into users values(1,'owner',true,'01:00'),(9,'staff',true,'01:00');
 insert into store_setting_versions values(1,'active','2026-09-01','03:00');
 insert into store_attendance_policies values(1,60);
 insert into store_business_hours select 1,n,false,'01:00' from generate_series(0,6)n;
 insert into employee_work_schedule_versions values(1,9,'2026-09-01',null,'01:00');
 insert into attendance_records values(1,9,'2026-09-01','early_leave','2026-09-01 16:00+07','2026-09-01 23:59+07',20,1,'2026-09-02 02:00+07');
 `);
 await db.exec(readFileSync('supabase/migrations/202607240005_add_attendance_manual_override_marker.sql','utf8'));
 await db.exec(migration);
 return db;
}
async function context(db){return (await db.query(`select attendance_early_leave_context_v1(r) as c from attendance_records r where id=1`)).rows[0].c;}
async function resolve(db,selection,patch={}){
 const r=(await db.query('select * from attendance_records where id=1')).rows[0];const c=await context(db);
 const params=[1,1,selection,r.updated_at,r.check_in_at,r.check_out_at,c.normalCheckoutThresholdAt,c.earlyLeaveGraceMinutes];
 if(patch.out!==undefined)params[5]=patch.out;
 return (await db.query('select attendance_admin_resolve_early_leave_v1($1,$2,$3,$4,$5,$6,$7,$8) as result',params)).rows[0].result;
}
test('local migration preserves active uniqueness, permissions and existing normalization; each selection persists atomically',async()=>{
 const db=await database();try{
  assert.equal((await context(db)).earlyLeaveReviewRequired,true);
  assert.equal((await resolve(db,'use_raw')).status,'ok');
  let c=await context(db);assert.equal(c.earlyLeaveSelection,'use_raw');assert.equal(c.earlyLeaveReviewRequired,false);
  assert.equal((await db.query('select early_leave_minutes from attendance_records')).rows[0].early_leave_minutes,61);
  assert.equal((await resolve(db,'use_effective')).status,'review_not_required');
  await assert.rejects(db.exec(`insert into attendance_record_manual_overrides(attendance_record_id,override_metric,override_action,actor_user_id)values(1,'early_leave','use_effective',1)`),/duplicate key/);
  const normalized=(await db.query(`select attendance_admin_normalize_late_v1(1,1,null) as r`)).rows[0].r;
  assert.equal(normalized.status,'ok');assert.equal(normalized.record.late_minutes,0);assert.equal(normalized.record.early_leave_minutes,61);
  assert.equal((await context(db)).earlyLeaveSelection,'use_raw');
  const permission=(await db.query(`select has_function_privilege('anon','attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer)','EXECUTE') as anon,
    has_function_privilege('authenticated','attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer)','EXECUTE') as authenticated,
    has_function_privilege('service_role','attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer)','EXECUTE') as service`)).rows[0];
  assert.deepEqual(permission,{anon:false,authenticated:false,service:true});
  assert.equal((await db.query(`select count(*)::integer n from attendance_record_audit_logs where action='normalize_early_leave'`)).rows[0].n,1);
 }finally{await db.close()}
});
test('checkout changes revoke the decision and reopen the banner; cancellation and within-grace edits clear review',async()=>{
 const db=await database();try{
  await resolve(db,'use_raw');
  await db.exec(`update attendance_records set check_out_at='2026-09-01 23:00+07',early_leave_minutes=60,updated_at=now()where id=1`);
  assert.equal((await context(db)).earlyLeaveReviewRequired,true);
  assert.equal((await db.query(`select revoke_reason from attendance_record_manual_overrides where override_metric='early_leave'`)).rows[0].revoke_reason,'attendance_source_changed');
  await resolve(db,'use_effective');
  assert.equal((await db.query('select early_leave_minutes from attendance_records')).rows[0].early_leave_minutes,60);
  await db.exec(`update attendance_records set check_out_at=null,status='working',early_leave_minutes=0,updated_at=now()where id=1`);
  assert.equal((await context(db)).earlyLeaveSelection,null);assert.equal((await context(db)).earlyLeaveReviewRequired,false);
  await db.exec(`update attendance_records set check_out_at='2026-09-02 00:01+07',status='done',updated_at=now()where id=1`);
  assert.equal((await context(db)).earlyLeaveReviewRequired,false);
 }finally{await db.close()}
});
test('paid payroll blocks resolution, checkout edits and cancellation without revoking the existing choice',async()=>{
 const db=await database();try{
  await resolve(db,'use_raw');
  await db.exec(`insert into payroll_payment_batches values(1,'2026-09-01');insert into payroll_employee_payments values(9,1,'paid')`);
  assert.equal((await resolve(db,'use_effective')).status,'payroll_paid_locked');
  for(const sql of [`update attendance_records set check_out_at=null where id=1`,`update attendance_records set check_out_at='2026-09-01 23:00+07'where id=1`,`delete from attendance_records where id=1`])await assert.rejects(db.exec(sql),/PAYROLL_ATTENDANCE_LOCKED_FOR_PAID_EMPLOYEE/);
  assert.equal((await context(db)).earlyLeaveSelection,'use_raw');
 }finally{await db.close()}
});
test('stale sources and audit failure cannot leave a partial decision or altered record',async()=>{
 const db=await database();try{
  assert.equal((await resolve(db,'use_raw',{out:'2026-09-01 23:00+07'})).status,'record_changed');
  assert.equal((await resolve(db,'invalid')).status,'invalid_selection');
  await db.exec(`alter table attendance_record_audit_logs add constraint reject_review_test check(action<>'normalize_early_leave')`);
  await assert.rejects(resolve(db,'use_raw'),/reject_review_test/);
  assert.equal((await context(db)).earlyLeaveSelection,null);
  assert.equal((await db.query('select early_leave_minutes from attendance_records')).rows[0].early_leave_minutes,1);
 }finally{await db.close()}
});
test('SQL source calculation uses date schedules and actual closing, matching raw/grace review edges',async()=>{
 const db=await database();try{
  for(const raw of [59,60,61,120]){
   await db.query(`update attendance_records set check_out_at=timestamptz '2026-09-02 01:00+07'-$1*interval '1 minute' where id=1`,[raw]);
   const c=await context(db);assert.equal(c.rawEarlyLeaveMinutes,raw);assert.equal(c.effectiveEarlyLeaveMinutes,Math.max(0,raw-60));assert.equal(c.earlyLeaveReviewRequired,raw>60);
  }
  await db.exec(`insert into store_business_day_overrides values('2026-09-01','active','23:00');update attendance_records set check_out_at='2026-09-01 21:59+07'where id=1`);
  const c=await context(db);assert.equal(c.rawEarlyLeaveMinutes,61);assert.equal(c.effectiveEarlyLeaveMinutes,1);
  const list=(await db.query(`select attendance_early_leave_contexts_v1('2026-08-01','2026-09-30',9) as c`)).rows[0].c;
  assert.equal(list.filter(c=>c.earlyLeaveReviewRequired).length,1);
  await resolve(db,'use_effective');
  assert.equal((await db.query(`select attendance_early_leave_contexts_v1('2026-09-01','2026-09-30',9) as c`)).rows[0].c.filter(c=>c.earlyLeaveReviewRequired).length,0);
  assert.doesNotMatch(migration,/ledger_close_preflight_v1|earlyLeaveState/);
  assert.doesNotMatch(migration,/create table|drop index|delete from attendance_record_manual_overrides/i);
 }finally{await db.close()}
});

test('database payment guard blocks pending early-leave review before payroll is paid',async()=>{
 const db=await database();try{
  await db.exec(`insert into payroll_payment_batches values(1,'2026-09-01')`);
  await assert.rejects(db.exec(`insert into payroll_employee_payments values(9,1,'paid')`),/EARLY_LEAVE_REVIEW_REQUIRED/);
  assert.equal((await db.query('select count(*)::integer n from payroll_employee_payments')).rows[0].n,0);
  await resolve(db,'use_raw');
  await db.exec(`insert into payroll_employee_payments values(9,1,'paid')`);
  assert.equal((await db.query('select count(*)::integer n from payroll_employee_payments')).rows[0].n,1);
 }finally{await db.close()}
});


const policyChanges=[
 ['grace',"update store_attendance_policies set early_leave_grace_minutes=30",121,30],
 ['schedule end',"update employee_work_schedule_versions set end_time='00:30'",91,60],
 ['store close',"update store_business_hours set close_time='00:30'",91,60],
 ['special closing',"insert into store_business_day_overrides values('2026-09-01','active','00:30')",91,60],
];
for(const [name,sql,raw,grace] of policyChanges){
 test('changed '+name+' invalidates the basis, blocks payment and allows atomic re-confirmation',async()=>{
  const db=await database();try{
   await db.exec("update attendance_records set check_out_at='2026-09-01 22:59+07'where id=1");
   await resolve(db,'use_raw');
   const before=await context(db);
   const saved=(await db.query("select * from attendance_record_manual_overrides where override_metric='early_leave'")).rows[0];
   assert.equal(new Date(saved.decision_threshold_at).toISOString(),new Date(before.normalCheckoutThresholdAt).toISOString());
   assert.equal(saved.decision_grace_minutes,60);
   assert.equal(before.earlyLeaveSelection,'use_raw');
   await db.exec(sql);
   const stale=await context(db);
   assert.equal(stale.rawEarlyLeaveMinutes,raw);assert.equal(stale.earlyLeaveGraceMinutes,grace);
   assert.equal(stale.earlyLeaveSelection,null);assert.equal(stale.earlyLeaveReviewRequired,true);
   const list=(await db.query("select attendance_early_leave_contexts_v1('2026-09-01','2026-09-30',9) as c")).rows[0].c;
   assert.equal(list.filter(c=>c.earlyLeaveReviewRequired).length,1);
   await db.exec("insert into payroll_payment_batches values(1,'2026-09-01');insert into payroll_employee_payments values(9,1,'pending')");
   await assert.rejects(db.exec("update payroll_employee_payments set payment_status='paid'"),/EARLY_LEAVE_REVIEW_REQUIRED/);
   assert.equal((await resolve(db,'use_effective')).status,'ok');
   const rows=(await db.query("select * from attendance_record_manual_overrides where override_metric='early_leave'order by id")).rows;
   assert.equal(rows.length,2);assert.ok(rows[0].revoked_at);
   assert.equal(rows[0].revoke_reason,'policy_source_changed');assert.equal(rows[0].revoked_by,1);
   assert.equal(rows.filter(row=>row.revoked_at===null).length,1);
   assert.equal(rows[1].decision_grace_minutes,grace);
   assert.equal(new Date(rows[1].decision_threshold_at).toISOString(),new Date(stale.normalCheckoutThresholdAt).toISOString());
   const current=await context(db);
   assert.equal(current.earlyLeaveSelection,'use_effective');assert.equal(current.earlyLeaveReviewRequired,false);
   assert.equal((await db.query('select early_leave_minutes from attendance_records')).rows[0].early_leave_minutes,raw-grace);
   await db.exec("update payroll_employee_payments set payment_status='paid'");
  }finally{await db.close()}
 });
}

test('unchanged basis retains the choice; late normalization keeps nullable basis and is independent',async()=>{
 const db=await database();try{
  await resolve(db,'use_effective');
  await db.exec("update store_attendance_policies set early_leave_grace_minutes=60;update employee_work_schedule_versions set end_time='01:00'");
  assert.equal((await context(db)).earlyLeaveSelection,'use_effective');
  assert.equal((await resolve(db,'use_raw')).status,'review_not_required');
  assert.equal((await db.query('select attendance_admin_normalize_late_v1(1,1,null) as r')).rows[0].r.status,'ok');
  const late=(await db.query("select decision_threshold_at,decision_grace_minutes,revoked_at from attendance_record_manual_overrides where override_metric='late'")).rows[0];
  assert.deepEqual(late,{decision_threshold_at:null,decision_grace_minutes:null,revoked_at:null});
  await db.exec('update store_attendance_policies set early_leave_grace_minutes=30');
  assert.equal((await context(db)).earlyLeaveReviewRequired,true);
  await resolve(db,'use_raw');
  assert.equal((await db.query("select revoked_at from attendance_record_manual_overrides where override_metric='late'")).rows[0].revoked_at,null);
  assert.equal((await db.query('select late_minutes from attendance_records')).rows[0].late_minutes,0);
 }finally{await db.close()}
});

test('missing basis is stale and audit failure rolls back revocation and replacement',async()=>{
 const db=await database();try{
  await db.exec("insert into attendance_record_manual_overrides(attendance_record_id,override_metric,override_action,actor_user_id)values(1,'early_leave','use_raw',1)");
  assert.equal((await context(db)).earlyLeaveSelection,null);assert.equal((await context(db)).earlyLeaveReviewRequired,true);
  await db.exec("alter table attendance_record_audit_logs add constraint reject_review_test check(action<>'normalize_early_leave')");
  await assert.rejects(resolve(db,'use_effective'),/reject_review_test/);
  const rows=(await db.query("select revoked_at from attendance_record_manual_overrides where override_metric='early_leave'")).rows;
  assert.deepEqual(rows,[{revoked_at:null}]);
  await db.exec('alter table attendance_record_audit_logs drop constraint reject_review_test');
  assert.equal((await resolve(db,'use_effective')).status,'ok');
  assert.equal((await context(db)).earlyLeaveReviewRequired,false);
 }finally{await db.close()}
});

test('policy change within grace invalidates selection without review or payment block',async()=>{
 const db=await database();try{
  await resolve(db,'use_raw');
  await db.exec('update store_attendance_policies set early_leave_grace_minutes=61');
  const c=await context(db);assert.equal(c.earlyLeaveSelection,null);assert.equal(c.earlyLeaveReviewRequired,false);
  assert.equal((await resolve(db,'use_effective')).status,'review_not_required');
  await db.exec("insert into payroll_payment_batches values(1,'2026-09-01');insert into payroll_employee_payments values(9,1,'paid')");
 }finally{await db.close()}
});
