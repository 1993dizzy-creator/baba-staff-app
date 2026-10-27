import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// R1 (store rent as a recurring expense): the deployed recurring-expense RPCs and the
// ledger month guard, installed from the migrations into an embedded Postgres. No
// production database is touched.
const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8').replace(/\r\n/g, '\n');
const slice = (text, start, end) => { const from = text.indexOf(start); assert.ok(from >= 0, start); const to = text.indexOf(end, from); assert.ok(to > from, end); return text.slice(from, to + end.length); };
const recurring = read('202608210007_add_recurring_reserves_bep.sql');
const monthClose = read('202608210008_add_ledger_month_close_corrections.sql');
const inactivePlans = read('20260916172211_ignore_inactive_recurring_expense_plans.sql');
const payrollClose = read('20261003090000_close_ledger_before_payroll_payment.sql');
const preflight = read('20261002062405_fix_preflight_inactive_recurring_plans.sql');
const planTable = slice(recurring, 'create table public.ledger_recurring_expense_plans(', '\n);');
const createPlan = slice(recurring, 'create or replace function public.ledger_create_recurring_plan_version_v1', 'end$$;');
const syncV1 = slice(inactivePlans, 'create or replace function public.ledger_sync_recurring_expenses_v1', '\n$$;');
const syncV2 = slice(inactivePlans, 'create or replace function public.ledger_sync_recurring_expenses_v2', 'end$$;');
const isClosed = slice(monthClose, 'create or replace function public.ledger_month_is_closed_v1', '$$;');
const assertOpen = slice(monthClose, 'create or replace function public.ledger_assert_month_open_v1', 'end$$;');
const guard = slice(read('20261001193526_auto_finalize_closed_month_card_fees.sql'), 'create or replace function public.ledger_transaction_month_guard_v1()', 'end$$;');
const payrollAllowed = slice(payrollClose, 'create or replace function public.ledger_payroll_finalization_allowed_v1', '\n$$;');
const guardPatch = slice(payrollClose, 'do $month_guard_payroll$', '$month_guard_payroll$;\n');
// The exact RECURRING_NOT_SYNCED condition from the deployed close preflight.
const notSyncedWhere = slice(preflight, 'from public.ledger_recurring_expense_plans p where ', ";if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','RECURRING_NOT_SYNCED'")
  .replace('from public.ledger_recurring_expense_plans p where ', '').replace(/;if v_count>0 then[\s\S]*$/, '');

