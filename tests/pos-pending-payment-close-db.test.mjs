// In-memory PostgreSQL (PGlite) only. Applies 20261022120000 on top of the existing
// close / final-check fixtures (20260912 close body) and the card-fee fixture
// (20260927 close body = current production body).
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { posFinalDatabase, daySource, finalCheck, finalMigration } from './helpers/pos-business-day-final-fixture.mjs';
import { closeDay, ledgerState } from './helpers/pos-business-day-close-fixture.mjs';
import { database as cardFeeDatabase } from './helpers/card-fee-fixture.mjs';
import { pendingMigration, installPendingPaymentMigration, applyProductionCloseLayout, addPendingReceipt, resolvePending, functionIdentity } from './helpers/pos-pending-payment-fixture.mjs';

const CLOSE = 'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)';
const count = async (db, sql, args = []) => Number((await db.query(sql, args)).rows[0].n);

async function pendingDatabase() {
  const { db, ...context } = await posFinalDatabase();
  try { await installPendingPaymentMigration(db); return { db, ...context }; } catch (e) { await db.close(); throw e; }
}

test('migration patches the live close body in place and keeps identity, owner, ACL and options', async () => {
  for (const make of [async () => (await posFinalDatabase()).db, () => cardFeeDatabase()]) {
    const db = await make();
    try {
      const before = await functionIdentity(db, CLOSE);
      await installPendingPaymentMigration(db);
      assert.deepEqual(await functionIdentity(db, CLOSE), before);
      const def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d;
      assert.equal(def.split("'pending_payment'").length - 1, 1);
      const rpc = (await db.query(`select prosecdef, proacl::text acl from pg_proc where oid='public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)'::regprocedure`)).rows[0];
      assert.equal(rpc.prosecdef, false);
      assert.match(rpc.acl, /service_role=X/);
      assert.doesNotMatch(rpc.acl, /(^|[{,])=X|anon=|authenticated=/);
      await assert.rejects(db.exec(pendingMigration), /POS_PENDING_HOLD_ALREADY_APPLIED/);
    } finally { await db.close(); }
  }
});

test('migration fails closed when the close body no longer matches the anchor', async () => {
  const { db } = await posFinalDatabase();
  try {
    const def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d;
    await db.exec(def.replace('in share mode;', 'in share mode; -- drift'));
    const before = (await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d;
    await assert.rejects(installPendingPaymentMigration(db), /POS_PENDING_HOLD_CLOSE_CONTRACT_MISMATCH/);
    await db.exec('rollback').catch(() => {});
    assert.equal((await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d, before);
  } finally { await db.close(); }
});

test('anchor matches only the production layout (blank line after the lock); repository layout fails closed', async () => {
  const { db } = await posFinalDatabase();
  try {
    const def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d;
    const blankLayout = 'in share mode;\n\n  perform pos_sales_close_private.validate_source(';
    assert.equal(def.includes(blankLayout), false);
    await assert.rejects(installPendingPaymentMigration(db, { productionLayout: false }), /POS_PENDING_HOLD_CLOSE_CONTRACT_MISMATCH/);
    await db.exec('rollback').catch(() => {});
    assert.equal((await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d, def);
    await applyProductionCloseLayout(db);
    const production = (await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d;
    assert.equal(production.split(blankLayout).length - 1, 1);
    await db.exec(pendingMigration);
    const patched = (await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d;
    // Original text and blank line kept; only the hold block is added after the lock.
    assert.match(patched, /in share mode;\n  -- Pending POS payments hold[\s\S]*?  end if;\n\n  perform pos_sales_close_private\.validate_source\(/);
  } finally { await db.close(); }
});

test('only active CUKCUK pending receipts hold the close (EXISTS and pendingCount)', async () => {
  const { db, date } = await pendingDatabase();
  try {
    await addPendingReceipt(db, date, { id: 9 });
    await db.exec("update pos_sales_receipts set source='manual' where id=9");
    assert.notEqual((await closeDay(db, await daySource(db, date), { actor: 3 })).status, 'pending_payment');
  } finally { await db.close(); }
  const second = await pendingDatabase();
  try {
    await addPendingReceipt(second.db, second.date, { id: 9 });
    await addPendingReceipt(second.db, second.date, { id: 10 });
    await addPendingReceipt(second.db, second.date, { id: 11 });
    await second.db.exec("update pos_sales_receipts set source='manual' where id=10");
    const result = await closeDay(second.db, await daySource(second.db, second.date), { actor: 3 });
    assert.deepEqual([result.status, result.pendingCount], ['pending_payment', 2]);
  } finally { await second.db.close(); }
});

for (const variant of ['fresh', 'young']) test(`manual close is held by any active pending receipt (${variant}) without writing anything`, async () => {
  const { db, date } = await pendingDatabase();
  try {
    await addPendingReceipt(db, date, { pendingSince: variant === 'young' ? "now() - interval '1 minute'" : "now() - interval '2 hours'" });
    const before = await ledgerState(db);
    const result = await closeDay(db, await daySource(db, date), { actor: 3 });
    assert.equal(result.status, 'pending_payment');
    assert.equal(result.pendingCount, 1);
    assert.deepEqual(await ledgerState(db), before);
  } finally { await db.close(); }
});

test('several pending receipts hold the close; after-sync manual path is held too', async () => {
  const { db, date } = await pendingDatabase();
  try {
    await addPendingReceipt(db, date, { id: 9 });
    await addPendingReceipt(db, date, { id: 10 });
    const source = await daySource(db, date);
    const result = (await db.query('select sales_close_business_day_after_sync_v1($1,$2,$3::jsonb,$4::jsonb,3,\'manual\',false,100) r',
      [date, source.sourceFingerprint, JSON.stringify(source.sourceSnapshot), JSON.stringify(source.rows)])).rows[0].r;
    assert.equal(result.status, 'pending_payment');
    assert.equal(result.pendingCount, 2);
    assert.equal(await count(db, 'select count(*) n from pos_sales_business_day_closures'), 0);
  } finally { await db.close(); }
});

test('canceled pending receipts and zero pending close normally', async () => {
  const { db, date } = await pendingDatabase();
  try {
    await addPendingReceipt(db, date, { canceled: true });
    const result = await closeDay(db, await daySource(db, date), { actor: 3 });
    assert.equal(result.status, 'closed');
  } finally { await db.close(); }
});

test('03:05 final close records a pending_payment hold as evidence and does not close', async () => {
  const { db, ...context } = await pendingDatabase();
  try {
    await addPendingReceipt(db, context.date);
    const result = await finalCheck(db, context, { source: await daySource(db, context.date) });
    assert.equal(result.status, 'source_invalid');
    assert.equal(result.closeResult.status, 'pending_payment');
    const check = (await db.query('select closure_id, detail_snapshot from pos_sales_business_day_close_checks')).rows[0];
    assert.equal(check.closure_id, null);
    assert.equal(check.detail_snapshot.failureCode, 'pending_payment');
    assert.equal(await count(db, 'select count(*) n from pos_sales_business_day_closures'), 0);
    assert.equal(await count(db, 'select count(*) n from ledger_transactions'), 0);
  } finally { await db.close(); }
});

test('already closed days are never reopened or reclosed by the hold', async () => {
  const { db, ...context } = await pendingDatabase();
  try {
    const source = await daySource(db, context.date);
    assert.equal((await closeDay(db, source, { actor: 3 })).status, 'closed');
    const before = await ledgerState(db);
    await addPendingReceipt(db, context.date);
    // Pending receipts are not part of the paid source: the final check still verifies the closure.
    const result = await finalCheck(db, context, { source: await daySource(db, context.date) });
    assert.equal(result.status, 'verified_unchanged');
    assert.deepEqual(await ledgerState(db), before);
  } finally { await db.close(); }
});

test('pending -> paid (transfer) records evidence, replaces the POS snapshot and unblocks the close', async () => {
  const { db, date } = await pendingDatabase();
  try {
    await addPendingReceipt(db, date);
    const requestId = randomUUID();
    const result = await resolvePending(db, { requestId });
    assert.equal(result.paymentStatus, 3);
    assert.equal(result.revision, 1);
    assert.equal(result.pendingResolution.resolution, 'paid');
    const receipt = (await db.query('select payment_status,is_canceled,is_modified,revision,status_changed_at,inventory_deduction_auto_eligible_at,modification_note from pos_sales_receipts where id=9')).rows[0];
    assert.deepEqual([receipt.payment_status, receipt.is_canceled, receipt.is_modified, Number(receipt.revision)], [3, false, true, 1]);
    assert.ok(receipt.status_changed_at && receipt.inventory_deduction_auto_eligible_at);
    const payments = (await db.query('select source,payment_name,amount from pos_sales_receipt_payments where receipt_id=9')).rows;
    assert.deepEqual(payments.map(p => [p.source, p.payment_name, Number(p.amount)]), [['manual', 'Chuyển khoản', 50000]]);
    assert.equal(await count(db, 'select count(*) n from pos_sales_receipt_lines where receipt_id=9 and payment_status=3'), 2);
    const audit = (await db.query('select before_state,after_state,modified_by from pos_sales_receipt_modifications where receipt_id=9')).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].before_state.paymentStatus, 1);
    assert.equal(audit[0].before_state.payments.length, 1);
    assert.equal(audit[0].after_state.pendingResolution.evidenceNote, 'Bank transfer #123 confirmed');
    assert.equal(audit[0].modified_by, 'manager');
    // Same request id: idempotent replay, no second change.
    assert.deepEqual(await resolvePending(db, { requestId }), result);
    assert.equal(await count(db, 'select count(*) n from pos_sales_receipt_modifications'), 1);
    // A new request on the old revision / non-pending state is rejected.
    await assert.rejects(resolvePending(db, { requestId: randomUUID() }), /receipt_not_pending/);
    const source = await daySource(db, date);
    assert.equal(source.transfer, 60000 + 50000);
    assert.equal((await closeDay(db, source, { actor: 3 })).status, 'closed');
  } finally { await db.close(); }
});

test('pending -> paid (cash) stores received/change; pending -> canceled keeps payments and cancels lines', async () => {
  const { db, date } = await pendingDatabase();
  try {
    await addPendingReceipt(db, date, { id: 9 });
    await addPendingReceipt(db, date, { id: 10 });
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID(), method: 'cash', cash: 40000 }), /receipt_invalid_cash_received/);
    const cash = await resolvePending(db, { id: 9, requestId: randomUUID(), method: 'cash', cash: 60000 });
    assert.deepEqual([Number(cash.receiveAmount), Number(cash.returnAmount)], [60000, 10000]);
    const canceled = await resolvePending(db, { id: 10, requestId: randomUUID(), resolution: 'canceled', method: null, note: 'Customer left, bill voided' });
    assert.equal(canceled.isCanceled, true);
    const row = (await db.query('select payment_status,is_canceled from pos_sales_receipts where id=10')).rows[0];
    assert.deepEqual([row.payment_status, row.is_canceled], [1, true]);
    assert.equal(await count(db, 'select count(*) n from pos_sales_receipt_lines where receipt_id=10 and is_canceled'), 2);
    assert.equal(await count(db, 'select count(*) n from pos_sales_receipt_payments where receipt_id=10'), 1);
    const source = await daySource(db, date);
    assert.equal(source.cash, 40000 + 50000);
    assert.equal((await closeDay(db, source, { actor: 3 })).status, 'closed');
  } finally { await db.close(); }
});

test('resolution guards: timing, evidence, revision, method, source and closed month', async () => {
  const { db, date } = await pendingDatabase();
  try {
    await addPendingReceipt(db, date, { id: 9, pendingSince: "now() - interval '29 minutes'" });
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID() }), /receipt_pending_review_not_due/);
    // No known pending start (status_changed_at and ref_date both NULL): never resolvable.
    await db.exec('update pos_sales_receipts set ref_date = null, status_changed_at = null where id=9');
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID() }), /receipt_pending_review_not_due/);
    assert.equal(await count(db, 'select count(*) n from pos_sales_receipt_modifications'), 0);
    await db.exec("update pos_sales_receipts set status_changed_at = now() - interval '31 minutes' where id=9");
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID(), note: ' ab ' }), /receipt_evidence_required/);
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID(), revision: 5 }), /receipt_revision_conflict/);
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID(), method: 'split' }), /receipt_invalid_payment_method/);
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID(), resolution: 'canceled', method: 'cash' }), /receipt_invalid_payment_method/);
    await assert.rejects(resolvePending(db, { id: 1, requestId: randomUUID() }), /receipt_not_pending/);
    await db.exec("update pos_sales_receipts set source='manual' where id=9");
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID() }), /receipt_source_not_pending_resolvable/);
    await db.exec("update pos_sales_receipts set source='cukcuk' where id=9");
    await db.query("insert into ledger_month_closures(month,status) values(date_trunc('month',$1::date)::date,'closed')", [date]);
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID() }), /receipt_month_closed/);
    assert.equal(await count(db, 'select count(*) n from pos_sales_receipt_modifications'), 0);
    assert.equal(Number((await db.query('select revision from pos_sales_receipts where id=9')).rows[0].revision), 0);
  } finally { await db.close(); }
});

