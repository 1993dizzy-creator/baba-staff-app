import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database, seedSale, autoDeposit, legacyDeposit, call, balance, outstanding } from './helpers/card-fee-fixture.mjs';
import { planCardDepositWithFees } from '../lib/ledger/card-fee-policy.ts';

// Local PGlite only. Card chain = live 20261001193526 + 20261107084849 + 20261108100000, then the new,
// unapplied restoration (20261120121505) and legacy RPC retirement (20261120121506).
// The fixture reproduces the Production shape verified read-only on 2026-11-20: same reconciliation and
// deposit transaction ids, deposit dates/amounts, November card sales, #76-#79 manual matches and the
// October provisional fee (#4119-style manual expense equal to October's remainder).
const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8');
const autoFee = read('20261001193526_auto_finalize_closed_month_card_fees.sql');
const guard = read('20261107084849_card_fee_provisional_guard.sql');
const settlement = read('20261108100000_card_fee_actual_deposit_settlement.sql');
const RESTORE = read('20261120121505_restore_november_card_deposit_allocations.sql');
const RETIRE = read('20261120121506_retire_legacy_card_deposit_create_rpc.sql');

const NOVEMBER_SALES = [['2026-11-01', 6342500], ['2026-11-02', 17506520], ['2026-11-03', 2957800], ['2026-11-04', 11350900], ['2026-11-05', 3170800],
  ['2026-11-06', 19009100], ['2026-11-07', 16871000], ['2026-11-08', 2856600], ['2026-11-09', 8411900], ['2026-11-10', 17077600], ['2026-11-11', 1941800],
  ['2026-11-12', 13470600], ['2026-11-13', 21785400], ['2026-11-14', 7151800], ['2026-11-15', 12890800], ['2026-11-16', 1717600], ['2026-11-17', 10287900],
  ['2026-11-18', 20167700], ['2026-11-19', 3862400]];
// #76-#79: legacy deposits later matched by hand (sale date -> amount), as on Production.
const MATCHED = [['2026-11-02', 5224627, [['2026-11-01', 5224627]]], ['2026-11-03', 19645504, [['2026-11-01', 1117873], ['2026-11-02', 17506520], ['2026-11-03', 1021111]]],
  ['2026-11-04', 2893611, [['2026-11-03', 1936689], ['2026-11-04', 956922]]], ['2026-11-05', 11132516, [['2026-11-04', 10393978], ['2026-11-05', 738538]]]];
const TARGETS = [[80, 4858, '2026-11-06', 3094700], [81, 4859, '2026-11-09', 37059996], [82, 5138, '2026-11-10', 9103126], [83, 5139, '2026-11-11', 14114289],
  [84, 5140, '2026-11-12', 3877273], [85, 5141, '2026-11-13', 12762670], [86, 5142, '2026-11-16', 35625303], [87, 5143, '2026-11-17', 8034534]];
const TOTAL = 123671891;
const PROVISIONAL = 5699112;

