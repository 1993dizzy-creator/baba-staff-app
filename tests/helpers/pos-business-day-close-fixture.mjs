import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { buildPosBusinessDaySource } from '../../lib/ledger/pos-sales-source.ts';

export const closeMigration = readFileSync('supabase/migrations/20260912101212_add_pos_business_day_closures.sql', 'utf8');
const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8');

export async function initializePosCloseDatabase(db) {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.users(id bigint primary key, username text unique, role text, is_active boolean, app_login_enabled boolean);
    insert into users values (1,'owner','owner',true,true),(2,'pos','master',true,true),(3,'manager','manager',true,true),(4,'inactive','owner',false,true);
    create table public.pos_sales_sync_runs(id bigint primary key,business_date date,status text);
    insert into pos_sales_sync_runs values (1,'2026-08-20','success'),(2,'2026-08-20','failed');
    create table public.pos_sales_receipts(id bigint primary key,ref_no text,business_date date,ref_date timestamptz,
      payment_status integer,is_canceled boolean,final_amount numeric,revision integer,updated_at timestamptz);
    create table public.pos_sales_receipt_payments(id bigint primary key,receipt_id bigint references pos_sales_receipts(id),
      business_date date,payment_type integer,payment_name text,card_name text,amount numeric);
  `);
  const foundation = read('202608210001_create_ledger_v1_foundation.sql');
  await db.exec(foundation.slice(0, foundation.indexOf('create or replace function')));
  await db.exec(read('202608210002_add_ledger_pos_sales_sync.sql'));
  await db.exec(read('202608210006_add_ledger_card_settlements.sql'));
  await db.exec(`create table ledger_month_closures(id bigint generated always as identity primary key,month date unique,status text default 'closed');
    create table ledger_candidates(id bigint generated always as identity primary key,candidate_type text,source_type text,source_key text,
      business_date date,proposed_amount numeric,proposed_recognition_month date,source_snapshot jsonb,source_fingerprint text,status text);
  `);
  const month = read('202608210008_add_ledger_month_close_corrections.sql');
  await db.exec(month.slice(month.indexOf('create or replace function public.ledger_month_is_closed_v1'), month.indexOf('create or replace function public.ledger_dated_write_month_guard_v1')));
  const drift = month.slice(month.indexOf('create or replace function public.ledger_record_source_drift_v1'), month.indexOf('create or replace function public.ledger_close_preflight_v1'));
  await db.exec(drift);
  const v2 = month.slice(month.indexOf('create or replace function public.ledger_sync_pos_sales_v2'), month.indexOf('create or replace function public.ledger_sync_recurring_expenses_v2'));
  await db.exec(v2);
  await db.exec('revoke all on function ledger_sync_pos_sales_v2(jsonb,bigint) from public,anon,authenticated; grant execute on function ledger_sync_pos_sales_v2(jsonb,bigint) to service_role;');
  await db.exec(closeMigration);
  await db.exec(`insert into pos_sales_receipts values
    (1,'A','2026-08-20','2026-08-20T18:00:00Z',3,false,100000,1,'2026-08-20T18:00:00.123Z'),
    (2,'Canceled','2026-08-20',null,3,true,900000,1,null),
    (3,'Unpaid','2026-08-20',null,2,false,800000,1,null);
    insert into pos_sales_receipt_payments values
    (1,1,'2026-08-20',1,'tiền mặt',null,40000),
    (2,1,'2026-08-20',1,'chuyển khoản',null,60000),
    (3,2,'2026-08-20',1,'tiền mặt',null,900000);
  `);
  return db;
}

export async function posCloseDatabase() {
  const db = new PGlite();
  try { return await initializePosCloseDatabase(db); } catch (error) { await db.close(); throw error; }
}

export async function daySource(db, date = '2026-08-20') {
  const { rows } = await db.query(`select
    coalesce((select jsonb_agg(to_jsonb(r)) from pos_sales_receipts r where business_date=$1::date),'[]'::jsonb) receipts,
    coalesce((select jsonb_agg(to_jsonb(p)) from pos_sales_receipt_payments p where business_date=$1::date),'[]'::jsonb) payments`, [date]);
  return buildPosBusinessDaySource(date, rows[0].receipts, rows[0].payments);
}

export async function closeDay(db, source, { actor = 1, method = 'manual', reclose = false, syncRunId = null } = {}) {
  const { rows } = await db.query('select sales_close_business_day_v1($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8) result',
    [source.businessDate, source.sourceFingerprint, JSON.stringify(source.sourceSnapshot), JSON.stringify(source.rows), actor, method, reclose, syncRunId]);
  return rows[0].result;
}

export async function syncDays(db, sources, actor = 1) {
  const { rows } = await db.query('select ledger_sync_pos_sales_v3($1::jsonb,$2::jsonb,$3) result',
    [JSON.stringify(sources.flatMap(source => source.rows)), JSON.stringify(sources.map(source => ({
      businessDate: source.businessDate, sourceFingerprint: source.sourceFingerprint, sourceSnapshot: source.sourceSnapshot,
    }))), actor]);
  return rows[0].result;
}

export async function ledgerState(db) {
  return (await db.query(`select
    (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from ledger_transactions t) transactions,
    (select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from ledger_movements m) movements,
    (select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from ledger_audit_logs a) audits,
    (select coalesce(jsonb_agg(to_jsonb(c) order by revision),'[]') from pos_sales_business_day_closures c) closures`)).rows[0];
}

// Seed actual reconciliation schema; gross allocations remain historical evidence.
export async function addCardSettlement(db, status = 'partial', date = '2026-08-20') {
  const result = await db.query(`with deposit as (
    insert into ledger_transactions(operation_id,type,occurred_at,business_date,amount,status,source_type,created_by,confirmed_by,source_fingerprint,source_synced_at)
    values(gen_random_uuid(),'card_settlement_deposit',now(),$1,10000,'confirmed','card_settlement_deposit',1,1,repeat('a',64),now()) returning id
  ), reconciliation as (
    insert into ledger_card_reconciliations(deposit_transaction_id,deposit_date,destination_fund_account_id,
      deposit_amount,matched_gross_amount,status,confirmed_at,confirmed_by)
    select id,$1,(select id from ledger_fund_accounts where type='bank' limit 1),10000,10000,$2,
      case when $2='matched' then now() end,case when $2='matched' then 1 end from deposit returning id
  ) insert into ledger_card_reconciliation_lines(reconciliation_id,pos_card_transaction_id,allocated_gross_amount)
    select r.id,t.id,10000 from reconciliation r cross join ledger_transactions t
    where t.source_type='pos_sales_daily_payment' and t.source_key='pos:'||$1::date::text||':card' returning id`, [date,status]);
  assertSettlementInserted(result);
}
function assertSettlementInserted(result) {
  if (result.rows.length !== 1) throw Error('Card fixture did not allocate exactly one POS card transaction');
}
