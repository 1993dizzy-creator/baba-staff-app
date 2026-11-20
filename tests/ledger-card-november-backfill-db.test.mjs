import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database, seedSale, autoDeposit, legacyDeposit, call, balance, outstanding, bankId } from './helpers/card-fee-fixture.mjs';

// Local PGlite only. Card chain = live 20261001193526 + 20261107084849 + 20261108100000 + the applied
// 20261120121505 (restore #80-#87) and 20261120121506 (legacy creator retired), then #88 registered by the
// app on 11/20. The fixture keeps the Production ids verified read-only on 2026-11-20 (sales #4856-#5173,
// reconciliations #80-#88, deposit transactions #4858/#4859/#5138-#5143/#5200), so the hard-coded
// expectations of the new, unapplied 20261120134158 are exercised as they would be on Production.
const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8');
const autoFee = read('20261001193526_auto_finalize_closed_month_card_fees.sql');
const guard = read('20261107084849_card_fee_provisional_guard.sql');
const settlement = read('20261108100000_card_fee_actual_deposit_settlement.sql');
const RESTORE = read('20261120121505_restore_november_card_deposit_allocations.sql');
const RETIRE = read('20261120121506_retire_legacy_card_deposit_create_rpc.sql');
const BACKFILL = read('20261120134158_backfill_november_18_19_card_deposits.sql');

// [business date, gross, Production sale transaction id (null = any id below #4856)]
const NOVEMBER_SALES = [['2026-11-01', 6342500], ['2026-11-02', 17506520], ['2026-11-03', 2957800], ['2026-11-04', 11350900], ['2026-11-05', 3170800],
  ['2026-11-06', 19009100], ['2026-11-07', 16871000], ['2026-11-08', 2856600], ['2026-11-09', 8411900], ['2026-11-10', 17077600], ['2026-11-11', 1941800],
  ['2026-11-12', 13470600, 4856], ['2026-11-13', 21785400, 4903], ['2026-11-14', 7151800, 4950], ['2026-11-15', 12890800, 4985], ['2026-11-16', 1717600, 5022],
  ['2026-11-17', 10287900, 5050], ['2026-11-18', 20167700, 5109], ['2026-11-19', 3862400, 5173]];
const MATCHED = [['2026-11-02', 5224627, [['2026-11-01', 5224627]]], ['2026-11-03', 19645504, [['2026-11-01', 1117873], ['2026-11-02', 17506520], ['2026-11-03', 1021111]]],
  ['2026-11-04', 2893611, [['2026-11-03', 1936689], ['2026-11-04', 956922]]], ['2026-11-05', 11132516, [['2026-11-04', 10393978], ['2026-11-05', 738538]]]];
const TARGETS = [[80, 4858, '2026-11-06', 3094700], [81, 4859, '2026-11-09', 37059996], [82, 5138, '2026-11-10', 9103126], [83, 5139, '2026-11-11', 14114289],
  [84, 5140, '2026-11-12', 3877273], [85, 5141, '2026-11-13', 12762670], [86, 5142, '2026-11-16', 35625303], [87, 5143, '2026-11-17', 8034534]];
const PROVISIONAL = 5699112;
const LATE = [['2026-11-18', 10087054], ['2026-11-19', 14545476]];
const at = (date, time = '12:00') => `${date}T${time}:00+07:00`;
const deposit = async (db, date, amount, time) => call(db, 'ledger_create_card_deposit_auto_allocate_v1', [at(date, time), amount, await bankId(db), 'test', 1]);
const setSeq = (db, table, value) => db.query(`select setval(pg_get_serial_sequence('public.${table}','id'),$1)`, [value]);

