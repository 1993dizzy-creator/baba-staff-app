import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Real definitions from the deployed migrations, installed into an embedded Postgres.
const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8').replace(/\r\n/g, '\n');
const slice = (text, start, end) => { const from = text.indexOf(start); assert.ok(from >= 0, start); const to = text.indexOf(end, from); assert.ok(to > from, end); return text.slice(from, to + end.length); };
const monthClose = read('202608210008_add_ledger_month_close_corrections.sql');
const isClosed = slice(monthClose, 'create or replace function public.ledger_month_is_closed_v1', '$$;');
const assertOpen = slice(monthClose, 'create or replace function public.ledger_assert_month_open_v1', 'end$$;');
const syncV2 = slice(monthClose, 'create or replace function public.ledger_sync_payroll_company_cost_v2', 'end$$;');
const syncV1 = slice(read('202608210005_add_ledger_meal_payroll_sync.sql'), 'create or replace function public.ledger_sync_payroll_company_cost_v1', '\nend $$;');
const guard = slice(read('20261001193526_auto_finalize_closed_month_card_fees.sql'), 'create or replace function public.ledger_transaction_month_guard_v1()', 'end$$;');
const productionPreflight = readFileSync('supabase/migrations/20261002062405_fix_preflight_inactive_recurring_plans.sql', 'utf8');
const migration = read('20261003090000_close_ledger_before_payroll_payment.sql');

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table users(id bigint primary key, role text, is_active boolean, app_login_enabled boolean);
    create table ledger_categories(id bigint primary key, name text, kind text, is_active boolean);
    create table ledger_month_closures(id bigserial primary key, month date unique, status text);
    create table ledger_audit_logs(id bigserial primary key, actor_user_id bigint, action text, entity_type text, entity_id bigint, before_snapshot jsonb, after_snapshot jsonb, reason text);
    create table payroll_payment_batches(id bigint primary key, payroll_month date, status text, actual_company_cost_total numeric, completed_at timestamptz);
    create table ledger_transactions(id bigserial primary key, operation_id uuid, type text, occurred_at timestamptz, business_date date, recognition_month date, amount numeric,
      category_id bigint, party_id bigint, status text, source_type text, source_key text, source_snapshot jsonb, source_fingerprint text, source_synced_at timestamptz,
      memo text, created_by bigint, confirmed_by bigint, economic_effect_sign smallint not null default 1, updated_at timestamptz);
    create schema ledger_card_fee_private;
    create function ledger_card_fee_private.allowed_transaction(p public.ledger_transactions) returns boolean language sql as 'select false';
    create function ledger_card_fee_private.allowed_reversal(p public.ledger_transactions) returns boolean language sql as 'select false';
    create function public.ledger_record_source_drift_v1(bigint,text,numeric,jsonb,bigint) returns jsonb language sql as $$select '{"status":"created"}'::jsonb$$;
    insert into users values (1,'owner',true,true);
    insert into ledger_categories values (9,'급여/인건비','expense',true);`);
  await db.exec(isClosed); await db.exec(assertOpen); await db.exec(guard);
  await db.exec('create trigger ledger_transactions_month_guard before insert or update or delete on public.ledger_transactions for each row execute function public.ledger_transaction_month_guard_v1();');
  await db.exec(syncV1); await db.exec(syncV2);
  await db.exec(productionPreflight);
  await db.exec(migration);
  return db;
}
const row = (batch, month, amount, { completed = true, completedAt = '2026-10-10T05:00:00Z' } = {}) => ({
  batchId: batch, payrollMonth: `${month}-01`, amount, completed,
  snapshot: { batch_id: batch, payroll_month: `${month}-01`, actual_company_cost_total: amount, completed_at: completedAt },
  fingerprint: `${String(batch).padStart(8, '0')}${'a'.repeat(56)}`,
});
const sync = async (db, payload) => (await db.query('select public.ledger_sync_payroll_company_cost_v2($1::jsonb,1) r', [JSON.stringify(payload)])).rows[0].r;
const payrollRows = async db => (await db.query("select recognition_month::text, business_date::text, amount::numeric::float8 amount, status from ledger_transactions where source_type='payroll_completed_batch' order by id")).rows;

test('PAYROLL_NOT_COMPLETED is removed in place; every other preflight contract is untouched', async () => {
  const db = await database();
  try {
    const after = (await db.query("select pg_get_functiondef('public.ledger_close_preflight_v1(date,bigint)'::regprocedure) d")).rows[0].d;
    assert.doesNotMatch(after, /PAYROLL_NOT_COMPLETED|payroll_payment_batches/);
    for (const code of ['CURRENT_MONTH', 'FUTURE_MONTH', 'ALREADY_CLOSED', 'PENDING_CANDIDATES', 'RECURRING_NOT_SYNCED', 'CANDIDATE_LINK_BROKEN', 'TRANSFER_UNBALANCED', 'REQUIRED_MOVEMENT_MISSING',
      'PAYABLE_OVERALLOCATED', 'CARD_OVERALLOCATED', 'DUPLICATE_ACTIVE_SOURCE', 'CARD_UNMATCHED', 'CARD_FEE_PENDING', 'PAYMENT_VERIFICATION_UNRESOLVED', 'CARD_CLEARING_NEGATIVE', 'CARD_ALLOCATION_MISMATCH', 'CONFIRMED_SOURCE_DRIFT']) {
      assert.ok(after.includes(`'${code}'`), code);
    }
    assert.match(after, /p\.is_active=true and p\.effective_from<=p_month/);
    // Only the one payroll statement differs from the deployed body.
    const before = productionPreflight.replace(/\r\n/g, '\n');
    const body = raw => { const text = raw.replace(/\r\n/g, '\n'); return text.slice(text.indexOf('declare v_role'), text.lastIndexOf('end')); };
    const removed = " if exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status<>'completed')or((select min(payroll_month)from public.payroll_payment_batches)<=p_month and not exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status='completed')) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PAYROLL_NOT_COMPLETED'));end if;";
    assert.equal(body(after), body(before).replace(removed, ''));
    // Re-running the migration is a no-op.
    await db.exec(migration);
    assert.equal((await db.query("select pg_get_functiondef('public.ledger_close_preflight_v1(date,bigint)'::regprocedure) d")).rows[0].d, after);
  } finally { await db.close(); }
});

test('close-first: September closed, payroll completed 10/10 → finalized cost booked to September once', async () => {
  const db = await database();
  try {
    await db.exec("insert into ledger_month_closures(month,status) values('2026-09-01','closed')");
    await db.exec("insert into payroll_payment_batches values (12,'2026-09-01','completed',167320000,'2026-10-10T05:00:00Z')");
    const result = await sync(db, row(12, '2026-09', 167320000));
    assert.equal(result.status, 'created');
    assert.equal(result.finalizedAfterClose, true);
    assert.deepEqual(await payrollRows(db), [{ recognition_month: '2026-09-01', business_date: '2026-10-10', amount: 167320000, status: 'confirmed' }]);
    // The flag is cleared after the sync.
    assert.equal((await db.query("select current_setting('ledger.payroll_finalization_batch', true) v")).rows[0].v, '');
    // Re-sync: unchanged, never a second row.
    assert.equal((await sync(db, row(12, '2026-09', 167320000))).status, 'unchanged');
    assert.equal((await payrollRows(db)).length, 1);
  } finally { await db.close(); }
});

test('closed months stay locked for everything else', async () => {
  const db = await database();
  try {
    await db.exec("insert into ledger_month_closures(month,status) values('2026-09-01','closed')");
    await db.exec("insert into payroll_payment_batches values (12,'2026-09-01','completed',167320000,'2026-10-10T05:00:00Z'), (13,'2026-09-01','paying',0,null)");
    const insertPayroll = (key, amount) => db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,created_by,confirmed_by)
      values(gen_random_uuid(),'expense_recognition','2026-10-10','2026-10-10','2026-09-01',$2,9,'confirmed','payroll_completed_batch',$1,'{}','x',1,1)`, [key, amount]);
    // Without the sync's transaction flag the recognition is rejected.
    await assert.rejects(insertPayroll('payroll-batch:12:company-cost', 167320000), /LEDGER_MONTH_CLOSED/);
    // A wrong amount is rejected even with the flag.
    await assert.rejects(db.transaction(async tx => { await tx.query("select set_config('ledger.payroll_finalization_batch','12',true)"); await tx.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,created_by,confirmed_by)
      values(gen_random_uuid(),'expense_recognition','2026-10-10','2026-10-10','2026-09-01',100,9,'confirmed','payroll_completed_batch','payroll-batch:12:company-cost','{}','x',1,1)`); }), /LEDGER_MONTH_CLOSED/);
    // An ordinary closed-month expense is still rejected.
    await assert.rejects(db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,created_by,confirmed_by)
      values(gen_random_uuid(),'expense','2026-09-20','2026-09-20','2026-09-01',5000,9,'confirmed','manual',1,1)`), /LEDGER_MONTH_CLOSED/);
    // A batch still paying books nothing (the month keeps its predicted cost).
    assert.equal((await sync(db, row(13, '2026-09', 0, { completed: false }))).status, 'unchanged');
    assert.equal((await payrollRows(db)).length, 0);
  } finally { await db.close(); }
});

