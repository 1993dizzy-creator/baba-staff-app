import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database, seedSale, autoDeposit, balance, outstanding, confirmFee, cancelFee, legacyDeposit } from './helpers/card-fee-fixture.mjs';

// Local PGlite only (production applied this migration as 20261107084849).
const autoFee = readFileSync('supabase/migrations/20261001193526_auto_finalize_closed_month_card_fees.sql', 'utf8');
const guard = readFileSync('supabase/migrations/20261107084849_card_fee_provisional_guard.sql', 'utf8');
async function fixture({ guarded = true } = {}) {
  const db = await database();
  try {
    await db.exec(autoFee);
    await db.exec(`alter table ledger_month_closures add constraint ledger_month_closures_status_check check(status='closed');
      alter table ledger_month_closures add column closed_at timestamptz default now(),add column closed_by bigint default 1,
      add column preflight_snapshot jsonb default '{}',add column summary_snapshot jsonb default '{}',add column snapshot_hash text default repeat('0',64),add column warning_snapshot jsonb default '[]';`);
    if (guarded) await db.exec(guard);
    return db;
  } catch (error) { await db.close(); throw error; }
}
const close = (db, month) => db.query('insert into ledger_month_closures(month,summary_snapshot) values($1,$2::jsonb)', [`${month}-01`, JSON.stringify({ card: { feeStatus: 'pending' } })]);
// Provisional manual card fee like October #4119: expense in 카드 정산 차액, one card_clearing outflow.
async function provisional(db, amount, month, account = 'card_clearing') {
  const id = Number((await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,created_by,confirmed_by)
    values(gen_random_uuid(),'expense',$1::date,$1::date,date_trunc('month',$1::date)::date,$2,(select id from ledger_categories where kind='expense' and name='카드 정산 차액'),'confirmed','manual','card-fee-estimate:'||$3||':full-unallocated','{}',1,1) returning id`,
    [`${month}-28`, amount, month])).rows[0].id);
  await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code=$2),$3)', [id, account, -amount]);
  return id;
}
const snapshot = async db => (await db.query(`select (select count(*) from ledger_transactions)::int t,(select count(*) from ledger_movements)::int m,(select count(*) from ledger_card_reconciliations)::int r,
  (select count(*) from ledger_card_fee_closures)::int f,(select count(*) from ledger_card_fee_allocation_lines)::int l,(select count(*) from ledger_audit_logs)::int a`)).rows[0];
const feeExpenses = async db => Number((await db.query("select count(*) n from ledger_transactions where source_type='card_fee_month_close'")).rows[0].n);
// October shape scaled down: closed month, 3% remainder fully covered by a provisional voucher, next-month sales.
async function octoberShape(db, provisionalAmount = 3000000, account) {
  await seedSale(db, 100000000, '2026-08-20');
  assert.equal((await autoDeposit(db, 97000000, '2026-08-25')).status, 'created');
  const id = await provisional(db, provisionalAmount, '2026-08', account);
  await close(db, '2026-08');
  const next = await seedSale(db, 10000000, '2026-09-02');
  return { id, next };
}

test('baseline reproduces the October defect: duplicate target fee or a blocked legitimate deposit', async () => {
  for (const [deposit, expected] of [[5000000, 'created'], [10000000, 'insufficient_card_pending']]) {
    const db = await fixture({ guarded: false });
    try {
      await octoberShape(db);
      const result = await autoDeposit(db, deposit, '2026-09-05');
      assert.equal(result.status, expected);
      if (expected === 'created') assert.equal(Number(result.autoFeeClosures[0].feeAmount), 2150000, 'second fee on top of the provisional voucher');
    } finally { await db.close(); }
  }
});

test('guarded deposit skips the provisional month, pays next-month sales FIFO and books no second fee', async () => {
  const db = await fixture();
  try {
    const { id, next } = await octoberShape(db);
    const voucher = (await db.query('select * from ledger_transactions where id=$1', [id])).rows[0];
    const closures = (await db.query('select * from ledger_month_closures')).rows;
    const bank = await balance(db, 'baba_corporate_bank');
    assert.equal(await balance(db, 'card_clearing'), 10000000, 'clearing equals next-month outstanding');
    const result = await autoDeposit(db, 10000000, '2026-09-05');
    assert.equal(result.status, 'created');
    assert.deepEqual(result.autoFeeClosures, []);
    assert.deepEqual(result.allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]), [[next, 10000000]]);
    assert.equal(result.feeReviews.length, 1);
    assert.equal(result.feeReviews[0].reason, 'provisional_fee');
    assert.equal(Number(result.feeReviews[0].provisionalFee), 3000000);
    assert.equal(await feeExpenses(db), 0);
    assert.equal(await balance(db, 'card_clearing'), 0);
    assert.equal(await balance(db, 'baba_corporate_bank'), bank + 10000000);
    assert.equal((await outstanding(db))[0].outstandingGrossAmount, 3000000, 'the closed month keeps its sale rows untouched');
    assert.deepEqual((await db.query('select * from ledger_transactions where id=$1', [id])).rows[0], voucher);
    assert.deepEqual((await db.query('select * from ledger_month_closures')).rows, closures);
    const audit = (await db.query("select after_snapshot from ledger_audit_logs where action='card_deposit_auto_allocated' order by id desc limit 1")).rows[0].after_snapshot;
    assert.equal(audit.feeReviews[0].reason, 'provisional_fee');
    // A further deposit has nothing left to pay: the provisional part is never repaid.
    assert.equal((await autoDeposit(db, 1000, '2026-09-06')).status, 'insufficient_card_pending');
  } finally { await db.close(); }
});

test('partial provisional fee leaves only the rest of the month as FIFO principal', async () => {
  const db = await fixture();
  try {
    const { next } = await octoberShape(db, 2000000);
    const result = await autoDeposit(db, 5000000, '2026-09-05');
    assert.equal(result.status, 'created');
    assert.deepEqual(result.allocations.map(row => Number(row.allocatedAmount)), [1000000, 4000000]);
    assert.equal(Number(result.allocations[1].transactionId), next);
    assert.equal(await feeExpenses(db), 0);
    assert.equal((await outstanding(db))[0].outstandingGrossAmount, 2000000);
  } finally { await db.close(); }
});

test('ambiguous provisional data still blocks and writes nothing', async () => {
  for (const [label, amount, account] of [['larger than the remainder', 4000000, 'card_clearing'], ['not taken from card clearing', 3000000, 'baba_corporate_bank']]) {
    const db = await fixture();
    try {
      await octoberShape(db, amount, account);
      const before = await snapshot(db);
      const result = await autoDeposit(db, 1000000, '2026-09-05');
      assert.equal(result.status, 'card_fee_review_required', label);
      assert.equal(result.reason, 'provisional_fee_mismatch', label);
      assert.deepEqual(await snapshot(db), before, label);
    } finally { await db.close(); }
  }
});

test('manual month confirmation refuses a month that already has a provisional fee', async () => {
  for (const guarded of [false, true]) {
    const db = await fixture({ guarded });
    try {
      await seedSale(db, 100000000, '2026-08-20');
      await autoDeposit(db, 97000000, '2026-08-25');
      await provisional(db, 3000000, '2026-08');
      // Next-month sales keep card clearing funded, as in production; without them the baseline stops on clearing.
      await seedSale(db, 10000000, '2026-09-02');
      const before = await snapshot(db);
      const result = await confirmFee(db, '2026-08-01');
      if (!guarded) { assert.equal(result.status, 'confirmed', 'baseline books a duplicate'); continue; }
      assert.equal(result.status, 'provisional_fee_exists');
      assert.equal(Number(result.provisionalFee), 3000000);
      assert.deepEqual(await snapshot(db), before);
    } finally { await db.close(); }
  }
});

test('below the reference range is a review reason, not a deposit blocker', async () => {
  for (const guarded of [false, true]) {
    const db = await fixture({ guarded });
    try {
      await seedSale(db, 100000000, '2026-08-20');
      await autoDeposit(db, 99000000, '2026-08-25');
      await close(db, '2026-08');
      const next = await seedSale(db, 10000000, '2026-09-02');
      const result = await autoDeposit(db, 10000000, '2026-09-05');
      if (!guarded) { assert.equal(result.status, 'card_fee_review_required'); continue; }
      assert.equal(result.status, 'created');
      assert.deepEqual(result.allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]), [[next, 10000000]]);
      assert.deepEqual(result.feeReviews.map(row => row.reason), ['below_min_rate']);
      assert.equal(await feeExpenses(db), 0);
      assert.equal((await outstanding(db))[0].outstandingGrossAmount, 1000000, 'remainder left for review, never paid or fee\'d');
    } finally { await db.close(); }
  }
});

// Regression: the existing automatic contract is unchanged with the guard installed.
async function prepare(db, remaining = 5000000, month = '2026-08', gross = 100000000) {
  await seedSale(db, gross, `${month}-20`); await autoDeposit(db, gross - remaining, `${month}-25`); await close(db, month);
}
test('guarded: in-range, overshoot and insufficient deposits keep their automatic results', async () => {
  for (const [deposit, fee] of [[2850000, 2150000], [2600000, 2400000], [3200000, 1800000], [1500000, 0]]) {
    const db = await fixture();
    try {
      await prepare(db);
      const result = await autoDeposit(db, deposit, '2026-09-05');
      assert.equal(result.status, 'created');
      assert.deepEqual(result.autoFeeClosures.map(row => Number(row.feeAmount)), fee ? [fee] : []);
      assert.deepEqual(result.feeReviews, []);
    } finally { await db.close(); }
  }
  const db = await fixture();
  try {
    await prepare(db, 3000000); const next = await seedSale(db, 10000000, '2026-09-02');
    const result = await autoDeposit(db, 4000000, '2026-09-05');
    assert.equal(Number(result.autoFeeClosures[0].feeAmount), 2150000);
    assert.deepEqual(result.allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]).at(-1), [next, 3150000]);
  } finally { await db.close(); }
});

test('guarded: automatic cancellation, legacy blockers and the running month behave as before', async () => {
  const db = await fixture();
  try {
    await prepare(db, 5000000, '2026-09'); await seedSale(db, 10000000, '2026-10-01');
    const confirm = await autoDeposit(db, 2850000, '2026-10-02');
    assert.equal(confirm.status, 'created');
    const clearing = await balance(db, 'card_clearing');
    assert.equal((await cancelFee(db, confirm.autoFeeClosures[0].closureId, 'bank corrected')).status, 'cancelled');
    assert.equal(await balance(db, 'card_clearing'), clearing + 2150000);
    // After cancellation the next deposit may finalize again exactly once (retry path).
    const retry = await autoDeposit(db, 1000, '2026-10-03');
    assert.equal(retry.status, 'created');
    assert.equal((await db.query("select count(*)::int n from ledger_card_fee_closures where status='confirmed'")).rows[0].n, 1);
  } finally { await db.close(); }
  const legacy = await fixture();
  try {
    await prepare(legacy); await seedSale(legacy, 10000000, '2026-09-02');
    await legacyDeposit(legacy, 100000, '2026-09-03');
    const before = await snapshot(legacy);
    assert.equal((await autoDeposit(legacy, 100000, '2026-09-05')).status, 'card_fee_review_required');
    assert.deepEqual(await snapshot(legacy), before);
  } finally { await legacy.close(); }
  const running = await fixture();
  try {
    const current = (await running.query("select date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date::text m")).rows[0].m;
    await seedSale(running, 100000000, current);
    assert.equal((await autoDeposit(running, 1000, current)).status, 'created');
    assert.equal((await running.query('select count(*)::int n from ledger_card_fee_closures')).rows[0].n, 0);
  } finally { await running.close(); }
});

// The TS preview follows the current policy (20261108100000: FIFO principal only), so parity runs on the full chain.
const settlementPolicy = readFileSync('supabase/migrations/20261108100000_card_fee_actual_deposit_settlement.sql', 'utf8');
test('TS deposit preview plans the same allocations as the guarded RPC', async () => {
  const { planCardDepositWithFees } = await import('../lib/ledger/card-fee-policy.ts');
  for (const [label, setup, feeMonth, deposit] of [
    ['provisional', db => octoberShape(db, 2000000), { month: '2026-08', gross: 100000000, outstanding: 3000000, provisionalFee: 2000000 }, 5000000],
    ['below minimum', async db => { await seedSale(db, 100000000, '2026-08-20'); await autoDeposit(db, 99000000, '2026-08-25'); await close(db, '2026-08'); await seedSale(db, 10000000, '2026-09-02'); }, { month: '2026-08', gross: 100000000, outstanding: 1000000 }, 10000000],
    ['in range', async db => { await prepare(db); }, { month: '2026-08', gross: 100000000, outstanding: 5000000 }, 2850000],
  ]) {
    const db = await fixture();
    try {
      await db.exec(settlementPolicy);
      await setup(db);
      const plan = planCardDepositWithFees(await outstanding(db), deposit, '2026-09-05', [feeMonth]);
      const result = await autoDeposit(db, deposit, '2026-09-05');
      assert.equal(plan.error, null, label);
      assert.equal(result.status, 'created', label);
      assert.deepEqual(plan.rows.map(row => [row.transactionId, row.allocatedAmount]), result.allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]), label);
      assert.deepEqual(plan.fees.map(row => row.amount), result.autoFeeClosures.map(row => Number(row.feeAmount)), label);
    } finally { await db.close(); }
  }
  // Ambiguous provisional data is refused by both.
  assert.equal(planCardDepositWithFees([{ id: 1, business_date: '2026-08-20', outstandingGrossAmount: 3000000 }], 1000, '2026-09-05', [{ month: '2026-08', gross: 100000000, outstanding: 3000000, provisionalFee: 4000000 }]).error, 'review_required');
});

test('provisional month with a legacy unallocated deposit blocks the whole deposit and writes nothing', async () => {
  const db = await fixture();
  try {
    await octoberShape(db);
    await legacyDeposit(db, 100000, '2026-09-03');
    const before = await snapshot(db);
    const bank = await balance(db, 'baba_corporate_bank'), clearing = await balance(db, 'card_clearing');
    const result = await autoDeposit(db, 5000000, '2026-09-05');
    assert.equal(result.status, 'card_fee_review_required');
    assert.equal(result.reason, 'legacy_unallocated_deposits');
    assert.equal(result.feeMonth, '2026-08-01');
    assert.equal(Number(result.provisionalFee), 3000000);
    assert.deepEqual(await snapshot(db), before, 'no deposit, fee, allocation or audit row');
    assert.equal(await balance(db, 'baba_corporate_bank'), bank);
    assert.equal(await balance(db, 'card_clearing'), clearing);
    const { planCardDepositWithFees } = await import('../lib/ledger/card-fee-policy.ts');
    assert.equal(planCardDepositWithFees(await outstanding(db), 5000000, '2026-09-05', [{ month: '2026-08', gross: 100000000, outstanding: 3000000, provisionalFee: 3000000, reviewRequired: true }]).error, 'review_required');
  } finally { await db.close(); }
});

test('a drifted live definition aborts the whole migration', async () => {
  const db = await fixture({ guarded: false });
  try {
    // Simulate drift inside the plan anchor (one extra space), then apply the guard.
    await db.exec(`do $d$ declare v text:=pg_get_functiondef('public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint)'::regprocedure);
      begin execute replace(v,'   v_month_payment:=least(v_remaining,v_sale_month.outstanding);','   v_month_payment:=least(v_remaining, v_sale_month.outstanding);'); end $d$;`);
    await assert.rejects(db.exec(guard), /CARD_FEE_GUARD_PLAN_ANCHOR_MISMATCH/);
    await db.exec('rollback');
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname='provisional_fee'")).rows[0].n, 0);
    const definition = (await db.query("select pg_get_functiondef('public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint)'::regprocedure) d")).rows[0].d;
    assert.ok(!definition.includes('provisional'), 'deposit RPC unchanged');
  } finally { await db.close(); }
});
