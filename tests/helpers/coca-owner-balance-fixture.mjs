// Real migrations, isolated in-memory PostgreSQL only. No credentials/network.


import { readFileSync } from 'node:fs';
import { database } from './inventory-ledger-fixture.mjs';
const read=n=>readFileSync(`supabase/migrations/${n}`,'utf8');
const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const register=(db,actor=2)=>one(db,"select ledger_register_coca_owner_balance_anchor_v1('Owner instruction 2026-11-19; supplier statement unavailable','Owner basis; source unresolved; no payment correction', $1) as r",[actor]).then(x=>x.r);
const paid=[[389,811,533952,'2026-08-31'],[390,812,576000,'2026-08-31'],[506,1025,700000,'2026-09-13'],[507,1026,711936,'2026-09-13'],[508,1027,732000,'2026-09-13'],[509,1028,768000,'2026-09-13'],[594,1399,700000,'2026-09-19'],[1088,2347,750000,'2026-10-08'],[1101,2362,744000,'2026-10-08']];
const open=[[1526,3131,533952,'2026-10-24'],[1527,3132,576000,'2026-10-24'],[1528,3133,750000,'2026-10-24'],[2122,4907,558000,'2026-11-14'],[2123,4908,750000,'2026-11-14'],[2213,5024,768000,'2026-11-17'],[2214,5025,712000,'2026-11-17']];

async function receipt(db,id,tx,amount,date,party=5){
 await db.query(`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,source_type,source_fingerprint,source_synced_at,created_by,confirmed_by)
 values($1,gen_random_uuid(),'expense',$2::date+time '12:00',$2,date_trunc('month',$2::date)::date,$3,4,$4,'inventory_purchase_candidate',md5('fixture-receipt:'||$1::bigint::text),now(),2,2)`,[tx,date,amount,party]);
 await db.query("insert into ledger_payables(id,expense_transaction_id,party_id,original_amount) values($1,$2,$3,$4)",[id,tx,party,amount]);
}
async function setup(){
 const db=await database();
 // Reproduce the exact Production CHECK from its original migration, including manual rows.
 const sourceContract=read('202608210002_add_ledger_pos_sales_sync.sql').match(/add constraint ledger_transaction_source_sync_metadata check \([\s\S]*?\n  \);/);
 if(!sourceContract)throw new Error('Production source metadata CHECK not found');
 await db.exec('alter table public.ledger_transactions '+sourceContract[0]);
 await db.exec(read('202608210004_add_ledger_payable_payments.sql'));
 await db.exec(read('20261018105936_add_payable_payment_idempotency_v2.sql'));
 const guards=read('202608210008_add_ledger_month_close_corrections.sql');
 await db.exec(guards.slice(guards.indexOf('create or replace function public.ledger_payable_allocation_month_guard_v1'),guards.indexOf('create or replace function public.ledger_card_reconciliation_month_guard_v1')));
 await db.exec(read('20261106120000_add_supplier_prepayments.sql'));
 // Prerequisite schema for the ACTUAL current preflight (empty unrelated modules).
 await db.exec(`create table payroll_payment_batches(payroll_month date,status text);
 create table ledger_recurring_expense_plans(id bigint,is_active boolean,effective_from date,effective_to date);
 create table ledger_card_reconciliations(id bigint,status text,deposit_date date,deposit_amount numeric,matched_gross_amount numeric,difference_amount numeric,updated_at timestamptz);
 create table ledger_card_reconciliation_lines(reconciliation_id bigint,pos_card_transaction_id bigint,allocated_gross_amount numeric);
 create table ledger_card_fee_closures(id bigint,status text,fee_month date,fee_amount numeric,updated_at timestamptz);
 create table ledger_card_fee_allocation_lines(closure_id bigint,pos_card_transaction_id bigint,allocated_fee_amount numeric);
 create table ledger_reserve_plans(id bigint,is_active boolean,target_amount numeric);
 create table ledger_reserve_entries(reserve_plan_id bigint,entry_type text,amount numeric,occurred_at timestamptz);
 create function ledger_card_sale_consumed_v1(bigint) returns numeric language sql as $$select 0::numeric$$;
 insert into ledger_parties(id,name,type) values(5,'Coca-Cola','supplier');`);
 await db.exec(read('20261002062405_fix_preflight_inactive_recurring_plans.sql'));
 for(const [id,tx,amount,date] of paid)await receipt(db,id,tx,amount,date);
 for(const [id,tx,amount,date] of open)await receipt(db,id,tx,amount,date);
 for(const [id,tx,amount] of [[94,167,549000],[95,168,355968],[288,481,700000]])await receipt(db,id,tx,amount,'2026-08-08');
 await receipt(db,9000,9000,96685900,'2026-11-10',10);
 await db.exec(`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,amount,party_id,created_by,confirmed_by,memo)
 values(5097,'fdee4d5d-e62f-4008-8517-00f725a87497','payable_payment','2026-11-17T22:52:00+07','2026-11-17',6215888,5,2,2,'tt 6.582.000'),
 (1493,gen_random_uuid(),'payable_payment','2026-08-24T12:00:00+07','2026-08-24',4150000,5,2,2,'legacy carryover');
 insert into ledger_movements(id,transaction_id,fund_account_id,amount) values(2854,5097,2,-6215888),(100,1493,1,-4150000);`);
 for(let i=0;i<paid.length;i++)await db.query('insert into ledger_payable_allocations(id,payable_id,payment_transaction_id,allocated_amount) values($1,$2,5097,$3)',[2191+i,paid[i][0],paid[i][2]]);
 for(const [id,amount] of [[94,549000],[95,355968],[288,700000]])await db.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values($1,1493,$2)',[id,amount]);
 await db.exec(`insert into ledger_audit_logs(id,actor_user_id,action,entity_type,entity_id,reason) values(9061,2,'payable_payment_created','transaction',5097,'tt 6.582.000');
 insert into ledger_month_closures(month,status) values('2026-08-01','closed'),('2026-09-01','closed'),('2026-10-01','closed');`);
 return db;
}
async function state(db){
 const result={};
 for(const table of ['ledger_transactions','ledger_movements','ledger_payables','ledger_payable_allocations','inventory','inventory_logs','ledger_month_closures','ledger_payable_payment_requests'])result[table]=(await db.query(`select * from ${table} order by 1`)).rows;
 return result;
}
async function inputs(db){
 const sources=(await db.query(`select to_jsonb(p)||jsonb_build_object('expense',to_jsonb(t)) as r from ledger_payables p join ledger_transactions t on t.id=p.expense_transaction_id order by p.id`)).rows.map(x=>x.r);
 const allocations=(await db.query(`select to_jsonb(a)||jsonb_build_object('payment',to_jsonb(t)) as r from ledger_payable_allocations a join ledger_transactions t on t.id=a.payment_transaction_id order by a.id`)).rows.map(x=>x.r);
 const anchors=(await db.query('select to_jsonb(a) as r from ledger_payable_balance_anchors a')).rows.map(x=>x.r);
 return {sources,allocations,anchors};
}
const warning=async(db,month)=>((await one(db,'select ledger_close_preflight_v1($1,2) as r',[month])).r.warnings.find(x=>x.code==='PAYABLE_OUTSTANDING')?.amount??0);


export {setup as createCocaAnchorFixture,state as protectedState,inputs as anchorInputs,receipt,register,warning};