test('open month keeps the existing v1 path (August payroll_completed_batch regression)', async () => {
  const db = await database();
  try {
    await db.exec("insert into payroll_payment_batches values (8,'2026-08-01','completed',150000000,'2026-09-10T05:00:00Z')");
    const result = await sync(db, row(8, '2026-08', 150000000, { completedAt: '2026-09-10T05:00:00Z' }));
    assert.equal(result.status, 'created');
    assert.equal(result.finalizedAfterClose, undefined);
    assert.deepEqual(await payrollRows(db), [{ recognition_month: '2026-08-01', business_date: '2026-09-10', amount: 150000000, status: 'confirmed' }]);
  } finally { await db.close(); }
});

test('business_date is the Vietnam calendar date of completion; recognition_month stays the payroll month', async () => {
  // 00:01 and 02:59 ICT are still the previous day in UTC; 07:01 ICT is the same day in both.
  const cases = [
    ['2026-10-01T00:01:00+07:00', '2026-09-30'],
    ['2026-10-01T02:59:00+07:00', '2026-09-30'],
    ['2026-10-01T07:01:00+07:00', '2026-10-01'],
  ];
  for (const sessionZone of ['UTC', 'America/Los_Angeles']) {
    for (const [completedAt, utcDate] of cases) {
      const db = await database();
      try {
        await db.exec(`set timezone to '${sessionZone}'`);
        // September is closed before its payroll completes (close-first).
        await db.exec("insert into ledger_month_closures(month,status) values('2026-09-01','closed')");
        await db.query("insert into payroll_payment_batches values (12,'2026-09-01','completed',167320000,$1)", [completedAt]);
        assert.equal((await db.query("select (completed_at at time zone 'UTC')::date::text d from payroll_payment_batches where id=12")).rows[0].d, utcDate);
        const result = await sync(db, row(12, '2026-09', 167320000, { completedAt }));
        assert.equal(result.status, 'created', `${sessionZone} ${completedAt}`);
        assert.equal(result.finalizedAfterClose, true);
        assert.deepEqual(await payrollRows(db), [{ recognition_month: '2026-09-01', business_date: '2026-10-01', amount: 167320000, status: 'confirmed' }]);
      } finally { await db.close(); }
    }
  }
});