// Body hashes (whitespace removed) of the production functions, read-only on 2026-10-27.
const PRODUCTION = {
  ledger_sync_recurring_expenses_v1: 'db59b065df228073b17a8326935123c3',
  ledger_sync_recurring_expenses_v2: '3937c4c7a51e5dc677da2224381bf605',
  ledger_create_recurring_plan_version_v1: '1969b4b7304d05f81724b493d7644a22',
  ledger_month_is_closed_v1: '11c3828113b2007ee287f9bad5c87952',
  ledger_assert_month_open_v1: '44e67a29101da6e45e496b1e8522272b',
  ledger_transaction_month_guard_v1: '87a391e430892c3039019a64b020160c',
};
const RENT = { name: '매장 임대료 (현 계약)', category: 3, amount: 50000000, day: 1, from: '2026-08-01', prefix: 'store-rent' };

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);
    create table ledger_categories(id bigint primary key, name text, kind text, is_active boolean);
    create table ledger_parties(id bigint primary key);
    create table ledger_month_closures(id bigserial primary key, month date unique, status text);
    create table ledger_audit_logs(id bigserial primary key, actor_user_id bigint, action text, entity_type text, entity_id bigint, before_snapshot jsonb, after_snapshot jsonb, reason text);
    create table payroll_payment_batches(id bigint primary key, payroll_month date, status text, actual_company_cost_total numeric, completed_at timestamptz);
    create table ledger_transactions(id bigserial primary key, operation_id uuid, type text, occurred_at timestamptz, business_date date, recognition_month date, amount numeric,
      category_id bigint, party_id bigint, status text, source_type text, source_key text, source_snapshot jsonb, source_fingerprint text, source_synced_at timestamptz,
      memo text, created_by bigint, confirmed_by bigint, economic_effect_sign smallint not null default 1, updated_at timestamptz);
    create unique index ledger_transactions_source_key_unique on ledger_transactions(source_type, source_key) where source_key is not null;
    create schema ledger_card_fee_private;
    create function ledger_card_fee_private.allowed_transaction(p public.ledger_transactions) returns boolean language sql as 'select false';
    create function ledger_card_fee_private.allowed_reversal(p public.ledger_transactions) returns boolean language sql as 'select false';
    create table drift_calls(transaction_id bigint);
    create function public.ledger_record_source_drift_v1(p_id bigint,text,numeric,jsonb,bigint) returns jsonb language sql as $$insert into drift_calls values (p_id); select '{"status":"created"}'::jsonb$$;
    insert into users values (1,'owner',true,true),(2,'staff',true,true);
    insert into ledger_categories values (3,'임대료','expense',true),(4,'기타 비용','expense',true);
    insert into ledger_month_closures(month,status) values ('2026-08-01','closed'),('2026-09-01','closed');`);
  await db.exec(planTable + ';');
  for (const sql of [isClosed, assertOpen, guard, payrollAllowed, guardPatch, createPlan, syncV1, syncV2]) await db.exec(sql);
  await db.exec('create trigger ledger_transactions_month_guard before insert or update or delete on public.ledger_transactions for each row execute function public.ledger_transaction_month_guard_v1();');
  return db;
}
const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const createRent = (db, actor = 1, plan = RENT) => one(db, 'select public.ledger_create_recurring_plan_version_v1($1,$2,$3,$4::smallint,$5::date,null,$6,$7,$8) r',
  [plan.name, plan.category, plan.amount, plan.day, plan.from, plan.prefix, '현 임대차 계약 월 임대료 50,000,000₫ · 선납금·준비금과 별개', actor]).then(row => row.r);
const sync = (db, month, version = 2) => one(db, `select public.ledger_sync_recurring_expenses_v${version}($1::date,1) r`, [month]).then(row => row.r);
const rentRows = async db => (await db.query("select source_key, recognition_month::text rm, business_date::text bd, amount::float8 amount, category_id::int category, status, type from ledger_transactions where source_type='recurring_expense' order by id")).rows;
const notSynced = async (db, month) => Number((await one(db, `select count(*) c from public.ledger_recurring_expense_plans p where ${notSyncedWhere.replaceAll('p_month', '$1::date')}`, [month])).c);
const setClosure = (db, month, status) => db.query('update ledger_month_closures set status=$2 where month=$1::date', [month, status]);

test('installed definitions are the deployed production functions (body hash match)', async () => {
  const db = await database();
  try {
    for (const [name, hash] of Object.entries(PRODUCTION)) {
      const row = await one(db, "select md5(regexp_replace(prosrc,'\\s+','','g')) h from pg_proc where proname=$1", [name]);
      assert.equal(row.h, hash, name);
    }
  } finally { await db.close(); }
});

test('R1: closed months are never synced; the month guard blocks a direct closed-month insert', async () => {
  const db = await database();
  try {
    assert.equal((await createRent(db)).status, 'created');
    for (const month of ['2026-08-01', '2026-09-01']) {
      assert.equal(await notSynced(db, month), 1, `${month} close is blocked until synced`);
      const result = await sync(db, month);
      assert.deepEqual([result.status, result.closedMonth, result.createdCount], ['ok', true, 0]);
      // v1 skips the closed-month check; the transaction trigger still rejects it.
      await assert.rejects(sync(db, month, 1), /LEDGER_MONTH_CLOSED/);
    }
    assert.deepEqual(await rentRows(db), []);
    assert.equal(Number((await one(db, 'select count(*) c from ledger_audit_logs where action=$1', ['recurring_expense_created'])).c), 0);
  } finally { await db.close(); }
});

test('R1: reopened 9월 → 8월, then 8·9·10월 each recognize 50M exactly once, reruns change nothing', async () => {
  const db = await database();
  try {
    assert.equal((await createRent(db)).status, 'created');
    // Reopen order of the plan: 9월 first, then 8월 (the RPC enforces it in production).
    await setClosure(db, '2026-09-01', 'reopened');
    await setClosure(db, '2026-08-01', 'reopened');
    for (const month of ['2026-08-01', '2026-09-01', '2026-10-01']) {
      const first = await sync(db, month);
      assert.deepEqual([first.status, first.createdCount, first.totalRecognizedExpense], ['ok', 1, 50000000], month);
      for (let rerun = 0; rerun < 2; rerun++) {
        const again = await sync(db, month);
        assert.deepEqual([again.createdCount, again.updatedCount, again.unchangedCount], [0, 0, 1], `${month} rerun`);
      }
      assert.equal(await notSynced(db, month), 0, `${month} RECURRING_NOT_SYNCED cleared`);
    }
    assert.deepEqual(await rentRows(db), ['2026-08', '2026-09', '2026-10'].map(month => ({
      source_key: `recurring:1:${month}`, rm: `${month}-01`, bd: `${month}-01`, amount: 50000000, category: 3, status: 'confirmed', type: 'expense_recognition',
    })));
    assert.equal(Number((await one(db, 'select count(*) c from ledger_audit_logs where action=$1', ['recurring_expense_created'])).c), 3);
    // The database itself refuses a second row for the same month.
    await assert.rejects(db.query("insert into ledger_transactions(type,business_date,recognition_month,amount,status,source_type,source_key) values ('expense_recognition','2026-10-01','2026-10-01',50000000,'confirmed','recurring_expense','recurring:1:2026-10')"), /duplicate key|unique/);

    // After 8월 is reclosed, a closed-month sync creates nothing and reports no drift.
    await setClosure(db, '2026-08-01', 'closed');
    const closed = await sync(db, '2026-08-01');
    assert.deepEqual([closed.closedMonth, closed.createdCount, closed.driftCount], [true, 0, 0]);
    assert.equal(Number((await one(db, 'select count(*) c from drift_calls')).c), 0);
    assert.equal((await rentRows(db)).length, 3);
    // No fund movement is part of a recurring recognition: the prepaid 600M and reserves are separate.
    assert.ok(!syncV1.includes('ledger_movements') && !syncV1.includes('ledger_reserve'));
  } finally { await db.close(); }
});

test('R1: plan creation is owner/master only and cannot duplicate the same plan version', async () => {
  const db = await database();
  try {
    assert.equal((await createRent(db, 2)).status, 'forbidden');
    assert.equal((await createRent(db)).status, 'created');
    assert.equal((await createRent(db)).status, 'invalid_effective_from');
    assert.equal((await createRent(db, 1, { ...RENT, category: 999 })).status, 'invalid_input');
    assert.equal(Number((await one(db, 'select count(*) c from ledger_recurring_expense_plans')).c), 1);
  } finally { await db.close(); }
});
