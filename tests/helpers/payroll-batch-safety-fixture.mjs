import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const root=fileURLToPath(new URL('../../',import.meta.url));
export const read=path=>readFileSync(resolve(root,path),'utf8').replace(/\r\n/g,'\n');
export const safetyPath='supabase/migrations/20261114132205_payroll_selected_employee_payment_safety.sql';
export function definition(file,name){
  const sql=read('supabase/migrations/'+file),start=sql.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`,'i'));
  assert.ok(start>=0,name);const rest=sql.slice(start),as=rest.match(/\bas\s+(\$[a-z_]*\$)/i);assert.ok(as,name);
  const end=rest.indexOf(as[1],as.index+as[0].length);return rest.slice(0,end+as[1].length)+';';
}
export async function install(db,{safety=true,rolesExist=false}={}){
  // Reuse the anonymized employee/level fixture. Payment and contract constraints
  // below are the real migration DDL, including state and no-overlap constraints.
  let employees=read('tests/employee-level-month-base-db.test.mjs').split('const FIXTURE = `')[1].split('`;')[0];
  employees=employees.replace(/create table public\.payroll_employee_payments[^;]+;/,'');
  if(rolesExist)employees=employees.replace(/create role (anon|authenticated|service_role) nologin;/g,'');
  await db.exec(employees);
  await db.exec('create schema extensions;create extension btree_gist with schema extensions;');
  const shadow=read('supabase/migrations/202607270001_create_payroll_shadow_foundation.sql');
  await db.exec(shadow.slice(shadow.indexOf('create table public.payroll_contract_versions'),shadow.indexOf('create index employee_schedule')));
  const compensation=read('supabase/migrations/202607300001_add_payroll_compensation_and_adjustment_ledger.sql');
  await db.exec(compensation.slice(0,compensation.indexOf('alter table public.payroll_runs')));
  await db.exec(`alter table payroll_contract_versions drop constraint payroll_contract_versions_calculation_basis_check;
    alter table payroll_contract_versions add constraint payroll_contract_versions_calculation_basis_check check(calculation_basis in('minute','hour','day','fixed_monthly'));
    create unique index users_username on users(username);
    insert into users(id,username,password,name,role,hire_date) values(1,'owner','fixture','Owner','owner','2025-01-01');
    select setval(pg_get_serial_sequence('users','id'),100);`);
  // Existing local ledger fixture, with the real month-closure table substituted.
  const ledger=read('tests/ledger-payroll-payment-groups-db.test.mjs');
  const ddl=ledger.slice(ledger.indexOf(' create table ledger_fund_accounts'),ledger.indexOf('`);\n let base='));
  await db.exec(ddl.replace(/ create table ledger_month_closures[^;]+;/,'').replace('create schema extensions;','create schema if not exists extensions;'));
  const close=read('supabase/migrations/202608210008_add_ledger_month_close_corrections.sql');
  await db.exec(close.slice(close.indexOf('create table public.ledger_month_closures'),close.indexOf('alter table public.ledger_transactions')));
  const reopen=read('supabase/migrations/20260916161512_add_ledger_month_reopen.sql');
  // Install the FINAL close/reclose/reopen definitions, preserving their global
  // serialization, history table and revision/audit semantics.
  await db.exec(reopen.slice(0,reopen.indexOf('-- Keep the current profit-capacity contract')));
  const base=read('supabase/migrations/202608050001_add_employee_payment_batches.sql');
  await db.exec(definition('202607270002_create_payroll_runs.sql','payroll_assert_actor_v2'));
  await db.exec(base.slice(base.indexOf('create table'),base.indexOf('create function public.payroll_lock_paid_month_adjustments_v1')));
  await db.exec('alter table payroll_payment_batches add column employee_pit_total bigint default 0,add column company_pit_total bigint default 0,add column advance_total bigint default 0;alter table payroll_employee_payments add column fund_account_id bigint references ledger_fund_accounts(id);');
  await db.exec(read('supabase/migrations/20261110030000_employee_level_month_base_v1.sql'));
  for(const [file,names] of [
    ['202607300001_add_payroll_compensation_and_adjustment_ledger.sql',['payroll_create_contract_version_v2']],
    ['202608070003_fix_fixed_monthly_contract_delegate.sql',['payroll_create_contract_version_v6']],
    ['20260908115312_add_payroll_tax_versions.sql',['payroll_refresh_payment_tax_totals_v1','payroll_pay_employee_v2','payroll_cancel_employee_payment_v2']],
    ['202608210008_add_ledger_month_close_corrections.sql',['ledger_month_is_closed_v1','ledger_assert_month_open_v1','ledger_sync_payroll_company_cost_v2']],
    ['202608210005_add_ledger_meal_payroll_sync.sql',['ledger_sync_payroll_company_cost_v1']],
    ['20260916090759_auto_group_payroll_payments.sql',['ledger_project_payroll_payment_group_v1']],
    ['20260916091129_auto_sync_payroll_company_cost_on_completion.sql',['ledger_sync_payroll_batch_company_cost_v1']],
    ['20260916094323_restore_safe_payroll_group_projection.sql',['payroll_pay_employee_v3','payroll_cancel_employee_payment_v3']],
  ])for(const name of names)await db.exec(definition(file,name));
  // Only unrelated card-fee permissions and ledger preflight are local stubs.
  // Real close, lock, transaction guard, finalization and payment bodies run below.
  await db.exec(`create schema ledger_card_fee_private;
    create function ledger_card_fee_private.allowed_transaction(public.ledger_transactions) returns boolean language sql as 'select false';
    create function ledger_card_fee_private.allowed_reversal(public.ledger_transactions) returns boolean language sql as 'select false';
    create function ledger_close_preflight_v1(date,bigint) returns jsonb language sql as $$select '{"status":"ok","canClose":true,"preflightHash":"fresh","warnings":[]}'::jsonb$$;`);
  await db.exec(definition('20261001193526_auto_finalize_closed_month_card_fees.sql','ledger_transaction_month_guard_v1'));
  await db.exec('create trigger ledger_transactions_month_guard before insert or update or delete on ledger_transactions for each row execute function ledger_transaction_month_guard_v1();');
  await db.exec(read('supabase/migrations/20261003090000_close_ledger_before_payroll_payment.sql'));
  await db.exec(read('supabase/migrations/20261114124930_new_fixed_employee_first_month_proration.sql'));
  const category=/where name='([^']+)' and kind='expense'/.exec(read('supabase/migrations/202608210005_add_ledger_meal_payroll_sync.sql'))[1];
  await db.query('insert into ledger_categories values(9,$1,\'expense\',true)',[category]);
  if(safety)await db.exec(read(safetyPath));
  return db;
}
export const MONTH='2026-08-01',PAY_DATE='2026-09-10';
export async function newEmployee(db,name,{active=true}={}){
  const user=(await db.query(`select employee_create_with_proration_v1($1,false,'hire_month',null,null,'fixture',1,'owner') r`,
    [JSON.stringify({username:name,password:'fixture',name,role:'staff',hire_date:'2026-08-16',attendance_tracking_enabled:false,is_active:true})])).rows[0].r;
  if(active)await activate(db,user.id);return user;
}
export const activate=(db,id)=>(db.query(`select payroll_link_first_month_contract_v1($1,8000000,0,26,'2026-08-01',1) r`,[id])).then(r=>r.rows[0].r);
export const closeMonth=(db,month=MONTH)=>(db.query(`select ledger_close_month_v1($1,'fresh','{}','{}',repeat('a',64),1) r`,[month])).then(r=>r.rows[0].r);
export const roster=(users,blockedId=null)=>users.map(u=>({userId:u.id,employeeName:u.name,part:null,position:null,isPayable:u.id!==blockedId,failureCodes:u.id===blockedId?['FIRST_MONTH_POLICY_REVIEW_REQUIRED']:[]}));
export async function evidence(db,id){
  const c=(await db.query('select id,revision from payroll_contract_versions where user_id=$1 order by revision desc limit 1',[id])).rows[0];
  const amount=4129032; // Aug 16-31 = 16/31, 8M monthly original.
  const e={policyVersion:'fixed-calendar-v1',hireDate:'2026-08-16',terminationDate:null,firstContractId:Number(c?.id??0),contractRevision:Number(c?.revision??1),contractSalary:8000000,fixedRaiseAmount:0,monthlyAmount:8000000,employedDays:16,totalDays:31,amount};
  return {contractSnapshot:[{id:Number(c?.id??0),revision:Number(c?.revision??1)}],employee:{userId:id,firstMonthProration:e,amounts:{employeeInsuranceDeductionAmount:0,employerInsuranceAmount:0,advanceAmount:0},tax:{employeePitDeductionAmount:0,companyPitAmount:0}},automaticItemsSnapshot:[{category:'base_work',direction:'addition',amount,sourceSnapshot:{appliedLevelRaiseAmount:0,firstMonthProration:e}}]};
}
export async function pay(db,id,targets,{snapshot,hash='fixture-hash',date=PAY_DATE,amount=4129032}={}){
  snapshot??=await evidence(db,id);
  return (await db.query(`select payroll_pay_employee_v3($1,$2,$3,$4,$5,$6,$6,null,$7,1,1,'monthly-payroll-v12','{}',0) r`,[MONTH,JSON.stringify(targets),id,JSON.stringify(snapshot),hash,amount,date])).rows[0].r;
}
export const cancel=(db,id)=>(db.query(`select payroll_cancel_employee_payment_v3(1,$1,'fixture cancellation',1) r`,[id])).then(r=>r.rows[0].r);
export async function state(db){
  return Object.fromEntries(await Promise.all(['payroll_payment_batches','payroll_employee_payments','payroll_payment_audit_logs','ledger_transactions','ledger_movements','ledger_audit_logs'].map(async table=>[table,(await db.query(`select * from ${table} order by id`)).rows])));
}