test('example: 2026-09 payroll completed 2026-10-10 01:00 ICT → recognition 2026-09-01, business_date 2026-10-10', async () => {
  const db = await database();
  try {
    await db.exec("insert into ledger_month_closures(month,status) values('2026-09-01','closed')");
    await db.exec("insert into payroll_payment_batches values (12,'2026-09-01','completed',167320000,'2026-10-10T01:00:00+07:00')");
    assert.equal((await sync(db, row(12, '2026-09', 167320000, { completedAt: '2026-10-10T01:00:00+07:00' }))).status, 'created');
    assert.deepEqual(await payrollRows(db), [{ recognition_month: '2026-09-01', business_date: '2026-10-10', amount: 167320000, status: 'confirmed' }]);
  } finally { await db.close(); }
});

test('open months use the same Vietnam-local business_date (v1 path)', async () => {
  const db = await database();
  try {
    await db.exec("insert into payroll_payment_batches values (8,'2026-08-01','completed',150000000,'2026-09-01T00:30:00+07:00')");
    assert.equal((await sync(db, row(8, '2026-08', 150000000, { completedAt: '2026-09-01T00:30:00+07:00' }))).status, 'created');
    assert.deepEqual(await payrollRows(db), [{ recognition_month: '2026-08-01', business_date: '2026-09-01', amount: 150000000, status: 'confirmed' }]);
  } finally { await db.close(); }
});

test('closed-month exception requires the Vietnam-local completion date', async () => {
  const db = await database();
  try {
    await db.exec("insert into ledger_month_closures(month,status) values('2026-09-01','closed')");
    await db.exec("insert into payroll_payment_batches values (12,'2026-09-01','completed',167320000,'2026-10-01T00:01:00+07:00')");
    const insertWithFlag = businessDate => db.transaction(async tx => {
      await tx.query("select set_config('ledger.payroll_finalization_batch','12',true)");
      await tx.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,created_by,confirmed_by)
        values(gen_random_uuid(),'expense_recognition','2026-10-01T00:01:00+07:00',$1,'2026-09-01',167320000,9,'confirmed','payroll_completed_batch','payroll-batch:12:company-cost','{}','x',1,1)`, [businessDate]);
    });
    // The UTC date (09-30) and any other date are rejected; only 10-01 matches.
    await assert.rejects(insertWithFlag('2026-09-30'), /LEDGER_MONTH_CLOSED/);
    await assert.rejects(insertWithFlag('2026-10-02'), /LEDGER_MONTH_CLOSED/);
    await insertWithFlag('2026-10-01');
    assert.equal((await payrollRows(db)).length, 1);
  } finally { await db.close(); }
});

test('v1 changes only the business_date expression, idempotently', async () => {
  const db = await database();
  try {
    const def = async () => (await db.query("select pg_get_functiondef('public.ledger_sync_payroll_company_cost_v1(jsonb,bigint)'::regprocedure) d")).rows[0].d.replace(/\r\n/g, '\n');
    const after = await def();
    const body = text => text.slice(text.indexOf('declare v_role'), text.lastIndexOf('end'));
    const utc = "coalesce((v_snapshot->>'completed_at')::timestamptz::date,";
    const local = "coalesce(((v_snapshot->>'completed_at')::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date,";
    assert.equal(body(after), body(syncV1).replace(utc, local));
    // occurred_at keeps the exact completion instant.
    assert.ok(after.includes("coalesce((v_snapshot->>'completed_at')::timestamptz,(v_month+interval '1 month')::timestamptz)"));
    await db.exec(migration);
    assert.equal(await def(), after);
  } finally { await db.close(); }
});