// chronological=true registers 11/18 and 11/19 through the RPC before #88: the reference date-order FIFO.
async function fixture({ chronological = false, beforeRec88 } = {}) {
  const db = await database();
  try {
    await db.exec(autoFee);
    await db.exec(`alter table ledger_month_closures add constraint ledger_month_closures_status_check check(status='closed');
      alter table ledger_month_closures add column closed_at timestamptz default now(),add column closed_by bigint default 1,
      add column preflight_snapshot jsonb default '{}',add column summary_snapshot jsonb default '{}',add column snapshot_hash text default repeat('0',64),add column warning_snapshot jsonb default '[]';`);
    await db.exec(guard);
    await db.exec(settlement);
    await seedSale(db, 20000000, '2026-10-28');
    assert.equal((await autoDeposit(db, 20000000 - PROVISIONAL, '2026-10-30')).status, 'created');
    const fee = Number((await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,created_by,confirmed_by)
      values(gen_random_uuid(),'expense','2026-10-31','2026-10-31','2026-10-01',$1,(select id from ledger_categories where kind='expense' and name='카드 정산 차액'),'confirmed','manual','card-fee-estimate:2026-10:full','{}',1,1) returning id`, [PROVISIONAL])).rows[0].id);
    await db.query("insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code='card_clearing'),$2)", [fee, -PROVISIONAL]);
    await db.query(`insert into ledger_month_closures(month,summary_snapshot) values('2026-10-01','{"card":{"feeStatus":"pending"}}')`);
    const sale = {};
    for (const [date, amount, id] of NOVEMBER_SALES) {
      if (id) await setSeq(db, 'ledger_transactions', id - 1);
      sale[date] = await seedSale(db, amount, date);
      if (id) assert.equal(sale[date], id);
    }
    for (const [date, amount, lines] of MATCHED) {
      const created = await legacyDeposit(db, amount, date);
      assert.equal((await call(db, 'ledger_match_card_reconciliation_v1', [created.reconciliationId,
        JSON.stringify(lines.map(([saleDate, gross]) => ({ transactionId: sale[saleDate], allocatedGrossAmount: gross }))), true, 1])).status, 'matched');
    }
    await setSeq(db, 'ledger_card_reconciliations', 79);
    for (const [id, tx, date, amount] of TARGETS) {
      if (tx === 4858 || tx === 5138) await setSeq(db, 'ledger_transactions', tx - 1);
      const created = await legacyDeposit(db, amount, date);
      assert.deepEqual([Number(created.reconciliationId), Number(created.transactionId)], [id, tx]);
    }
    await db.exec(RESTORE);
    await db.exec(RETIRE);
    if (chronological) for (const [date, amount] of LATE) assert.equal((await deposit(db, date, amount)).status, 'created');
    if (beforeRec88) await beforeRec88(db);
    await setSeq(db, 'ledger_transactions', 5199);
    const rec88 = await deposit(db, '2026-11-20', 6837115, '20:21');
    assert.equal(rec88.status, 'created');
    if (!chronological && !beforeRec88) assert.deepEqual([Number(rec88.reconciliationId), Number(rec88.transactionId)], [88, 5200]);
    return { db, sale, rec88: Number(rec88.reconciliationId) };
  } catch (error) { await db.close(); throw error; }
}
const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
const json = async (db, sql, args = []) => JSON.stringify(await rows(db, sql, args));
const state = async db => ({
  transactions: await json(db, 'select * from ledger_transactions order by id'),
  movements: await json(db, 'select * from ledger_movements order by id'),
  recs: await json(db, 'select * from ledger_card_reconciliations order by id'),
  lines: await json(db, 'select * from ledger_card_reconciliation_lines order by id'),
  fees: await json(db, 'select * from ledger_card_fee_closures order by id') + await json(db, 'select * from ledger_card_fee_allocation_lines order by id'),
  audits: await json(db, 'select * from ledger_audit_logs order by id'),
  closures: await json(db, 'select month,status from ledger_month_closures order by month'),
});
// Lines of the deposits dated 11/18 or later, by deposit date: [deposit date, sale id, amount].
const lateLines = db => rows(db, `select r.deposit_date::text d, l.pos_card_transaction_id::int sale, l.allocated_gross_amount::float8 amount
  from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id=l.reconciliation_id
  where r.deposit_date>='2026-11-18' and r.status<>'cancelled' order by r.deposit_date, l.pos_card_transaction_id`).then(list => list.map(row => [row.d, row.sale, row.amount]));
const EXPECTED = [['2026-11-18', 4985, 226971], ['2026-11-18', 5022, 1717600], ['2026-11-18', 5050, 8142483],
  ['2026-11-19', 5050, 2145417], ['2026-11-19', 5109, 12400059], ['2026-11-20', 5109, 6837115]];
const novemberOutstanding = async db => (await outstanding(db)).filter(row => row.business_date.startsWith('2026-11')).reduce((sum, row) => sum + row.outstandingGrossAmount, 0);

test('fixture equals the verified Production state: #88 took the 11/15-11/17 sales, 29,425,456 left', async () => {
  const { db } = await fixture();
  try {
    assert.deepEqual(await lateLines(db), [['2026-11-20', 4985, 226971], ['2026-11-20', 5022, 1717600], ['2026-11-20', 5050, 4892544]]);
    assert.equal(await balance(db, 'card_clearing'), 29425456);
    assert.equal(await novemberOutstanding(db), 29425456);
    assert.deepEqual((await outstanding(db)).filter(row => row.outstandingGrossAmount > 0 && row.business_date.startsWith('2026-11')).map(row => [row.id, row.outstandingGrossAmount]),
      [[5050, 5395356], [5109, 20167700], [5173, 3862400]]);
  } finally { await db.close(); }
});

test('backfill creates both deposits through the RPC and leaves exactly the deposit-date FIFO lines', async () => {
  const reference = await fixture({ chronological: true });
  let chronological;
  try { chronological = await lateLines(reference.db); } finally { await reference.db.close(); }
  // The real chronological registration is the independent reference.
  assert.deepEqual(chronological, EXPECTED);

  const { db } = await fixture();
  try {
    const before = await state(db);
    const bankBefore = await balance(db, 'baba_corporate_bank');
    const octoberBefore = (await outstanding(db)).filter(row => row.business_date.startsWith('2026-10')).reduce((sum, row) => sum + row.outstandingGrossAmount, 0);
    await db.exec(BACKFILL);
    assert.deepEqual(await lateLines(db), EXPECTED);
    // Money: two deposits only, 24,632,530 from card clearing to the corporate bank.
    assert.equal(await balance(db, 'card_clearing'), 4792926);
    assert.equal(await balance(db, 'baba_corporate_bank'), bankBefore + 24632530);
    assert.equal(await novemberOutstanding(db), 4792926);
    assert.equal((await outstanding(db)).filter(row => row.business_date.startsWith('2026-10')).reduce((sum, row) => sum + row.outstandingGrossAmount, 0), octoberBefore);
    assert.equal((await rows(db, "select 1 from ledger_transactions t where t.source_type='pos_sales_daily_payment' and public.ledger_card_sale_consumed_v1(t.id)>t.amount")).length, 0);
    const created = await rows(db, `select r.id::int, r.deposit_date::text d, r.deposit_amount::float8 amount, r.status, t.occurred_at, t.memo, t.source_snapshot,
      (select json_agg(json_build_object('a', m.amount::float8, 'f', f.code) order by m.id) from ledger_movements m join ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id=t.id) mv
      from ledger_card_reconciliations r join ledger_transactions t on t.id=r.deposit_transaction_id where r.deposit_date in ('2026-11-18','2026-11-19') order by r.id`);
    assert.deepEqual(created.map(row => [row.d, row.amount, row.status, row.source_snapshot.allocationMode]), [['2026-11-18', 10087054, 'auto_allocated', 'fifo_auto'], ['2026-11-19', 14545476, 'auto_allocated', 'fifo_auto']]);
    assert.deepEqual(created.map(row => row.mv), LATE.map(([, amount]) => [{ a: -amount, f: 'card_clearing' }, { a: amount, f: 'baba_corporate_bank' }]));
    assert.match(created[0].memo, /11월!K291/);
    assert.match(created[1].memo, /11월!K306/);
    const after = await state(db);
    // Untouched: every old transaction and movement (#5200 included), every other reconciliation row (#88 included),
    // #80-#87 and older lines, fees, closures, existing audits.
    const prefix = (key, list) => JSON.stringify(JSON.parse(after[key]).slice(0, JSON.parse(before[key]).length)) === before[key] && list;
    assert.ok(prefix('transactions', true) && prefix('movements', true) && prefix('recs', true) && prefix('audits', true));
    assert.equal(JSON.parse(after.transactions).length, JSON.parse(before.transactions).length + 2);
    assert.equal(JSON.parse(after.movements).length, JSON.parse(before.movements).length + 4);
    for (const key of ['fees', 'closures']) assert.equal(after[key], before[key], key);
    const oldLines = JSON.parse(before.lines).filter(line => Number(line.reconciliation_id) !== 88);
    assert.deepEqual(JSON.parse(after.lines).filter(line => Number(line.reconciliation_id) < 88), oldLines);
    // Audits appended: the RPC's two rows, one re-plan row per late deposit (#18, #19, #88) and the summary.
    const added = JSON.parse(after.audits).slice(JSON.parse(before.audits).length);
    assert.deepEqual(added.map(row => row.action), ['card_deposit_auto_allocated', 'card_deposit_auto_allocated',
      'card_deposit_allocation_resequenced', 'card_deposit_allocation_resequenced', 'card_deposit_allocation_resequenced', 'november_card_deposits_backfilled']);
    const resequenced = added.filter(row => row.action === 'card_deposit_allocation_resequenced');
    assert.deepEqual(resequenced.map(row => Number(row.entity_id)), [created[0].id, created[1].id, 88]);
    assert.deepEqual(resequenced[2].before_snapshot.allocations.map(line => [Number(line.transactionId), Number(line.allocatedAmount)]), [[4985, 226971], [5022, 1717600], [5050, 4892544]]);
    assert.deepEqual(resequenced.flatMap(row => row.after_snapshot.allocations.map(line => [row.after_snapshot.depositDate, Number(line.transactionId), Number(line.allocatedAmount)])), EXPECTED);
    assert.equal(added[5].after_snapshot.newFeeClosures, 0);
    assert.equal(Number(added[5].after_snapshot.cardClearingBalance), 4792926);
    // No fee booked; the normal deposit path keeps working afterwards with the same guards.
    assert.equal((await rows(db, "select 1 from ledger_transactions where source_type='card_fee_month_close'")).length, 0);
    assert.equal((await deposit(db, '2026-11-19', 5000000)).status, 'insufficient_card_pending');
    assert.deepEqual((await deposit(db, '2026-11-19', 1000000)).allocations.map(row => [Number(row.transactionId), Number(row.allocatedAmount)]), [[5109, 930526], [5173, 69474]]);
  } finally { await db.close(); }
});

test('a second run is a no-op', async () => {
  const { db } = await fixture();
  try {
    await db.exec(BACKFILL);
    const once = await state(db);
    await db.exec(BACKFILL);
    assert.deepEqual(await state(db), once);
  } finally { await db.close(); }
});

test('drift and a late failure abort the whole migration without any partial write', async () => {
  for (const [label, options, drift, code] of [
    ['11/18 already registered', { beforeRec88: db => deposit(db, '2026-11-18', 10087054).then(r => assert.equal(r.status, 'created')) }, null, /NOVEMBER_CARD_BACKFILL_DUPLICATE_DEPOSIT/],
    ['another deposit dated after 11/18', {}, db => deposit(db, '2026-11-19', 1000000), /NOVEMBER_CARD_BACKFILL_OTHER_LATE_DEPOSIT/],
    ['#88 cancelled', {}, db => call(db, 'ledger_cancel_card_reconciliation_v1', [88, 'test', 1]), /NOVEMBER_CARD_BACKFILL_RECONCILIATION_88_DRIFT/],
    ['a sale amount changed', {}, db => db.query("update ledger_transactions set amount=amount+1 where id=5173"), /NOVEMBER_CARD_BACKFILL_SALE_DRIFT/],
    ['November closed', {}, db => db.query(`insert into ledger_month_closures(month,summary_snapshot) values('2026-11-01','{}')`), /NOVEMBER_CARD_BACKFILL_MONTH_CLOSED/],
    // After both RPC deposits and the re-plan were written, the final audit insert fails: everything rolls back.
    ['failure at the last write', {}, db => db.exec(`create function test_fail_summary() returns trigger language plpgsql as $$ begin
        if new.action='november_card_deposits_backfilled' then raise exception 'TEST_LATE_FAILURE'; end if; return new; end $$;
        create trigger test_fail_summary before insert on ledger_audit_logs for each row execute function test_fail_summary();`), /TEST_LATE_FAILURE/],
  ]) {
    const { db } = await fixture(options);
    try {
      if (drift) await drift(db);
      const before = await state(db);
      await assert.rejects(db.exec(BACKFILL), code, label);
      assert.deepEqual(await state(db), before, label);
    } finally { await db.close(); }
  }
});
