import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as closeViewPolicy from '../lib/sales/pos-business-day-close-view.ts';
import * as closePolicy from '../lib/sales/pos-business-day-close-policy.ts';
import * as finalPolicy from '../lib/sales/pos-business-day-final-policy.ts';
import * as workflow from '../lib/sales/pos-business-day-final-workflow.ts';
import * as sources from '../lib/ledger/pos-sales-source.ts';
import * as businessTime from '../lib/store-settings/business-time-core.ts';
import { salesCloseText } from '../lib/text/sales-close.ts';

const { isPosTimestampOnlyDrift } = finalPolicy;
const CLOSED_AT = '2026-10-21T15:58:00.120000+00:00';
const CHECKED_AT = '2026-10-21T17:10:42.511873+00:00';
const CHECKED_AT_LATER = '2026-10-21T17:10:42.590104+00:00';

const receipt = (date, id, refNo, amount, overrides = {}) => ({ id, ref_no: refNo, business_date: date, ref_date: `${date}T12:00:00+00:00`,
  payment_status: 3, is_canceled: false, final_amount: amount, revision: 1, updated_at: CLOSED_AT, ...overrides });
const NAMES = { cash: [1, 'Tiền mặt', null], transfer: [1, 'Chuyển khoản', null], card: [2, 'Visa', 'Visa'], other: [9, 'Khác', null] };
const payment = (date, id, receiptId, bucket, amount) => {
  const [payment_type, payment_name, card_name] = NAMES[bucket];
  return { id, receipt_id: receiptId, business_date: date, payment_type, payment_name, card_name, amount };
};
function day(date) {
  return {
    receipts: [receipt(date, 1, 'R-1', 300_000), receipt(date, 2, 'R-2', 500_000), receipt(date, 3, 'R-3', 200_000)],
    payments: [payment(date, 11, 1, 'cash', 300_000), payment(date, 12, 2, 'card', 500_000), payment(date, 13, 3, 'transfer', 150_000),
      payment(date, 14, 3, 'other', 50_000)],
  };
}
const build = (date, { receipts, payments }) => sources.buildPosBusinessDaySource(date, receipts, payments);
const touch = (rows, ids, updatedAt = CHECKED_AT) => rows.map(row => ids.includes(row.id) ? { ...row, updated_at: updatedAt } : row);
// jsonb returns objects in its own key order; the comparison must not depend on it.
const jsonbOrder = value => Array.isArray(value) ? value.map(jsonbOrder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, jsonbOrder(value[key])])) : value;
const closedRecord = source => ({ snapshot: jsonbOrder(structuredClone(source.sourceSnapshot)), fingerprint: source.sourceFingerprint });
const timestampOnly = (closed, current) => {
  const record = closedRecord(closed);
  return isPosTimestampOnlyDrift(record.snapshot, record.fingerprint, current);
};

const FALSE_ALARM_DATES = ['2026-09-12', '2026-09-16', '2026-09-19', '2026-09-23', '2026-09-25', '2026-10-09', '2026-10-10', '2026-10-17', '2026-10-20'];

test('9 false-alarm business days: only receipt updated_at changed is classified timestamp-only', () => {
  for (const [index, date] of FALSE_ALARM_DATES.entries()) {
    const base = day(date);
    const closed = build(date, base);
    // 18 receipts in total across the 9 days: two touched per day, 0.08s apart.
    const current = build(date, { ...base, receipts: touch(touch(base.receipts, [1]), [index % 2 ? 2 : 3], CHECKED_AT_LATER) });
    assert.notEqual(current.sourceFingerprint, closed.sourceFingerprint, date);
    assert.deepEqual(current.rows.map(row => row.amount), closed.rows.map(row => row.amount), date);
    assert.equal(timestampOnly(closed, current), true, date);
  }
});

test('identical fingerprints and an unclosed day are not drift at all', () => {
  const date = '2026-10-09', closed = build(date, day(date));
  assert.equal(isPosTimestampOnlyDrift(closed.sourceSnapshot, closed.sourceFingerprint, closed), false);
  assert.equal(isPosTimestampOnlyDrift(null, null, closed), false);
});

