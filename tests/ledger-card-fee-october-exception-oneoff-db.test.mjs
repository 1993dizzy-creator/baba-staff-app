// Isolated PGlite only; never a Production connection. Runs the October estimate-exception one-off
// script against the live card-fee chain (20261001193526 + 20261107084849) with October shaped like
// production: one closed month, remainder fully covered by the provisional manual voucher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database, seedSale, autoDeposit, balance } from './helpers/card-fee-fixture.mjs';
import { parseCardFeeEstimateExceptions } from '../lib/ledger/card-fee-exception.ts';
import { buildCardFeeHistory } from '../lib/ledger/card-fee-history.ts';

const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8');
const SCRIPT = readFileSync('scripts/ledger/card-fee-october-estimate-exception-20261108-ONE-OFF.sql', 'utf8');
const APPROVAL = 'APPROVED:card-fee-october-estimate-exception-20261108';
async function october() {
  const db = await database();
  await db.exec(read('20261001193526_auto_finalize_closed_month_card_fees.sql'));
  await db.exec(`alter table ledger_month_closures add constraint ledger_month_closures_status_check check(status='closed');
    alter table ledger_month_closures add column closed_at timestamptz default now(),add column closed_by bigint default 1,
    add column preflight_snapshot jsonb default '{}',add column summary_snapshot jsonb default '{}',add column snapshot_hash text default repeat('0',64),add column warning_snapshot jsonb default '[]';`);
  await db.exec(read('20261107084849_card_fee_provisional_guard.sql'));
  await seedSale(db, 192125640, '2026-10-20');
  await autoDeposit(db, 186426528, '2026-10-25');
  const id = Number((await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,created_by,confirmed_by)
    values(gen_random_uuid(),'expense','2026-10-31','2026-10-31','2026-10-01',5699112,(select id from ledger_categories where kind='expense' and name='카드 정산 차액'),'confirmed','manual','card-fee-estimate:2026-10:full-unallocated','{}',1,1) returning id`)).rows[0].id);
  await db.query("insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code='card_clearing'),-5699112)", [id]);
  await db.query("insert into ledger_month_closures(month) values('2026-10-01')");
  return { db, id };
}
const prepared = (id, { approval = APPROVAL, actor = '1' } = {}) => SCRIPT
  .replace("'__ACTOR_USER_ID__'", `'${actor}'`).replace("'__OWNER_APPROVAL__'", `'${approval}'`)
  .replace('c_provisional_tx constant bigint := 4119;', `c_provisional_tx constant bigint := ${id};`);
const state = async db => (await db.query(`select (select count(*) from ledger_transactions)::int t,(select count(*) from ledger_movements)::int m,(select count(*) from ledger_card_fee_closures)::int f,
  (select count(*) from ledger_card_reconciliation_lines)::int l,(select count(*) from ledger_audit_logs where action='card_fee_month_estimate_exception')::int x`)).rows[0];

test('without the owner approval or a valid actor the script writes nothing', async () => {
  const { db, id } = await october();
  try {
    const before = await state(db);
    await assert.rejects(db.exec(SCRIPT), /OCT_EXCEPTION_ACTOR_REQUIRED/);
    await db.exec('rollback');
    await assert.rejects(db.exec(prepared(id, { approval: 'nope' })), /OCT_EXCEPTION_APPROVAL_REQUIRED/);
    await db.exec('rollback');
    await assert.rejects(db.exec(prepared(id, { actor: '999' })), /OCT_EXCEPTION_ACTOR_FORBIDDEN/);
    await db.exec('rollback');
    assert.deepEqual(await state(db), before);
  } finally { await db.close(); }
});

test('approved run writes one audit record only; re-run changes nothing; the app shows the exception', async () => {
  const { db, id } = await october();
  try {
    const before = await state(db), clearing = await balance(db, 'card_clearing');
    const voucher = (await db.query('select * from ledger_transactions where id=$1', [id])).rows[0];
    await db.exec(prepared(id));
    const after = await state(db);
    assert.deepEqual({ ...after, x: 0 }, { ...before, x: 0 }, 'no transaction, movement, closure or line');
    assert.equal(after.x, 1);
    assert.equal(await balance(db, 'card_clearing'), clearing);
    assert.deepEqual((await db.query('select * from ledger_transactions where id=$1', [id])).rows[0], voucher);
    const row = (await db.query("select actor_user_id,entity_type,entity_id,after_snapshot,reason,created_at from ledger_audit_logs where action='card_fee_month_estimate_exception'")).rows[0];
    assert.deepEqual([Number(row.actor_user_id), row.entity_type, Number(row.entity_id)], [1, 'card_fee_month', id]);
    assert.equal(row.after_snapshot.officialFeeConfirmed, false);
    assert.equal(Number(row.after_snapshot.provisionalAmount), 5699112);
    // Identical re-run: verified, no change.
    await db.exec(prepared(id));
    assert.deepEqual(await state(db), after);
    // The app reads it: October becomes an estimate exception, never averaged.
    const parsed = parseCardFeeEstimateExceptions([row]);
    assert.deepEqual(parsed.map(item => [item.month, item.amount]), [['2026-10', 5699112]]);
    const history = buildCardFeeHistory({ currentMonth: '2026-11', months: [
      { month: '2026-09', gross: 181045460, saleDays: 27, historicalConfirmedFee: 0, monthEndFee: 4332575, hasClosure: true, currentOutstanding: 0, monthClosed: true, provisionalFee: 0 },
      { month: '2026-10', gross: 192125640, saleDays: 29, historicalConfirmedFee: 0, monthEndFee: 0, hasClosure: false, currentOutstanding: 5699112, monthClosed: true, provisionalFee: 5699112, estimateException: true },
    ] });
    assert.equal(history.months.find(item => item.month === '2026-10').status, 'estimate_exception');
    assert.equal(history.confirmedCount, 1);
    assert.equal((history.averageRate * 100).toFixed(2), '2.39', 'October stays out of the average');
  } finally { await db.close(); }
});

test('a changed October state or a different existing record stops the script', async () => {
  const { db, id } = await october();
  try {
    await db.exec(prepared(id));
    await db.exec("update ledger_audit_logs set reason='edited' where action='card_fee_month_estimate_exception'");
    await assert.rejects(db.exec(prepared(id)), /OCT_EXCEPTION_DIFFERENT_RECORD_EXISTS/);
    await db.exec('rollback');
  } finally { await db.close(); }
  const other = await october();
  try {
    await assert.rejects(other.db.exec(prepared(other.id + 1)), /OCT_EXCEPTION_PROVISIONAL_MISMATCH/);
    await other.db.exec('rollback');
    assert.equal((await state(other.db)).x, 0);
  } finally { await other.db.close(); }
});
