import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {buildLedgerEntries,entryDisplaySubtotal} from '../lib/ledger/entries.ts';
import {entryMatchesListFilter} from '../lib/ledger/entry-list-filter.ts';
import {analyzePayrollPaymentGroups} from '../lib/ledger/payroll-payment-groups.ts';
const read=name=>readFileSync('supabase/migrations/'+name,'utf8');
function definition(sql,name) {
 const match=new RegExp('create (?:or replace )?function public\\.'+name+'\\(', 'i').exec(sql);assert.ok(match,name);
 const rest=sql.slice(match.index),as=/\bas\s+(\$(?:function)?\$)/i.exec(rest);assert.ok(as,name);
 const end=rest.indexOf(as[1],as.index+as[0].length);assert.ok(end>0,name);return rest.slice(0,end+as[1].length+1);
}
async function database() {
 // Embedded in-memory PostgreSQL: no socket, environment URL or production credentials.
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table users(id bigint primary key,role text,is_active boolean,app_login_enabled boolean);
 insert into users values(1,'owner',true,true),(10,'staff',true,true),(20,'staff',true,true),(30,'staff',true,true),(40,'staff',true,true);
 create function payroll_assert_actor_v2(bigint) returns void language plpgsql as $$begin if $1<>1 then raise exception 'forbidden';end if;end$$;
 create table ledger_fund_accounts(id bigint primary key,code text,display_name text,is_active boolean);
 insert into ledger_fund_accounts values(1,'store_cash','QA cash',true),(2,'bank','QA bank',true);
 create table ledger_categories(id bigint primary key,name text,kind text,is_active boolean);
 create table ledger_month_closures(id bigserial primary key,month date,status text);
 create table ledger_transactions(id bigserial primary key,operation_id uuid,type text,occurred_at timestamptz,business_date date,recognition_month date,amount numeric,category_id bigint,party_id bigint,status text,source_type text,source_key text,source_snapshot jsonb,source_fingerprint text,source_synced_at timestamptz,correction_of_id bigint,memo text,created_by bigint,confirmed_by bigint,economic_effect_sign smallint default 1,updated_at timestamptz);
 create table ledger_movements(id bigserial primary key,transaction_id bigint,fund_account_id bigint,amount numeric);
 create table ledger_audit_logs(id bigserial primary key,actor_user_id bigint,action text,entity_type text,entity_id bigint,before_snapshot jsonb,after_snapshot jsonb,reason text);
 create schema extensions;
 create function extensions.digest(text,text) returns bytea language sql as $$select sha256(convert_to($1,'UTF8'))$$;
 create function ledger_record_source_drift_v1(bigint,text,numeric,jsonb,bigint) returns jsonb language sql as $$select '{"status":"created"}'::jsonb$$;`);
 let base=read('202608050001_add_employee_payment_batches.sql');
 await db.exec(base.slice(base.indexOf('create table'),base.indexOf('create function public.payroll_lock_paid_month_adjustments_v1')));
 await db.exec('alter table payroll_payment_batches add column employee_pit_total bigint default 0,add column company_pit_total bigint default 0,add column advance_total bigint default 0;alter table payroll_employee_payments add column fund_account_id bigint;');
 const tax=read('20260908115312_add_payroll_tax_versions.sql');
 for(const name of ['payroll_refresh_payment_tax_totals_v1','payroll_pay_employee_v2','payroll_cancel_employee_payment_v2'])await db.exec(definition(tax,name));
 const close=read('202608210008_add_ledger_month_close_corrections.sql');
 await db.exec(definition(close,'ledger_month_is_closed_v1'));
 await db.exec(definition(read('202608210005_add_ledger_meal_payroll_sync.sql'),'ledger_sync_payroll_company_cost_v1'));
 await db.exec(definition(close,'ledger_sync_payroll_company_cost_v2'));
 await db.exec(definition(read('20260916090759_auto_group_payroll_payments.sql'),'ledger_project_payroll_payment_group_v1'));
 await db.exec(definition(read('20260916091129_auto_sync_payroll_company_cost_on_completion.sql'),'ledger_sync_payroll_batch_company_cost_v1'));
 const safe=read('20260916094323_restore_safe_payroll_group_projection.sql');
 for(const name of ['payroll_pay_employee_v3','payroll_cancel_employee_payment_v3'])await db.exec(definition(safe,name));
 // Category name is read from the existing SQL, rather than duplicating localized text.
 const category=/where name='([^']+)' and kind='expense'/.exec(read('202608210005_add_ledger_meal_payroll_sync.sql'))[1];
 await db.query('insert into ledger_categories values(9,$1,\'expense\',true)',[category]);
 return db;
}
const targets=[10,20,30,40].map(userId=>({userId,employeeName:`QA ${userId}`,isPayable:true,failureCodes:[]}));
async function pay(db,user,amount=100,account=1,date='2026-10-10') {
 const snapshot={employee:{amounts:{employeeInsuranceDeductionAmount:10,employerInsuranceAmount:20},tax:{employeePitDeductionAmount:3,companyPitAmount:4}}};
 return (await db.query('select payroll_pay_employee_v3($1::date,$2::jsonb,$3,$4::jsonb,$5,$6,$6,null,$7::date,$8,1,$9,$10::jsonb,0) r',['2026-09-01',JSON.stringify(targets),user,JSON.stringify(snapshot),'qa-hash',amount,date,account,'qa-engine','{}'])).rows[0].r;
}
const cancel=async(db,user)=>(await db.query("select payroll_cancel_employee_payment_v3(1,$1,'QA cancellation',1) r",[user])).rows[0].r;
async function rows(db) {
 return (await db.query(`select t.*,t.business_date::text business_date,t.recognition_month::text recognition_month,coalesce((select jsonb_agg(jsonb_build_object('amount',m.amount,'fund_account',jsonb_build_object('id',a.id,'display_name',a.display_name))) from ledger_movements m join ledger_fund_accounts a on a.id=m.fund_account_id where m.transaction_id=t.id),'[]') movements from ledger_transactions t order by t.id`)).rows;
}
async function visible(db) {
 const raw=await rows(db),entries=buildLedgerEntries(raw,[],new Map(),[],'2026-10');
 assert.deepEqual(analyzePayrollPaymentGroups(raw).issues,[]);
 return entries.filter(e=>entryMatchesListFilter(e,'payroll')).reduce((n,e)=>n+entryDisplaySubtotal(e).expense,0);
}

test('real SQL approval/cancel/re-pay/completion paths feed the corrected list without cumulative duplicates',async()=>{
 const db=await database();try {
  assert.equal((await pay(db,10)).ledgerPaymentGroup.status,'created');assert.equal(await visible(db),100);
  assert.equal((await pay(db,20,200)).ledgerPaymentGroup.status,'rebooked');assert.equal(await visible(db),300);
  await assert.rejects(pay(db,20,200),/PAYROLL_EMPLOYEE_ALREADY_PAID/);assert.equal(await visible(db),300);
  await cancel(db,10);assert.equal(await visible(db),200);
  await cancel(db,20);assert.equal(await visible(db),0);
  await pay(db,10,150);assert.equal(await visible(db),150);
  await pay(db,20,250);assert.equal(await visible(db),400);
  await pay(db,30,300,2);assert.equal(await visible(db),700);
  const last=await pay(db,40,400,2,'2026-10-11');assert.equal(last.status,'completed');assert.equal(last.ledgerCompanyCost.status,'created');assert.equal(await visible(db),1100);
  await assert.rejects(pay(db,10),/PAYROLL_BATCH_COMPLETED/);await assert.rejects(cancel(db,10),/PAYROLL_BATCH_COMPLETED/);
  const raw=await rows(db),cost=raw.filter(r=>r.source_type==='payroll_completed_batch');assert.equal(cost.length,1);assert.equal(Number(cost[0].amount),1248);assert.equal(cost[0].movements.length,0);
  assert.equal(raw.flatMap(r=>r.movements).reduce((n,m)=>n+Number(m.amount),0),-1100);
  assert.equal(analyzePayrollPaymentGroups(raw).reversedOriginalIds.size,4);
 }finally{await db.close();}
});

test('real SQL projection error rolls back employee approval, ledger rows, movements and audit together',async()=>{
 const db=await database();try {
  await pay(db,10);const before=await rows(db);
  await db.exec("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");
  await assert.rejects(pay(db,20),/PAYROLL_LEDGER_PROJECTION_FAILED:month_closed/);
  assert.equal((await db.query('select payment_status from payroll_employee_payments where user_id=20')).rows[0].payment_status,'unpaid');
  assert.deepEqual(await rows(db),before);assert.equal(await visible(db),100);
  assert.equal(Number((await db.query("select count(*) n from payroll_payment_audit_logs where action='employee_paid'")).rows[0].n),1);
 }finally{await db.close();}
});

test('company-cost sync failure on final approval rolls back the final payment and new group',async()=>{
 const db=await database();try {
  await pay(db,10);await pay(db,20);await pay(db,30);const before=await rows(db);
  await db.exec('delete from ledger_categories'); // Isolated fixture fault injection only.
  await assert.rejects(pay(db,40),/PAYROLL_COMPANY_COST_SYNC_FAILED:category_missing/);
  assert.equal((await db.query('select status from payroll_payment_batches')).rows[0].status,'paying');
  assert.equal((await db.query('select payment_status from payroll_employee_payments where user_id=40')).rows[0].payment_status,'unpaid');
  assert.deepEqual(await rows(db),before);assert.equal(await visible(db),300);
 }finally{await db.close();}
});

test('cancel projection failure preserves the paid employee and all ledger history atomically',async()=>{
 const db=await database();try {
  await pay(db,10);const before=await rows(db);
  await db.exec("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");
  await assert.rejects(cancel(db,10),/PAYROLL_LEDGER_PROJECTION_FAILED:month_closed/);
  assert.equal((await db.query('select payment_status from payroll_employee_payments where user_id=10')).rows[0].payment_status,'paid');
  assert.deepEqual(await rows(db),before);assert.equal(await visible(db),100);
 }finally{await db.close();}
});
