import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidence } from '../../scripts/ledger/aug-sep-reclose-calculate.mjs';

// Local fixture only. Uses the original migration text and deployed dependency
// bodies; the close preflight is a stub, never a production DB connection.
const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8').replaceAll('\r\n','\n');
const take = (name,start,end='end$$;') => {
  const sql=read(name), from=sql.indexOf(start), to=sql.indexOf(end,from);
  assert.ok(from>=0 && to>from,start); return sql.slice(from,to+end.length);
};
const correction=read('20261027112354_aug_sep_reclose_corrections.sql');
const recurring='202608210007_add_recurring_reserves_bep.sql';
const inactive='20260916172211_ignore_inactive_recurring_expense_plans.sql';
const closeMigration='202608210008_add_ledger_month_close_corrections.sql';
const reopenMigration='20260916161512_add_ledger_month_reopen.sql';
const protectedTables=['ledger_movements','ledger_payables','ledger_payable_allocations','ledger_reserve_plans','ledger_reserve_entries','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines'];
export async function preserved(db) {
  const result={};
  for (const table of protectedTables) result[table]=(await db.query(`select * from ${table} order by id`)).rows;
  result.originals=(await db.query('select * from ledger_transactions where id in(1055,1304,2191,2192,2384,2752) order by id')).rows;
  return result;
}
export async function nativeRecloseFixture(Database) {
  const db=new Database();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table users(id bigint primary key,role text,is_active boolean,app_login_enabled boolean);
      insert into users values(1,'owner',true,true),(2,'staff',true,true),(3,'master',true,true),(4,'owner',false,true);
      create table ledger_categories(id bigint primary key,name text,kind text,is_active boolean);
      insert into ledger_categories values(3,'임대료','expense',true),(4,'기타 비용','expense',true),(75,'보험','expense',true);
      create table ledger_parties(id bigint primary key);
      create table ledger_fund_accounts(id bigint primary key,code text);
      insert into ledger_fund_accounts values(2,'baba_corporate_bank'),(4,'card_clearing');
      create table ledger_transactions(id bigserial primary key,operation_id uuid,type text,occurred_at timestamptz,
        business_date date,recognition_month date,amount numeric,category_id bigint,party_id bigint,status text,
        source_type text,source_key text,source_snapshot jsonb,source_fingerprint text,source_synced_at timestamptz,
        correction_of_id bigint references ledger_transactions(id),memo text,created_by bigint,confirmed_by bigint,
        economic_effect_sign smallint not null default 1,updated_at timestamptz,
        check((source_type='manual' and source_fingerprint is null and source_synced_at is null)
          or (source_type<>'manual' and source_fingerprint is not null and source_synced_at is not null)),
        check(status<>'confirmed' or confirmed_by is not null),check(economic_effect_sign in(-1,1)),
        check(amount>0),check(type not in('expense','expense_recognition') or (recognition_month is not null and category_id is not null)));
      create unique index ledger_transactions_source_key_unique on ledger_transactions(source_type,source_key) where source_key is not null;
      create table ledger_movements(id bigserial primary key,transaction_id bigint, fund_account_id bigint,amount numeric);
      create table ledger_audit_logs(id bigserial primary key,actor_user_id bigint,action text,entity_type text,entity_id bigint,before_snapshot jsonb,after_snapshot jsonb,reason text);
      create table payroll_payment_batches(id bigint primary key,payroll_month date,status text,actual_company_cost_total numeric,
        employee_insurance_total numeric,employer_insurance_total numeric,director_insurance_amount numeric,insurance_remittance_total numeric,completed_at timestamptz);
      create table ledger_month_closures(id bigserial primary key,month date unique,status text default 'closed',revision integer default 3,
        closed_at timestamptz default now(),closed_by bigint default 1,preflight_snapshot jsonb default '{}',summary_snapshot jsonb default '{}',
        snapshot_hash text default repeat('b',64),warning_snapshot jsonb default '[]',reopened_at timestamptz,reopened_by bigint,reopen_reason text);
      create table ledger_month_closure_history(id bigserial primary key,closure_id bigint,month date,revision integer,closed_at timestamptz,closed_by bigint,
        preflight_snapshot jsonb,summary_snapshot jsonb,snapshot_hash text,warning_snapshot jsonb,archived_reason text,archived_by bigint,unique(closure_id,revision));
      create schema ledger_card_fee_private;
      create function ledger_card_fee_private.allowed_transaction(p ledger_transactions) returns boolean language sql as 'select false';
      create function ledger_card_fee_private.allowed_reversal(p ledger_transactions) returns boolean language sql as 'select false';
      create function ledger_record_source_drift_v1(bigint,text,numeric,jsonb,bigint) returns jsonb language sql as $$select '{"status":"created"}'::jsonb$$;
      -- Only the preflight dependency is a local stub; close/reopen bodies are real.
      create function ledger_close_preflight_v1(date,bigint) returns jsonb language sql as $$select '{"status":"ok","canClose":true,"preflightHash":"fresh","warnings":[]}'::jsonb$$;
    `);
    for(const table of protectedTables.slice(1)) await db.exec(`create table ${table}(id bigint primary key,snapshot jsonb); insert into ${table} values(1,'{"protected":true}');`);
    await db.exec(take(recurring,'create table public.ledger_recurring_expense_plans(','\n);'));
    for(const t of evidence.originals) await db.query(`insert into ledger_transactions(id,type,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,economic_effect_sign,source_fingerprint,source_synced_at,confirmed_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1)`,[t.id,t.type,t.business_date,t.recognition_month,t.amount,t.category_id,t.status,t.source_type,t.source_key,t.source_snapshot,t.economic_effect_sign,t.source_type==='manual'?null:'fixture',t.source_type==='manual'?null:'2026-10-27']);
    await db.exec("select setval('ledger_transactions_id_seq',30000);");
    for(const m of evidence.movements) await db.query('insert into ledger_movements(id,transaction_id,fund_account_id,amount) values($1,$2,$3,$4)',[m.id,m.transaction_id,m.fund_account_id,m.amount]);
    const p=evidence.payroll;
    await db.query('insert into payroll_payment_batches values($1,$2,$3,$4,$5,$6,$7,$8,now())',[p.id,p.payroll_month,p.status,p.actual_company_cost_total,p.employee_insurance_total,p.employer_insurance_total,p.director_insurance_amount,p.insurance_remittance_total]);
    await db.exec("insert into ledger_month_closures(month) values('2026-08-01'),('2026-09-01');");
    for(const sql of [
      take(closeMigration,'create or replace function public.ledger_month_is_closed_v1','$$;'),
      take(closeMigration,'create or replace function public.ledger_assert_month_open_v1'),
      take('20261001193526_auto_finalize_closed_month_card_fees.sql','create or replace function public.ledger_transaction_month_guard_v1()'),
      take('20261003090000_close_ledger_before_payroll_payment.sql','create or replace function public.ledger_payroll_finalization_allowed_v1','\n$$;'),
      take('20261003090000_close_ledger_before_payroll_payment.sql','do $month_guard_payroll$','$month_guard_payroll$;\n'),
      take(recurring,'create or replace function public.ledger_create_recurring_plan_version_v1'),
      take(inactive,'create or replace function public.ledger_sync_recurring_expenses_v1','\n$$;'),
      take(inactive,'create or replace function public.ledger_sync_recurring_expenses_v2'),
      take(reopenMigration,'create or replace function public.ledger_reopen_month_v1('),
      take(reopenMigration,'create or replace function public.ledger_close_month_v1('),correction,
      read('20261027160650_fix_aug_sep_reclose_lock_order.sql'),
    ]) await db.exec(sql);
    await db.exec('create trigger ledger_transactions_month_guard before insert or update or delete on ledger_transactions for each row execute function ledger_transaction_month_guard_v1();');
    await db.exec("select ledger_create_recurring_plan_version_v1('매장 임대료 (현 계약)',3,50000000,1::smallint,'2026-08-01',null,'store-rent','Local R1',1);");
    return db;
  } catch(error) { await db.close(); throw error; }
}