function october21() {
  const date = '2026-10-21';
  const closedDay = {
    receipts: [receipt(date, 8407, '2601007088', 802_800), receipt(date, 8408, '2601007089', 20_000_000), receipt(date, 8409, '2601007090', 4_700_400)],
    payments: [payment(date, 9001, 8407, 'cash', 802_800), payment(date, 9002, 8408, 'card', 20_000_000), payment(date, 9003, 8409, 'transfer', 4_700_400)],
  };
  const currentDay = {
    receipts: [...touch(closedDay.receipts, [8407]), receipt(date, 8416, 'M-261021-001', 75_000, { updated_at: CHECKED_AT })],
    payments: [payment(date, 9001, 8407, 'other', 802_800), ...closedDay.payments.slice(1), payment(date, 9010, 8416, 'cash', 75_000)],
  };
  return { date, closed: build(date, closedDay), current: build(date, currentDay) };
}

test('October 21 real sales change (+75,000 and cash→other) stays a financial drift', () => {
  const { closed, current } = october21();
  assert.equal(closed.receiptTotal, 25_503_200);
  assert.equal(current.receiptTotal, 25_578_200);
  assert.equal(timestampOnly(closed, current), false);
  const record = closedRecord(closed);
  const comparison = closePolicy.comparePosClosedSource(current, record.snapshot, record.fingerprint);
  assert.equal(comparison.drift, true);
  assert.equal(comparison.timestampOnlyDrift, false);
  assert.equal(comparison.totalDelta, 75_000);
  assert.deepEqual(comparison.bucketDeltas, { cash: -727_800, transfer: 0, card: 0, other: 802_800 });
});

test('same total with cash↔other swap is a real change', () => {
  const date = '2026-10-10', base = day(date), closed = build(date, base);
  const swapped = base.payments.map(row => row.id === 11 ? payment(date, 11, 1, 'other', 300_000) : row.id === 14 ? payment(date, 14, 3, 'cash', 50_000) : row);
  const current = build(date, { receipts: touch(base.receipts, [1, 3]), payments: swapped });
  assert.equal(current.receiptTotal, closed.receiptTotal);
  assert.equal(timestampOnly(closed, current), false);
});

test('receipt added, removed, revision changed and offsetting amount edits are never timestamp-only', () => {
  const date = '2026-09-16', base = day(date), closed = build(date, base);
  const variants = {
    added: { receipts: [...base.receipts, receipt(date, 4, 'R-4', 0)], payments: base.payments },
    removed: { receipts: base.receipts.slice(0, 2), payments: base.payments.slice(0, 2) },
    revision: { receipts: base.receipts.map(row => row.id === 2 ? { ...row, revision: 2, updated_at: CHECKED_AT } : row), payments: base.payments },
    refNo: { receipts: base.receipts.map(row => row.id === 2 ? { ...row, ref_no: 'R-2b' } : row), payments: base.payments },
    // -50,000 on R-1 cash and +50,000 cash on R-2: day and every bucket total unchanged.
    offsetting: {
      receipts: base.receipts.map(row => row.id === 1 ? { ...row, final_amount: 250_000 } : row.id === 2 ? { ...row, final_amount: 550_000 } : row),
      payments: [...base.payments.map(row => row.id === 11 ? { ...row, amount: 250_000 } : row), payment(date, 15, 2, 'cash', 50_000)],
    },
  };
  for (const [name, variant] of Object.entries(variants)) {
    const current = build(date, variant);
    if (name === 'offsetting') {
      assert.equal(current.receiptTotal, closed.receiptTotal);
      assert.deepEqual(current.rows.map(row => row.amount), closed.rows.map(row => row.amount));
    }
    assert.equal(timestampOnly(closed, current), false, name);
  }
});

test('same bucket totals with a different payment ID, method name or receipt link is a real change', () => {
  const date = '2026-09-19';
  const base = { receipts: [receipt(date, 1, 'R-1', 100_000), receipt(date, 2, 'R-2', 100_000)],
    payments: [payment(date, 11, 1, 'card', 100_000), payment(date, 12, 2, 'card', 100_000)] };
  const closed = build(date, base);
  const variants = {
    paymentId: base.payments.map(row => row.id === 12 ? { ...row, id: 13 } : row),
    method: base.payments.map(row => row.id === 12 ? { ...row, payment_name: 'Master', card_name: 'Master' } : row),
    receiptLink: base.payments.map(row => ({ ...row, receipt_id: row.receipt_id === 1 ? 2 : 1 })),
  };
  for (const [name, payments] of Object.entries(variants)) {
    const current = build(date, { receipts: touch(base.receipts, [1, 2]), payments });
    assert.deepEqual(current.rows.map(row => row.amount), closed.rows.map(row => row.amount), name);
    assert.equal(timestampOnly(closed, current), false, name);
  }
});

