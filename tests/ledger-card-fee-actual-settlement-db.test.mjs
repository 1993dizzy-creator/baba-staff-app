import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database, seedSale, autoDeposit, call, balance, outstanding, cancelFee, legacyDeposit } from './helpers/card-fee-fixture.mjs';

// Local PGlite only. Chain = 20261001193526 + 20261107084849 (both live) + the new, unapplied policy.
const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8');
const autoFee = read('20261001193526_auto_finalize_closed_month_card_fees.sql');
const guard = read('20261107084849_card_fee_provisional_guard.sql');
const settlement = read('20261108100000_card_fee_actual_deposit_settlement.sql');
async function fixture({ settled = true } = {}) {
  const db = await database();
  try {
    await db.exec(autoFee);
    await db.exec(`alter table ledger_month_closures add constraint ledger_month_closures_status_check check(status='closed');
      alter table ledger_month_closures add column closed_at timestamptz default now(),add column closed_by bigint default 1,
      add column preflight_snapshot jsonb default '{}',add column summary_snapshot jsonb default '{}',add column snapshot_hash text default repeat('0',64),add column warning_snapshot jsonb default '[]';`);
    await db.exec(guard);
    if (settled) await db.exec(settlement);
    return db;
  } catch (error) { await db.close(); throw error; }
}
const close = (db, month) => db.query('insert into ledger_month_closures(month,summary_snapshot) values($1,$2::jsonb)', [`${month}-01`, JSON.stringify({ card: { feeStatus: 'pending' } })]);
// The admin confirms the final deposit and the exact amount shown (default: the month's current remainder).
const complete = async (db, month, actor = 1, { confirmed = true, fee } = {}) => {
  const amount = fee ?? ((await monthOutstanding(db, month)) || 1);
  return call(db, 'ledger_complete_card_month_v1', [`${month}-01`, confirmed, amount, 'last deposit checked', actor]);
};
const snapshot = async db => (await db.query(`select (select count(*) from ledger_transactions)::int t,(select count(*) from ledger_movements)::int m,(select count(*) from ledger_card_reconciliations)::int r,
  (select count(*) from ledger_card_fee_closures)::int f,(select count(*) from ledger_card_fee_allocation_lines)::int l,(select count(*) from ledger_audit_logs)::int a`)).rows[0];