async function fixture() {
  const db = await database();
  try {
    await db.exec(autoFee);
    await db.exec(`alter table ledger_month_closures add constraint ledger_month_closures_status_check check(status='closed');
      alter table ledger_month_closures add column closed_at timestamptz default now(),add column closed_by bigint default 1,
      add column preflight_snapshot jsonb default '{}',add column summary_snapshot jsonb default '{}',add column snapshot_hash text default repeat('0',64),add column warning_snapshot jsonb default '[]';`);
    await db.exec(guard);
    await db.exec(settlement);
    // October: paid except the provisional manual fee, then closed (no fee closure).
    await seedSale(db, 20000000, '2026-10-28');
    assert.equal((await autoDeposit(db, 20000000 - PROVISIONAL, '2026-10-30')).status, 'created');
    const fee = Number((await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,created_by,confirmed_by)
      values(gen_random_uuid(),'expense','2026-10-31','2026-10-31','2026-10-01',$1,(select id from ledger_categories where kind='expense' and name='카드 정산 차액'),'confirmed','manual','card-fee-estimate:2026-10:full','{}',1,1) returning id`, [PROVISIONAL])).rows[0].id);
    await db.query("insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code='card_clearing'),$2)", [fee, -PROVISIONAL]);
    await db.query(`insert into ledger_month_closures(month,summary_snapshot) values('2026-10-01','{"card":{"feeStatus":"pending"}}')`);
    const sale = {};
    for (const [date, amount] of NOVEMBER_SALES) sale[date] = await seedSale(db, amount, date);
    for (const [date, amount, lines] of MATCHED) {
      const created = await legacyDeposit(db, amount, date);
      const matched = await call(db, 'ledger_match_card_reconciliation_v1', [created.reconciliationId,
        JSON.stringify(lines.map(([saleDate, gross]) => ({ transactionId: sale[saleDate], allocatedGrossAmount: gross }))), true, 1]);
      assert.equal(matched.status, 'matched');
    }
    await db.query("select setval(pg_get_serial_sequence('public.ledger_card_reconciliations','id'),79)");
    for (const [id, tx, date, amount] of TARGETS) {
      if (tx === 4858 || tx === 5138) await db.query("select setval(pg_get_serial_sequence('public.ledger_transactions','id'),$1)", [tx - 1]);
      const created = await legacyDeposit(db, amount, date);
      assert.deepEqual([created.status, Number(created.reconciliationId), Number(created.transactionId)], ['created', id, tx]);
    }
    return { db, sale };
  } catch (error) { await db.close(); throw error; }
}
const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
const json = async (db, sql, args = []) => JSON.stringify(await rows(db, sql, args));
const state = async db => ({
  transactions: await json(db, 'select * from ledger_transactions order by id'),
  movements: await json(db, 'select * from ledger_movements order by id'),
  otherRecs: await json(db, 'select * from ledger_card_reconciliations where id not between 80 and 87 order by id'),
  otherLines: await json(db, 'select * from ledger_card_reconciliation_lines where reconciliation_id not between 80 and 87 order by id'),
  fees: await json(db, 'select * from ledger_card_fee_closures order by id') + await json(db, 'select * from ledger_card_fee_allocation_lines order by id'),
  audits: await json(db, 'select * from ledger_audit_logs order by id'),
  closures: await json(db, 'select month,status from ledger_month_closures order by month'),
  clearing: await balance(db, 'card_clearing'), bank: await balance(db, 'baba_corporate_bank'),
});
const targets = db => rows(db, `select r.id::int,r.status,r.matched_gross_amount::numeric::float8 matched,r.deposit_amount::numeric::float8 amount,r.deposit_date::text,
  coalesce((select sum(l.allocated_gross_amount) from ledger_card_reconciliation_lines l where l.reconciliation_id=r.id),0)::float8 allocated,
  (select count(*) from ledger_card_reconciliation_lines l where l.reconciliation_id=r.id)::int lines from ledger_card_reconciliations r where r.id between 80 and 87 order by r.id`);
const monthOutstanding = async (db, month) => (await outstanding(db)).filter(row => row.business_date.startsWith(month)).reduce((sum, row) => sum + row.outstandingGrossAmount, 0);
// Independent FIFO over the November sales left by #76-#79 (October pays nothing: its remainder is the provisional fee).
function expectedLines() {
  const left = new Map(NOVEMBER_SALES.map(([date, amount]) => [date, amount]));
  for (const [, , lines] of MATCHED) for (const [date, gross] of lines) left.set(date, left.get(date) - gross);
  return TARGETS.map(([id, , depositDate, amount]) => {
    const out = []; let remaining = amount;
    for (const [date] of NOVEMBER_SALES) {
      if (remaining <= 0 || date > depositDate || left.get(date) <= 0) continue;
      const take = Math.min(remaining, left.get(date)); out.push([id, date, take]); left.set(date, left.get(date) - take); remaining -= take;
    }
    assert.equal(remaining, 0);
    return out;
  }).flat();
}

test('verified Production shape: legacy deposits block a new FIFO deposit before restoration', async () => {
  const { db } = await fixture();
  try {
    assert.deepEqual((await targets(db)).map(row => [row.status, row.allocated]), TARGETS.map(() => ['unmatched', 0]));
    assert.equal(await monthOutstanding(db, '2026-11'), 198830720 - 38896258);
    assert.equal(await balance(db, 'card_clearing'), 36262571);
    const blocked = await autoDeposit(db, 10087054, '2026-11-18');
    assert.deepEqual([blocked.status, blocked.reason], ['card_fee_review_required', 'legacy_unallocated_deposits']);
  } finally { await db.close(); }
});

test('restoration allocates #80-#87 FIFO in place; money, other deposits, fees, closures and audits are unchanged', async () => {
  const { db } = await fixture();
  try {
    const before = await state(db);
    const octoberBefore = await monthOutstanding(db, '2026-10');
    await db.exec(RESTORE);
    const after = await state(db);
    // Targets: auto_allocated, lines = deposit, total restored = 123,671,891.
    const restored = await targets(db);
    assert.deepEqual(restored.map(row => [row.id, row.status, row.matched, row.allocated]), TARGETS.map(([id, , , amount]) => [id, 'auto_allocated', amount, amount]));
    assert.equal(restored.reduce((sum, row) => sum + row.allocated, 0), TOTAL);
    const lines = await rows(db, `select l.reconciliation_id::int id,s.business_date::text date,l.allocated_gross_amount::float8 amount,r.deposit_date::text deposit_date
      from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id=l.reconciliation_id join ledger_transactions s on s.id=l.pos_card_transaction_id
      where l.reconciliation_id between 80 and 87 order by l.id`);
    assert.deepEqual(lines.map(row => [row.id, row.date, row.amount]), expectedLines());
    assert.ok(lines.every(row => row.date <= row.deposit_date && row.date.startsWith('2026-11')), 'no future or prior-month sale');
    // No new transaction or movement; deposit rows, movements and every balance unchanged.
    for (const key of ['transactions', 'movements', 'otherRecs', 'otherLines', 'fees', 'closures', 'clearing', 'bank']) assert.equal(after[key], before[key], key);
    assert.equal(after.clearing, 36262571);
    assert.equal(await monthOutstanding(db, '2026-11'), 36262571);
    assert.equal(await monthOutstanding(db, '2026-10'), octoberBefore);
    assert.equal(octoberBefore, PROVISIONAL);
    assert.equal((await rows(db, "select 1 from ledger_transactions t where t.source_type='pos_sales_daily_payment' and public.ledger_card_sale_consumed_v1(t.id)>t.amount")).length, 0);
    // Existing audits untouched; 8 restoration rows + 1 summary appended.
    const audits = JSON.parse(after.audits);
    assert.equal(JSON.stringify(audits.slice(0, JSON.parse(before.audits).length)), before.audits);
    const added = audits.slice(JSON.parse(before.audits).length);
    assert.deepEqual(added.map(row => [row.action, row.entity_id === null ? null : Number(row.entity_id)]),
      [...TARGETS.map(([id]) => ['card_deposit_allocation_restored', id]), ['november_card_deposit_allocations_restored', null]]);
    assert.ok(added.slice(0, 8).every(row => row.before_snapshot.reconciliation.status === 'unmatched' && row.after_snapshot.status === 'auto_allocated'
      && row.after_snapshot.allocations.reduce((sum, line) => sum + Number(line.allocatedAmount), 0) === Number(row.after_snapshot.depositAmount)));
    assert.equal(added[8].after_snapshot.newTransactions, 0);
    // No fee booked and no fee closure; October's provisional fee stays the only October fee.
    assert.equal((await rows(db, "select 1 from ledger_transactions where source_type='card_fee_month_close'")).length, 0);
  } finally { await db.close(); }
});

test('after restoration the 11/18 and 11/19 deposits preview and save FIFO; 03:00 boundary and guards still hold', async () => {
  const { db } = await fixture();
  try {
    await db.exec(RESTORE);
    const feeMonths = [{ month: '2026-10', gross: 20000000, outstanding: PROVISIONAL, provisionalFee: PROVISIONAL, closed: true },
      { month: '2026-11', gross: 198830720, outstanding: 36262571, closed: false }];
    for (const [date, amount] of [['2026-11-18', 10087054], ['2026-11-19', 14545476]]) {
      const plan = planCardDepositWithFees(await outstanding(db), amount, date, feeMonths);
      assert.equal(plan.error, null, date);
      const created = await autoDeposit(db, amount, date);
      assert.equal(created.status, 'created', date);
      assert.deepEqual(created.allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]),
        plan.rows.map(row => [row.transactionId, row.allocatedAmount]), `preview equals saved allocation ${date}`);
      assert.deepEqual(created.autoFeeClosures, []);
    }
    assert.equal(await balance(db, 'card_clearing'), 36262571 - 10087054 - 14545476);
    // Still blocked: more than the outstanding sales, a deposit at 02:30 cannot use same-day sales, invalid input.
    assert.equal((await autoDeposit(db, 20000000, '2026-11-19')).status, 'insufficient_card_pending');
    const early = await call(db, 'ledger_create_card_deposit_auto_allocate_v1', ['2026-11-20T02:30:00+07:00', 1, Number((await rows(db, "select id from ledger_fund_accounts where code='baba_corporate_bank'"))[0].id), 'early', 1]);
    assert.equal(early.status, 'created');
    assert.equal((await rows(db, `select r.deposit_date::text d from ledger_card_reconciliations r where r.id=$1`, [early.reconciliationId]))[0].d, '2026-11-19');
    assert.equal((await autoDeposit(db, -5, '2026-11-19')).status, 'invalid_amount');
    // No fee is ever confirmed by a deposit.
    assert.equal((await rows(db, "select 1 from ledger_card_fee_closures")).length, 0);
  } finally { await db.close(); }
});

test('a second run is a no-op and drift aborts without any partial write', async () => {
  {
    const { db } = await fixture();
    try {
      await db.exec(RESTORE);
      const once = await state(db), lines = await targets(db);
      await db.exec(RESTORE);
      assert.deepEqual(await state(db), once);
      assert.deepEqual(await targets(db), lines);
    } finally { await db.close(); }
  }
  for (const [label, drift, code] of [
    ['another legacy deposit', db => legacyDeposit(db, 1000, '2026-11-18'), /NOVEMBER_CARD_RESTORE_OTHER_LEGACY_DEPOSITS/],
    ['an amount that differs', db => db.query('alter table ledger_card_reconciliations disable trigger user').then(() => db.query('update ledger_card_reconciliations set deposit_amount=deposit_amount+1 where id=84')).then(() => db.query('alter table ledger_card_reconciliations enable trigger user')), /NOVEMBER_CARD_RESTORE_RECONCILIATION_DRIFT/],
    ['November closed', db => db.query(`insert into ledger_month_closures(month,summary_snapshot) values('2026-11-01','{}')`), /NOVEMBER_CARD_RESTORE_MONTH_CLOSED/],
  ]) {
    const { db } = await fixture();
    try {
      await drift(db);
      const before = await state(db);
      await assert.rejects(db.exec(RESTORE), code, label);
      assert.deepEqual(await state(db), before, label);
      assert.ok((await targets(db)).every(row => row.status === 'unmatched' && row.lines === 0), label);
    } finally { await db.close(); }
  }
});

test('legacy creator retirement: refused before restoration, drops only that function afterwards', async () => {
  const { db } = await fixture();
  try {
    await assert.rejects(db.exec(RETIRE), /LEGACY_CARD_DEPOSIT_UNRESOLVED/);
    assert.ok((await rows(db, "select to_regprocedure('public.ledger_create_card_deposit_v1(timestamptz,numeric,bigint,text,text,bigint)') f"))[0].f);
    await db.exec(RESTORE);
    const functions = async () => (await rows(db, `select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','ledger_card_fee_private') order by 1`)).map(row => row.f);
    const before = await functions();
    await db.exec(RETIRE);
    const after = await functions();
    assert.deepEqual(before.filter(f => !after.includes(f)), ['ledger_create_card_deposit_v1(timestamp with time zone,numeric,bigint,text,text,bigint)']);
    await assert.rejects(legacyDeposit(db, 1000, '2026-11-18'), /does not exist/);
    // The only deposit path, cancellation and the historical match tool remain.
    const created = await autoDeposit(db, 1000000, '2026-11-18');
    assert.equal(created.status, 'created');
    assert.equal((await call(db, 'ledger_cancel_card_reconciliation_v1', [created.reconciliationId, 'test', 1])).status, 'cancelled');
    assert.ok(after.includes('ledger_match_card_reconciliation_v1(bigint,jsonb,boolean,bigint)'));
  } finally { await db.close(); }
});