const ROLLBACK = (await import('node:fs')).readFileSync('supabase/pos_pending_payment_close_hold_rollback.sql', 'utf8');
const RESOLVE_FN = 'public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)';
const prosrc = async db => (await db.query('select prosrc from pg_proc where oid=$1::regprocedure', [CLOSE])).rows[0].prosrc;
const tables = async db => (await db.query(`select
  (select jsonb_agg(to_jsonb(r) order by id) from pos_sales_receipts r) receipts,
  (select jsonb_agg(to_jsonb(p) order by id) from pos_sales_receipt_payments p) payments,
  (select jsonb_agg(to_jsonb(l) order by id) from pos_sales_receipt_lines l) lines,
  (select jsonb_agg(to_jsonb(m) order by id) from pos_sales_receipt_modifications m) modifications,
  (select jsonb_agg(to_jsonb(c) order by id) from pos_sales_business_day_close_checks c) checks,
  (select jsonb_agg(to_jsonb(r) order by id) from ledger_card_reconciliation_lines r) card_lines`)).rows[0];

test('closed day: paid correction is refused; cancel leaves closure, Ledger, card settlement and final check intact', async () => {
  const { db, ...context } = await pendingDatabase();
  try {
    await db.exec("update pos_sales_receipt_payments set payment_type=2,payment_name='Visa' where id=2");
    const closedSource = await daySource(db, context.date);
    assert.equal((await closeDay(db, closedSource, { actor: 3 })).status, 'closed');
    const { addCardSettlement } = await import('./helpers/pos-business-day-close-fixture.mjs');
    await addCardSettlement(db, 'matched', context.date);
    await addPendingReceipt(db, context.date, { id: 9 });
    await addPendingReceipt(db, context.date, { id: 10 });
    const ledgerBefore = await ledgerState(db), before = await tables(db);
    await assert.rejects(resolvePending(db, { id: 9, requestId: randomUUID(), method: 'card' }), /receipt_business_day_closed/);
    assert.deepEqual(await tables(db), before);
    const canceled = await resolvePending(db, { id: 10, requestId: randomUUID(), resolution: 'canceled', method: null, note: 'Duplicate bill, voided' });
    assert.equal(canceled.isCanceled, true);
    const after = await daySource(db, context.date);
    assert.equal(after.sourceFingerprint, closedSource.sourceFingerprint);
    assert.deepEqual(await ledgerState(db), ledgerBefore);
    assert.deepEqual((await tables(db)).card_lines, before.card_lines);
    assert.equal((await finalCheck(db, context, { source: after })).status, 'verified_unchanged');
  } finally { await db.close(); }
});