const feeExpenses = async db => Number((await db.query("select count(*) n from ledger_transactions where source_type='card_fee_month_close'")).rows[0].n);
const monthOutstanding = async (db, month) => (await outstanding(db)).filter(row => row.business_date.startsWith(month)).reduce((sum, row) => sum + row.outstandingGrossAmount, 0);
async function prepare(db, remaining = 5000000, month = '2026-08', gross = 100000000) {
  await seedSale(db, gross, `${month}-20`); await autoDeposit(db, gross - remaining, `${month}-25`); await close(db, month);
}
async function provisional(db, amount, month) {
  const id = Number((await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,created_by,confirmed_by)
    values(gen_random_uuid(),'expense',$1::date,$1::date,date_trunc('month',$1::date)::date,$2,(select id from ledger_categories where kind='expense' and name='카드 정산 차액'),'confirmed','manual','card-fee-estimate:'||$3||':full','{}',1,1) returning id`, [`${month}-28`, amount, month])).rows[0].id);
  await db.query("insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code='card_clearing'),$2)", [id, -amount]);
}

test('a deposit moves only real principal FIFO and never books a fee, whatever the remaining rate', async () => {
  for (const [remaining, deposit] of [[5000000, 2850000], [1000000, 500000], [3000000, 4000000]]) {
    {
      const db = await fixture();
      try {
        await prepare(db, remaining); const next = await seedSale(db, 10000000, '2026-09-02');
        const clearing = await balance(db, 'card_clearing'), bank = await balance(db, 'baba_corporate_bank');
        const result = await autoDeposit(db, deposit, '2026-09-05');
        assert.equal(result.status, 'created', `remaining ${remaining}`);
        assert.deepEqual(result.autoFeeClosures, []);
        assert.equal(await feeExpenses(db), 0);
        // Oldest sale month first, then the next month: exact principal.
        const toAugust = Math.min(deposit, remaining);
        assert.deepEqual(result.allocations.map(row => Number(row.allocatedAmount)), deposit > remaining ? [toAugust, deposit - remaining] : [toAugust]);
        if (deposit > remaining) assert.equal(Number(result.allocations[1].transactionId), next);
        assert.equal(await balance(db, 'card_clearing'), clearing - deposit);
        assert.equal(await balance(db, 'baba_corporate_bank'), bank + deposit);
      } finally { await db.close(); }
    }
  }
  // Baseline (live today) books a rate-based fee in the same situation.
  const live = await fixture({ settled: false });
  try { await prepare(live); assert.equal(Number((await autoDeposit(live, 2850000, '2026-09-05')).autoFeeClosures[0].feeAmount), 2150000); } finally { await live.close(); }
});

test('settlement after the last deposit books the actual remainder once and later deposits go to the next month', async () => {
  const db = await fixture();
  try {
    await prepare(db); const next = await seedSale(db, 10000000, '2026-09-02');
    const last = await autoDeposit(db, 2850000, '2026-09-05');
    assert.equal(await monthOutstanding(db, '2026-08'), 2150000);
    const closures = (await db.query('select * from ledger_month_closures')).rows;
    const clearing = await balance(db, 'card_clearing'), bank = await balance(db, 'baba_corporate_bank');
    const result = await complete(db, '2026-08');
    assert.equal(result.status, 'confirmed');
    assert.equal(Number(result.feeAmount), 2150000);
    assert.equal(Number(result.settlementDepositReconciliationId), Number(last.reconciliationId));
    assert.equal(result.settlementConfirmed, true);
    const tx = (await db.query("select recognition_month::text,business_date::text,amount from ledger_transactions where source_type='card_fee_month_close'")).rows;
    const today = (await db.query("select ((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date::text d")).rows[0].d;
    assert.deepEqual(tx.map(row => [row.recognition_month, row.business_date, Number(row.amount)]), [['2026-08-01', today, 2150000]]);
    assert.equal(await balance(db, 'card_clearing'), clearing - 2150000);
    assert.equal(await balance(db, 'baba_corporate_bank'), bank, 'no money moves to the bank on settlement');
    assert.equal(await monthOutstanding(db, '2026-08'), 0);
    assert.deepEqual((await db.query('select * from ledger_month_closures')).rows, closures, 'close snapshot untouched');
    // Duplicate settlement is refused without writing.
    const before = await snapshot(db);
    assert.equal((await complete(db, '2026-08')).status, 'already_confirmed');
    assert.deepEqual(await snapshot(db), before);
    // The next deposit pays September sales only.
    const later = await autoDeposit(db, 1000000, '2026-09-06');
    assert.deepEqual(later.allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]), [[next, 1000000]]);
  } finally { await db.close(); }
});

test('settlement blockers write nothing', async () => {
  const cases = [
    ['current month', async db => { const m = (await db.query("select to_char(((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date,'YYYY-MM') m")).rows[0].m; return m; }, 'current_month'],
    ['forbidden actor', async db => { await prepare(db); await autoDeposit(db, 2850000, '2026-09-05'); return ['2026-08', 999]; }, 'forbidden'],
    ['no deposit after month end', async db => { await prepare(db); return '2026-08'; }, 'no_settlement_deposit'],
    ['legacy unallocated deposit', async db => { await prepare(db); await seedSale(db, 10000000, '2026-09-02'); await autoDeposit(db, 2850000, '2026-09-05'); await legacyDeposit(db, 100000, '2026-09-06'); return '2026-08'; }, 'legacy_unallocated_deposits'],
    ['earlier month still unpaid', async db => { await prepare(db, 3000000, '2026-07'); await seedSale(db, 100000000, '2026-08-20'); await close(db, '2026-08'); return '2026-08'; }, 'earlier_month_unconfirmed'],
    ['provisional month', async db => { await seedSale(db, 100000000, '2026-08-20'); await autoDeposit(db, 97000000, '2026-08-25'); await provisional(db, 3000000, '2026-08'); await close(db, '2026-08'); return '2026-08'; }, 'provisional_fee_exists'],
    ['nothing left', async db => { await seedSale(db, 100000000, '2026-08-20'); await autoDeposit(db, 100000000, '2026-08-25'); await close(db, '2026-08'); return '2026-08'; }, 'nothing_to_settle'],
  ];
  for (const [label, setup, status] of cases) {
    const db = await fixture();
    try {
      const target = await setup(db);
      const [month, actor] = Array.isArray(target) ? target : [target, 1];
      const before = await snapshot(db);
      const result = await complete(db, month, actor);
      assert.equal(result.status, status, label);
      assert.deepEqual(await snapshot(db), before, label);
    } finally { await db.close(); }
  }
});

test('October-style provisional month is skipped by deposits and does not block settling a later month', async () => {
  const db = await fixture();
  try {
    await seedSale(db, 100000000, '2026-08-20'); await autoDeposit(db, 97000000, '2026-08-25');
    await provisional(db, 3000000, '2026-08'); await close(db, '2026-08');
    await seedSale(db, 10000000, '2026-09-02');
    const sep = await autoDeposit(db, 9000000, '2026-09-20');
    assert.equal(sep.feeReviews[0].reason, 'provisional_fee');
    await close(db, '2026-09');
    await autoDeposit(db, 800000, '2026-10-03');
    const result = await complete(db, '2026-09');
    assert.equal(result.status, 'confirmed');
    assert.equal(Number(result.feeAmount), 200000);
    assert.equal(await monthOutstanding(db, '2026-08'), 3000000, 'provisional month left exactly as booked');
    assert.equal((await complete(db, '2026-08')).status, 'provisional_fee_exists');
  } finally { await db.close(); }
});

test('an open past month settles through the existing manual confirmation', async () => {
  const db = await fixture();
  try {
    await seedSale(db, 100000000, '2026-08-20'); await autoDeposit(db, 97000000, '2026-08-25');
    const result = await complete(db, '2026-08');
    assert.equal(result.status, 'confirmed');
    assert.equal(Number((await db.query("select fee_amount from ledger_card_fee_closures where status='confirmed'")).rows[0].fee_amount), 3000000);
    assert.equal(await monthOutstanding(db, '2026-08'), 0);
  } finally { await db.close(); }
});

test('settlement cancellation restores the remainder and settling again works once (retry)', async () => {
  const db = await fixture();
  try {
    await prepare(db); await autoDeposit(db, 2850000, '2026-09-05');
    const first = await complete(db, '2026-08');
    const clearing = await balance(db, 'card_clearing');
    assert.equal((await cancelFee(db, first.closureId, 'bank statement corrected')).status, 'cancelled');
    assert.equal(await balance(db, 'card_clearing'), clearing + 2150000);
    assert.equal(await monthOutstanding(db, '2026-08'), 2150000);
    const again = await complete(db, '2026-08');
    assert.equal(again.status, 'confirmed');
    assert.deepEqual((await db.query('select status from ledger_card_fee_closures order by id')).rows.map(row => row.status), ['cancelled', 'confirmed']);
  } finally { await db.close(); }
});

test('existing rate-based closures survive the migration and keep their cancellation; the rate policy is gone', async () => {
  const db = await fixture({ settled: false });
  try {
    await prepare(db); const auto = await autoDeposit(db, 2850000, '2026-09-05');
    const id = auto.autoFeeClosures[0].closureId;
    const rows = (await db.query('select * from ledger_card_fee_closures')).rows;
    await db.exec(settlement);
    assert.deepEqual((await db.query('select * from ledger_card_fee_closures')).rows, rows, 'history unchanged');
    assert.equal((await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ledger_card_fee_private' and p.proname='policy'")).rows[0].n, 0);
    const body = (await db.query("select pg_get_functiondef('public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint)'::regprocedure) d")).rows[0].d;
    assert.doesNotMatch(body, /minRate|maxRate|targetRate|finalize_month/);
    assert.equal((await cancelFee(db, id, 'historical correction')).status, 'cancelled');
  } finally { await db.close(); }
});

test('TS deposit preview plans the same FIFO allocation and no fee', async () => {
  const { planCardDepositWithFees } = await import('../lib/ledger/card-fee-policy.ts');
  const db = await fixture();
  try {
    await prepare(db, 3000000); await seedSale(db, 10000000, '2026-09-02');
    const plan = planCardDepositWithFees(await outstanding(db), 4000000, '2026-09-05', [{ month: '2026-08', gross: 100000000, outstanding: 3000000 }]);
    const result = await autoDeposit(db, 4000000, '2026-09-05');
    assert.equal(plan.error, null);
    assert.deepEqual(plan.fees, []);
    assert.deepEqual(plan.rows.map(row => [row.transactionId, row.allocatedAmount]), result.allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]));
  } finally { await db.close(); }
});

test('settlement requires the explicit final-deposit confirmation and the exact amount, and audits who/when/how much', async () => {
  for (const closedMonth of [true, false]) {
    const db = await fixture();
    try {
      await seedSale(db, 100000000, '2026-08-20'); await autoDeposit(db, 95000000, '2026-08-25');
      if (closedMonth) { await close(db, '2026-08'); await autoDeposit(db, 2850000, '2026-09-05'); }
      const remainder = await monthOutstanding(db, '2026-08');
      const before = await snapshot(db);
      // A bare remainder never settles: no confirmation, a stale amount or a bad amount writes nothing.
      assert.equal((await complete(db, '2026-08', 1, { confirmed: false, fee: remainder })).status, 'last_deposit_confirmation_required');
      const stale = await complete(db, '2026-08', 1, { fee: remainder + 1000 });
      assert.deepEqual([stale.status, Number(stale.feeAmount)], ['confirmed_fee_mismatch', remainder]);
      assert.equal((await complete(db, '2026-08', 1, { fee: 0 })).status, 'invalid_confirmed_fee');
      assert.deepEqual(await snapshot(db), before, `closed=${closedMonth}`);
      const result = await complete(db, '2026-08', 1, { fee: remainder });
      assert.equal(result.status, 'confirmed');
      assert.deepEqual([result.lastDepositConfirmed, Number(result.confirmedBy), Number(result.confirmedFee), result.path],
        [true, 1, remainder, closedMonth ? 'closed_month_post_close_settlement' : 'open_month_manual_confirmation']);
      const audit = (await db.query("select actor_user_id,entity_id,after_snapshot,reason,created_at from ledger_audit_logs where action='card_payment_settlement_confirmed'")).rows;
      assert.equal(audit.length, 1);
      assert.equal(Number(audit[0].actor_user_id), 1);
      assert.equal(Number(audit[0].entity_id), Number(result.closureId));
      assert.deepEqual([audit[0].after_snapshot.lastDepositConfirmed, Number(audit[0].after_snapshot.confirmedBy), Number(audit[0].after_snapshot.confirmedFee), Number(audit[0].after_snapshot.feeAmount)], [true, 1, remainder, remainder]);
      assert.ok(audit[0].after_snapshot.confirmedAt, 'confirmation time recorded');
      assert.equal(audit[0].reason, 'last deposit checked');
    } finally { await db.close(); }
  }
});

test('every card month boundary, including the reused manual confirmation, follows the 03:00 business day', async () => {
  const db = await fixture();
  try {
    const def = async signature => (await db.query(`select pg_get_functiondef('${signature}'::regprocedure) d`)).rows[0].d;
    const expression = (source, name) => {
      const line = source.split('\n').find(row => row.trim().startsWith(name) && row.includes('now()'));
      assert.ok(line, name);
      return line.slice(line.indexOf(':=') + 2).replace(/;\s*$/, '').trim();
    };
    const boundaries = [
      ['confirm v_current_month', expression(await def('public.ledger_confirm_card_fee_month_v1(date,text,bigint)'), 'v_current_month')],
      ['settlement v_current', expression(await def('public.ledger_complete_card_month_v1(date,boolean,numeric,text,bigint)'), 'v_current')],
      ['deposit v_current_month', expression(await def('public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint)'), 'v_current_month')],
    ];
    // Month start: before 03:00 on the 1st is still the previous business month.
    for (const [instant, expected] of [['2026-11-01 00:30:00+07', '2026-10-01'], ['2026-11-01 02:59:59+07', '2026-10-01'], ['2026-11-01 03:00:00+07', '2026-11-01'], ['2026-10-31 23:59:00+07', '2026-10-01'], ['2027-01-01 01:00:00+07', '2026-12-01']]) {
      for (const [label, sql] of boundaries) {
        const value = (await db.query(`select (${sql.replaceAll('now()', `'${instant}'::timestamptz`)})::text v`)).rows[0].v;
        assert.equal(value, expected, `${label} at ${instant}`);
      }
    }
  } finally { await db.close(); }
});
