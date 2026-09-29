import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { initializePosCloseDatabase } from './helpers/pos-business-day-close-fixture.mjs';

const read = name => readFileSync('supabase/migrations/' + name, 'utf8');
const normalization = read('20260929073431_normalize_september_card_deposits.sql');
const preflight = (() => {
  const sql = read('20260916080015_preserve_cancelled_recurring_expenses.sql');
  const start = sql.indexOf('create or replace function public.ledger_close_preflight_v1(');
  return sql.slice(start, sql.indexOf('\nend$$;', start) + '\nend$$;'.length);
})();
const preflightPatch = (() => {
  const sql = read('20260921170100_add_inventory_payment_verification.sql');
  const start = sql.indexOf("  v_oid := 'public.ledger_close_preflight_v1(date,bigint)'::regprocedure;");
  const end = sql.indexOf('  execute v_definition;\nend;\n$payment_verification$;', start);
  assert.ok(start > 0 && end > start);
  return 'do $pv$\ndeclare v_oid regprocedure; v_definition text;\nbegin\n'
    + sql.slice(start, end) + '  execute v_definition;\nend;\n$pv$;';
})();

async function database() {
  const db = new PGlite();
  try {
    await initializePosCloseDatabase(db);
    await db.exec("alter table ledger_transactions add column economic_effect_sign smallint not null default 1;"
      + "alter table ledger_transactions drop constraint ledger_transaction_recognition_policy;"
      + "alter table ledger_transactions add constraint ledger_transaction_recognition_policy check("
      + "(type in('income','expense','sales','expense_recognition') and recognition_month is not null and recognition_month=date_trunc('month',recognition_month)::date and category_id is not null)"
      + "or(type not in('income','expense','sales','expense_recognition') and recognition_month is null and category_id is null));");
    await db.exec(read('20260915095952_add_card_reconciliation_cancellation.sql'));
    await db.exec(read('20260915103312_prevent_future_card_sale_matching.sql'));
    await db.exec("alter table ledger_candidates add column updated_at timestamptz default now(), add column resolved_transaction_id bigint;"
      + "create table payroll_payment_batches(payroll_month date,status text);"
      + "create table ledger_recurring_expense_plans(id bigint primary key,effective_from date,effective_to date);"
      + "create table ledger_payables(id bigint primary key,original_amount numeric,status text,expense_transaction_id bigint);"
      + "create table ledger_payable_allocations(payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);"
      + "create table ledger_reserve_plans(id bigint primary key,is_active boolean,target_amount numeric);"
      + "create table ledger_reserve_entries(reserve_plan_id bigint,entry_type text,amount numeric,occurred_at timestamptz);");
    await db.exec(preflight);
    await db.exec(preflightPatch);
    await db.exec(read('20260927144325_add_card_deposit_auto_allocation.sql'));
    await db.exec(read('20260927173019_add_card_fee_month_closures.sql'));
    return db;
  } catch (error) { await db.close(); throw error; }
}
async function one(db, sql, args = []) { return (await db.query(sql, args)).rows[0]; }
async function rpc(db, name, args) {
  return (await one(db, 'select public.' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') result', args)).result;
}
async function sale(db, date, amount) {
  const row = await one(db, "insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,created_by,confirmed_by)"
    + "values(gen_random_uuid(),'sales',$1::date,$1::date,date_trunc('month',$1::date)::date,$2,(select id from ledger_categories where kind='income' limit 1),'confirmed','pos_sales_daily_payment','pos:'||$1::date::text||':card','{}',md5($1::text),now(),1,1) returning id", [date, amount]);
  await db.query("insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code='card_clearing'),$2)", [row.id, amount]);
  return Number(row.id);
}
const bank = async db => Number((await one(db, "select id from ledger_fund_accounts where code='baba_corporate_bank'")).id);
const balance = async db => Number((await one(db, "select coalesce(sum(m.amount),0) n from ledger_movements m join ledger_transactions t on t.id=m.transaction_id and t.status='confirmed' join ledger_fund_accounts f on f.id=m.fund_account_id where f.code='card_clearing'")).n);
const consumed = async (db, id) => Number((await one(db, 'select public.ledger_card_sale_consumed_v1($1) n', [id])).n);
const outstanding = async db => Number((await one(db, "select coalesce(sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)),0) n from ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment' and t.source_key like 'pos:%:card' and t.business_date>='2026-09-01' and t.business_date<'2026-10-01'")).n);