test('03:05 pending hold is distinguishable from a sync failure in the existing check record', async () => {
  const { db, ...context } = await pendingDatabase();
  try {
    const failed = await finalCheck(db, context, { failure: 'sync_failed', run: null });
    await addPendingReceipt(db, context.date);
    const held = await finalCheck(db, context, { source: await daySource(db, context.date) });
    const rows = (await db.query('select id,result,detail_snapshot from pos_sales_business_day_close_checks order by id')).rows;
    const byId = id => rows.find(row => Number(row.id) === Number(id));
    assert.deepEqual([byId(failed.checkId).result, byId(failed.checkId).detail_snapshot.failureCode, failed.closeResult], ['sync_failed', 'sync_failed', null]);
    assert.deepEqual([byId(held.checkId).result, byId(held.checkId).detail_snapshot.failureCode, held.closeResult.status],
      ['source_invalid', 'pending_payment', 'pending_payment']);
  } finally { await db.close(); }
});

for (const variant of ['LF 20260912 body', 'CRLF body', 'production 20260927 body']) test(`rollback restores the close body byte-for-byte (${variant}) and changes no data`, async () => {
  const db = variant.startsWith('production') ? await cardFeeDatabase() : (await posFinalDatabase()).db;
  try {
    if (variant.startsWith('production')) await db.exec(finalMigration);
    if (variant === 'CRLF body') {
      const def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [CLOSE])).rows[0].d;
      await db.exec(def.replace(/\r?\n/g, '\r\n'));
      assert.ok((await prosrc(db)).includes('\r\n'));
    }
    await applyProductionCloseLayout(db);
    const originalBody = await prosrc(db), identity = await functionIdentity(db, CLOSE);
    await assert.rejects(db.exec(ROLLBACK), /POS_PENDING_HOLD_ROLLBACK_NOT_APPLIED|does not exist/);
    await db.exec('rollback').catch(() => {});
    await installPendingPaymentMigration(db);
    const date = (await db.query('select business_date::text d from pos_sales_receipts where id=1')).rows[0].d;
    await addPendingReceipt(db, date, { id: 9 });
    await resolvePending(db, { id: 9, requestId: randomUUID() });
    await addPendingReceipt(db, date, { id: 10 });
    const before = await tables(db);
    await db.exec(ROLLBACK);
    assert.equal(await prosrc(db), originalBody);
    assert.deepEqual(await functionIdentity(db, CLOSE), identity);
    assert.equal((await db.query('select to_regprocedure($1) p', [RESOLVE_FN])).rows[0].p, null);
    assert.deepEqual(await tables(db), before);
    // Hold removed: the pending receipt no longer blocks (pre-feature behavior).
    assert.notEqual((await closeDay(db, await daySource(db, date), { actor: 3 })).status, 'pending_payment');
    await assert.rejects(db.exec(ROLLBACK), /POS_PENDING_HOLD_ROLLBACK_NOT_APPLIED/);
    await db.exec('rollback').catch(() => {});
    // The migration can be applied again after a rollback.
    await db.exec(pendingMigration);
    assert.ok((await prosrc(db)).includes("'pending_payment'"));
  } finally { await db.close(); }
});