test('unverifiable closed snapshots never qualify and inputs are not mutated', () => {
  const date = '2026-09-23', base = day(date), closed = build(date, base);
  const current = build(date, { ...base, receipts: touch(base.receipts, [1]) });
  const record = closedRecord(closed);
  const before = structuredClone(record.snapshot), currentBefore = structuredClone(current.sourceSnapshot);
  assert.equal(isPosTimestampOnlyDrift(record.snapshot, record.fingerprint, current), true);
  assert.deepEqual(record.snapshot, before);
  assert.deepEqual(current.sourceSnapshot, currentBefore);
  const tampered = structuredClone(record.snapshot);
  tampered.receipts[1].finalAmount = 400_000;
  assert.equal(isPosTimestampOnlyDrift(tampered, record.fingerprint, current), false, 'fingerprint no longer reproduces');
  const extra = { ...structuredClone(record.snapshot), note: 'x' };
  assert.equal(isPosTimestampOnlyDrift(extra, sources.posSourceFingerprint(extra), current), false, 'unknown field');
  const badBucketHash = structuredClone(record.snapshot);
  badBucketHash.rows[0].fingerprint = '0'.repeat(64);
  assert.equal(isPosTimestampOnlyDrift(badBucketHash, sources.posSourceFingerprint(badBucketHash), current), false, 'bucket hash');
  const inconsistent = structuredClone(record.snapshot);
  inconsistent.rows[0].snapshot.payments[0].receiptUpdatedAt = CHECKED_AT;
  assert.equal(isPosTimestampOnlyDrift(inconsistent, sources.posSourceFingerprint(inconsistent), current), false, 'detail/receipt timestamp');
  for (const snapshot of [null, 'x', [], { ...record.snapshot, rows: record.snapshot.rows.slice(0, 3) }])
    assert.equal(isPosTimestampOnlyDrift(snapshot, record.fingerprint, current), false);
});

function load(path, deps) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in deps, `Unexpected dependency ${name}`);
    return deps[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}
function view({ closed, current, revision = 1, role = 'owner', check = null, monthClosed = false }) {
  const record = closedRecord(closed);
  const closure = { id: 10, revision, close_method: 'manual', closed_at: '2026-10-21T23:30:00+07:00', closed_by: 55,
    source_snapshot: record.snapshot, source_fingerprint: record.fingerprint, actor: { name: 'HAN' } };
  const tables = { pos_sales_business_day_closures: closure, pos_sales_business_day_close_checks: check,
    ledger_month_closures: monthClosed ? { id: 1 } : null,
    ledger_transactions: closed.rows.filter(row => row.amount > 0).map(row => ({ source_key: 'pos:' + closed.businessDate + ':' + row.bucket,
      amount: row.amount, status: 'confirmed', source_fingerprint: row.fingerprint, movements: [{ amount: row.amount }] })) };
  const supabase = { from(table) {
    const query = { select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; },
      async maybeSingle() { return { data: tables[table], error: null }; },
      then(resolve, reject) { return Promise.resolve({ data: tables[table], error: null }).then(resolve, reject); } };
    return query;
  }, rpc() { assert.fail('view must never mutate the database'); } };
  const api = load('lib/sales/pos-business-day-final.ts', {
    'server-only': {}, '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { role } }) },
    '@/lib/supabase/server': { supabaseServer: supabase }, '@/lib/ledger/pos-sales': { loadPosBusinessDaySource: async () => current },
    './pos-business-day-close': { getPosBusinessDayManualCloseTime: async () => ({ allowed: true, closeAt: null, cutoffAt: '2026-10-22T03:00:00+07:00' }) },
    './pos-business-day-close-view': closeViewPolicy, './pos-business-day-final-workflow': workflow,
    './pos-business-day-refresh': { loadLatestPosSyncRun: async () => null }, './pos-business-day-final-policy': finalPolicy,
    '@/lib/ledger/pos-sales-source': sources, '@/lib/store-settings/business-time-adapter': {}, '@/lib/store-settings/business-time-core': businessTime,
    './pos-pending-payment': { loadPendingPaymentReceipts: async () => ({ count: 0, totalAmount: 0, receipts: [] }), loadPendingCloseHoldDates: async () => [] },
  });
  return { api, closure, before: structuredClone(closure) };
}
function render(status, lang) {
  const hooks = { ...React, useState(initial) { return [initial === null ? status : initial === true ? false : initial, () => {}]; },
    useEffect() {}, useCallback(fn) { return fn; } };
  const panel = load('components/sales/PosBusinessDayClosePanel.tsx', { react: hooks, 'react/jsx-runtime': jsxRuntime,
    '@/lib/language-context': { useLanguage: () => ({ lang }) }, '@/lib/text/sales-close': { salesCloseText },
    '@/lib/styles/ui': { ui: { subButton: {}, button: {} } },
    'next/link': { __esModule: true, default: ({ href, style, children }) => jsxRuntime.jsx('a', { href, style, children }) } });
  return renderToStaticMarkup(panel.default({ businessDate: status.businessDate, refreshKey: 0, onClosed: async () => {}, onBusyChange: () => {} }));
}