async function seedProductionShape(db) {
  const august = await sale(db, '2026-08-31', 1000);
  const september1 = await sale(db, '2026-09-01', 12000000);
  const september2 = await sale(db, '2026-09-02', 37319902);
  const differences = [300000, 300000, 300000, 300000, 300000, 603353];
  const recs = [];
  for (let i = 0; i < 6; i++) {
    const date = '2026-09-' + String(i + 3).padStart(2, '0');
    const created = await rpc(db, 'ledger_create_card_deposit_v1', [date + 'T12:00:00+07:00', 2000000, await bank(db), 'legacy', 'legacy', 1]);
    assert.equal(created.status, 'created');
    const gross = 2000000 + differences[i];
    let lines;
    if (i === 0) lines = [{ transactionId: august, allocatedGrossAmount: 1000 }, { transactionId: september1, allocatedGrossAmount: gross - 1000 }];
    else if (i === 5) lines = [{ transactionId: september1, allocatedGrossAmount: 501000 }, { transactionId: september2, allocatedGrossAmount: gross - 501000 }];
    else lines = [{ transactionId: september1, allocatedGrossAmount: gross }];
    const matched = await rpc(db, 'ledger_match_card_reconciliation_v1', [created.reconciliationId, JSON.stringify(lines), true, 1]);
    assert.equal(matched.status, 'matched');
    recs.push(Number(created.reconciliationId));
  }
  for (let i = 0; i < 9; i++) {
    const date = '2026-09-' + String(i + 15).padStart(2, '0');
    const created = await rpc(db, 'ledger_create_card_deposit_auto_allocate_v1', [date + 'T12:00:00+07:00', 1000000, await bank(db), 'auto', 1]);
    assert.equal(created.status, 'created');
    recs.push(Number(created.reconciliationId));
  }
  assert.equal(await balance(db), 26217549);
  return { august, september1, september2, recs };
}