test('close view: timestamp-only days show the completed close without a reclose prompt (KO/VI)', async () => {
  for (const date of FALSE_ALARM_DATES) {
    const base = day(date), closed = build(date, base);
    const current = build(date, { ...base, receipts: touch(base.receipts, [1, 2]) });
    // 10/17 and 10/20 already carry rev2; comparison uses the latest revision and leaves it untouched.
    const revision = ['2026-10-17', '2026-10-20'].includes(date) ? 2 : 1;
    const { api, closure, before } = view({ closed, current, revision });
    const status = await api.getPosBusinessDayCloseView(date, new Date('2026-10-23T09:00:00+07:00'));
    assert.equal(status.timestampOnlyDrift, true, date);
    assert.equal(status.drift, false, date);
    assert.equal(status.canReclose, false, date);
    assert.equal(status.needsOwnerReview, false, date);
    assert.equal(status.latestClose.revision, revision);
    assert.equal(status.latestClose.fingerprint, closed.sourceFingerprint);
    assert.equal(status.ledgerProjection.status, 'matches_close');
    assert.deepEqual(closure, before);
    for (const lang of ['ko', 'vi']) {
      const html = render(status, lang);
      assert.ok(html.includes(salesCloseText[lang].closed), `${date} ${lang}`);
      assert.ok(!html.includes(salesCloseText[lang].recloseReview), `${date} ${lang}`);
      assert.ok(!html.includes('role="alert"'), `${date} ${lang}`);
    }
  }
});

test('close view: an existing 03:05 metadata_changed_only check still shows its message', async () => {
  const date = '2026-10-20', base = day(date), closed = build(date, base);
  const current = build(date, { ...base, receipts: touch(base.receipts, [3]) });
  const check = { id: 20, closure_id: 10, result: 'metadata_changed_only', checked_at: '2026-10-21T03:05:00+07:00', closed_total: 1_000_000,
    current_total: 1_000_000, total_delta: 0, closed_buckets: null, current_buckets: null, bucket_delta: null };
  const status = await view({ closed, current, revision: 2, check }).api.getPosBusinessDayCloseView(date, new Date('2026-10-23T09:00:00+07:00'));
  assert.equal(status.latestFinalCheck.result, 'metadata_changed_only');
  assert.ok(render(status, 'ko').includes(salesCloseText.ko.metadata));
});

test('close view: October 21 keeps the drift warning and owner reclose, managers get owner review, month close still blocks', async () => {
  const { date, closed, current } = october21();
  const now = new Date('2026-10-23T09:00:00+07:00');
  const owner = await view({ closed, current }).api.getPosBusinessDayCloseView(date, now);
  assert.equal(owner.timestampOnlyDrift, false);
  assert.equal(owner.drift, true);
  assert.equal(owner.canReclose, true);
  assert.equal(owner.delta.total, 75_000);
  assert.equal(owner.latestClose.totals.total, 25_503_200);
  const html = render(owner, 'ko');
  assert.ok(html.includes(salesCloseText.ko.drift) && html.includes(salesCloseText.ko.recloseReview));
  const manager = await view({ closed, current, role: 'manager' }).api.getPosBusinessDayCloseView(date, now);
  assert.equal(manager.canReclose, false);
  assert.equal(manager.needsOwnerReview, true);
  const locked = await view({ closed, current, monthClosed: true }).api.getPosBusinessDayCloseView(date, now);
  assert.equal(locked.canReclose, false);
  assert.equal(locked.drift, true);
});

test('close status helper agrees with the view for timestamp-only drift', () => {
  const date = '2026-09-25', base = day(date), closed = build(date, base);
  const current = build(date, { ...base, receipts: touch(base.receipts, [2]) });
  const record = closedRecord(closed);
  assert.deepEqual(closePolicy.comparePosClosedSource(current, record.snapshot, record.fingerprint),
    { isClosed: true, drift: false, timestampOnlyDrift: true, totalDelta: 0, bucketDeltas: { cash: 0, transfer: 0, card: 0, other: 0 } });
});