test('September migration rebuilds all deposits FIFO and restores the future month-end fee balance', async () => {
  const db = await database();
  try {
    const { august, september1, september2, recs } = await seedProductionShape(db);
    const augustBefore = await consumed(db, august);
    const septemberOutstandingBefore = await outstanding(db);
    const linesBefore = (await db.query("select reconciliation_id,pos_card_transaction_id,allocated_gross_amount from ledger_card_reconciliation_lines order by reconciliation_id,pos_card_transaction_id")).rows;
    const depositMovementsBefore = (await db.query("select m.transaction_id,m.fund_account_id,m.amount from ledger_movements m join ledger_card_reconciliations r on r.deposit_transaction_id=m.transaction_id order by m.transaction_id,m.fund_account_id")).rows;
    await db.exec(normalization);
    assert.equal(await consumed(db, august), augustBefore);
    assert.equal(await balance(db), 28320902);
    assert.equal(await outstanding(db), septemberOutstandingBefore + 2103353);
    const linesAfter = (await db.query("select reconciliation_id,pos_card_transaction_id,allocated_gross_amount from ledger_card_reconciliation_lines order by reconciliation_id,pos_card_transaction_id")).rows;
    assert.notDeepEqual(linesAfter, linesBefore);
    assert.deepEqual(linesAfter.filter(row => Number(row.reconciliation_id) === recs[0])
      .map(row => [Number(row.pos_card_transaction_id), Number(row.allocated_gross_amount)]),
      [[august, 1000], [september1, 1999000]], 'first deposit includes August and September sales');
    assert.equal(await consumed(db, september1), 12000000);
    assert.equal(await consumed(db, september2), 8999000);
    const rows = (await db.query("select r.id,r.status,r.deposit_amount,r.matched_gross_amount,r.difference_amount,r.confirmed_at,r.confirmed_by,coalesce(sum(l.allocated_gross_amount),0) line_total from ledger_card_reconciliations r left join ledger_card_reconciliation_lines l on l.reconciliation_id=r.id where r.deposit_date>='2026-09-01' and r.deposit_date<'2026-10-01' group by r.id order by r.id")).rows;
    assert.equal(rows.length, 15);
    for (const row of rows) {
      assert.equal(row.status, 'auto_allocated');
      assert.equal(Number(row.matched_gross_amount), Number(row.deposit_amount));
      assert.equal(Number(row.line_total), Number(row.deposit_amount));
      assert.equal(Number(row.difference_amount), 0);
      assert.equal(row.confirmed_at, null);
      assert.equal(row.confirmed_by, null);
    }
    const legacy = (await db.query("select t.status,t.amount,t.source_snapshot,m.amount movement from ledger_transactions t join ledger_movements m on m.transaction_id=t.id where t.source_type='card_settlement_difference' order by t.id")).rows;
    assert.equal(legacy.length, 6);
    assert.equal(legacy.reduce((sum, row) => sum + Number(row.amount), 0), 2103353);
    assert.ok(legacy.every(row => row.status === 'cancelled' && Number(row.movement) < 0));
    assert.deepEqual((await db.query("select m.transaction_id,m.fund_account_id,m.amount from ledger_movements m join ledger_card_reconciliations r on r.deposit_transaction_id=m.transaction_id order by m.transaction_id,m.fund_account_id")).rows, depositMovementsBefore);
    const audits = (await db.query("select action,before_snapshot,after_snapshot,reason from ledger_audit_logs where action like 'september_%' order by id")).rows;
    assert.equal(audits.length, 22);
    assert.ok(audits.every(row => row.before_snapshot && row.after_snapshot && row.reason.includes('FIFO')));
    assert.equal(Number((await one(db, "select count(*) n from ledger_card_fee_closures where fee_month='2026-09-01' and status='confirmed'")).n), 0);
    assert.ok(await outstanding(db) > 0);
  } finally { await db.close(); }
});

test('September migration aborts atomically if the legacy difference total drifts', async () => {
  const db = await database();
  try {
    await seedProductionShape(db);
    await db.query("update ledger_transactions set amount=amount+1 where source_type='card_settlement_difference' and id=(select min(id) from ledger_transactions where source_type='card_settlement_difference')");
    await assert.rejects(db.exec(normalization), /SEPTEMBER_CARD_NORMALIZATION_DIFFERENCE_DRIFT/);
    assert.equal(Number((await one(db, "select count(*) n from ledger_card_reconciliations where status='matched'")).n), 6);
    assert.equal(Number((await one(db, "select count(*) n from ledger_transactions where source_type='card_settlement_difference' and status='confirmed'")).n), 6);
  } finally { await db.close(); }
});


test('September migration refuses a closed month and an already confirmed fee closure', async () => {
  const closed = await database();
  try {
    await seedProductionShape(closed);
    await closed.exec("insert into ledger_month_closures(month,status) values('2026-09-01','closed')");
    await assert.rejects(closed.exec(normalization), /SEPTEMBER_CARD_NORMALIZATION_MONTH_CLOSED/);
    assert.equal(await balance(closed), 26217549);
  } finally { await closed.close(); }

  const fee = await database();
  try {
    await seedProductionShape(fee);
    await fee.exec("insert into ledger_card_fee_closures(fee_month,fee_amount,status,confirmed_by) values('2026-09-01',0,'confirmed',1)");
    await assert.rejects(fee.exec(normalization), /SEPTEMBER_CARD_NORMALIZATION_FEE_ALREADY_CONFIRMED/);
    assert.equal(await balance(fee), 26217549);
  } finally { await fee.close(); }
});

