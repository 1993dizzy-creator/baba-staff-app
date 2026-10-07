import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as closeViewPolicy from '../lib/sales/pos-business-day-close-view.ts';
import * as finalPolicy from '../lib/sales/pos-business-day-final-policy.ts';
import * as workflow from '../lib/sales/pos-business-day-final-workflow.ts';
import * as sources from '../lib/ledger/pos-sales-source.ts';
import * as businessTime from '../lib/store-settings/business-time-core.ts';
import { salesCloseText } from '../lib/text/sales-close.ts';

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

const businessDate = '2026-10-06';
function source(amount = 100_000) {
  return sources.buildPosBusinessDaySource(businessDate, [{ id: 1, ref_no: 'receipt', business_date: businessDate,
    ref_date: null, payment_status: 3, is_canceled: false, final_amount: amount, revision: 1, updated_at: null }],
  [{ id: 1, receipt_id: 1, business_date: businessDate, payment_type: 9, payment_name: 'khac', card_name: null, amount }]);
}
function service({ closedAt = '2026-10-06T23:30:00+07:00', method = 'manual', check = null, drift = false, closureMissing = false } = {}) {
  const closed = source(), current = drift ? source(110_000) : closed;
  const closure = closureMissing ? null : { id: 10, revision: 1, close_method: method, closed_at: closedAt, closed_by: 55,
    source_snapshot: closed.sourceSnapshot, source_fingerprint: closed.sourceFingerprint, actor: { name: 'HAN' } };
  const tables = {
    pos_sales_business_day_closures: closure,
    pos_sales_business_day_close_checks: check,
    ledger_month_closures: null,
    ledger_transactions: closed.rows.filter(row => row.amount > 0).map(row => ({ source_key: 'pos:' + businessDate + ':' + row.bucket,
      amount: row.amount, status: 'confirmed', source_fingerprint: row.fingerprint, movements: [{ amount: row.amount }] })),
  };
  const supabase = {
    from(table) {
      assert.ok(table in tables);
      const query = { select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; },
        async maybeSingle() { return { data: tables[table], error: null }; },
        then(resolve, reject) { return Promise.resolve({ data: tables[table], error: null }).then(resolve, reject); },
      };
      return query;
    },
    rpc() { assert.fail('view must never mutate the database'); },
  };
  return load('lib/sales/pos-business-day-final.ts', {
    'server-only': {}, '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { role: 'owner' } }) },
    '@/lib/supabase/server': { supabaseServer: supabase }, '@/lib/ledger/pos-sales': { loadPosBusinessDaySource: async () => current },
    './pos-business-day-close': { getPosBusinessDayManualCloseTime: async () => ({ allowed: true, closeAt: '2026-10-07T01:00:00+07:00', cutoffAt: '2026-10-07T03:00:00+07:00' }) },
    './pos-business-day-close-view': closeViewPolicy, './pos-business-day-final-workflow': workflow,
    './pos-business-day-refresh': { loadLatestPosSyncRun: async () => null }, './pos-business-day-final-policy': finalPolicy,
    '@/lib/ledger/pos-sales-source': sources, '@/lib/store-settings/business-time-adapter': {},
    '@/lib/store-settings/business-time-core': businessTime,
  });
}
const checkRow = (result, overrides = {}) => ({ id: 20, closure_id: 10, result, checked_at: '2026-10-07T03:05:00+07:00',
  closed_total: 100_000, current_total: 100_000, total_delta: 0, closed_buckets: null, current_buckets: null, bucket_delta: null, ...overrides });
function render(view) {
  const hooks = { ...React,
    useState(initial) { return [initial === null ? view : initial === true ? false : initial, () => {}]; },
    useEffect() {}, useCallback(fn) { return fn; },
  };
  const panel = load('components/sales/PosBusinessDayClosePanel.tsx', {
    react: hooks, 'react/jsx-runtime': jsxRuntime,
    '@/lib/language-context': { useLanguage: () => ({ lang: 'ko' }) },
    '@/lib/text/sales-close': { salesCloseText }, '@/lib/styles/ui': { ui: { subButton: {}, button: {} } },
  });
  return renderToStaticMarkup(panel.default({ businessDate, refreshKey: 0, onClosed: async () => {}, onBusyChange: () => {} }));
}

test('early manual closure without a check awaits the upcoming scheduled final at 03:05', async () => {
  const view = await service().getPosBusinessDayCloseView(businessDate, new Date('2026-10-06T23:31:00+07:00'));
  assert.equal(view.finalCheckPending, true);
  assert.equal(view.latestFinalCheck, null);
  assert.ok(render(view).includes(salesCloseText.ko.pending));
});

test('late historical manual closure displays completed metadata without pending or a new warning', async () => {
  const view = await service({ closedAt: '2026-10-07T23:26:00+07:00' }).getPosBusinessDayCloseView(businessDate, new Date('2026-10-07T23:27:00+07:00'));
  assert.equal(view.finalCheckPending, false);
  const html = render(view);
  assert.ok(html.includes(salesCloseText.ko.closed));
  assert.ok(html.includes('HAN'));
  assert.ok(html.includes(salesCloseText.ko.manual));
  assert.ok(!html.includes(salesCloseText.ko.pending));
  assert.ok(!html.includes('role="alert"'));
});

test('October 6 failure before closure with null closure_id is not the later manual closure check', async () => {
  const view = await service({ closedAt: '2026-10-07T23:26:00+07:00',
    check: checkRow('source_invalid', { closure_id: null }) }).getPosBusinessDayCloseView(businessDate, new Date('2026-10-07T23:27:00+07:00'));
  assert.equal(view.latestFinalCheck, null);
  assert.equal(view.finalCheckPending, false);
  const html = render(view);
  assert.ok(html.includes(salesCloseText.ko.closed));
  assert.ok(!html.includes(salesCloseText.ko.pending));
  assert.ok(!html.includes(salesCloseText.ko.checkFailed));
});

test('automatic closure with verified_unchanged retains the existing quiet completed UI', async () => {
  const view = await service({ method: 'automatic', closedAt: '2026-10-07T03:05:00+07:00', check: checkRow('verified_unchanged') })
    .getPosBusinessDayCloseView(businessDate, new Date('2026-10-07T03:06:00+07:00'));
  assert.equal(view.latestFinalCheck.result, 'verified_unchanged');
  assert.equal(view.finalCheckPending, false);
  const html = render(view);
  assert.ok(html.includes(salesCloseText.ko.closed));
  assert.ok(html.includes(salesCloseText.ko.automatic));
  assert.ok(!html.includes(salesCloseText.ko.pending));
  assert.ok(!html.includes(salesCloseText.ko.checkFailed));
});

test('manual closure with an actual financial drift check keeps drift and reclose UI', async () => {
  const view = await service({ drift: true, check: checkRow('financial_drift', { total_delta: 10_000, current_total: 110_000 }) })
    .getPosBusinessDayCloseView(businessDate, new Date('2026-10-07T03:06:00+07:00'));
  assert.equal(view.latestFinalCheck.result, 'financial_drift');
  assert.equal(view.finalCheckPending, false);
  assert.equal(view.canReclose, true);
  const html = render(view);
  assert.ok(html.includes(salesCloseText.ko.drift));
  assert.ok(html.includes(salesCloseText.ko.recloseReview));
  assert.ok(!html.includes(salesCloseText.ko.pending));
});

for (const [result, text] of [['metadata_changed_only', salesCloseText.ko.metadata], ['source_invalid', salesCloseText.ko.sourceInvalid],
  ['sync_failed', salesCloseText.ko.syncFailed], ['month_closed', salesCloseText.ko.monthClosed]]) {
  test(`current closure ${result} check keeps its existing message`, async () => {
    const view = await service({ check: checkRow(result) }).getPosBusinessDayCloseView(businessDate, new Date('2026-10-07T03:06:00+07:00'));
    assert.equal(view.latestFinalCheck.result, result);
    assert.equal(view.finalCheckPending, false);
    assert.ok(render(view).includes(text));
  });
}

test('pending ends at the cron schedule, not the store closing time or 03:00 cutoff', async () => {
  const api = service();
  for (const [now, pending] of [['2026-10-07T03:00:00+07:00', true], ['2026-10-07T03:04:59+07:00', true],
    ['2026-10-07T03:05:00+07:00', false], ['2026-10-07T03:05:01+07:00', false]]) {
    assert.equal((await api.getPosBusinessDayCloseView(businessDate, new Date(now))).finalCheckPending, pending);
  }
});

test('unrelated closure checks are excluded; null-id failures after the closure remain applicable', async () => {
  const now = new Date('2026-10-07T03:06:00+07:00');
  assert.equal((await service({ check: checkRow('sync_failed', { closure_id: 9 }) }).getPosBusinessDayCloseView(businessDate, now)).latestFinalCheck, null);
  assert.equal((await service({ check: checkRow('sync_failed', { closure_id: null }) }).getPosBusinessDayCloseView(businessDate, now)).latestFinalCheck.result, 'sync_failed');
});

test('no closure and malformed or future closure times do not claim a pending check', () => {
  const policy = closeViewPolicy.isPosFinalCheckPending;
  const args = { businessDate, latestClose: null, hasFinalCheck: false, now: new Date('2026-10-06T23:31:00+07:00') };
  assert.equal(policy(args), false);
  for (const closedAt of ['invalid', '2026-10-06T23:32:00+07:00']) assert.equal(policy({ ...args, latestClose: { method: 'manual', closedAt } }), false);
});

test('03:05 cron on October 8 still targets October 7 independently of the late October 6 manual closure', async () => {
  const dates = [];
  const now = new Date('2026-10-08T03:05:00+07:00');
  const api = load('lib/sales/pos-business-day-final.ts', {
    'server-only': {}, '@/lib/auth/server-auth': {}, '@/lib/supabase/server': {}, '@/lib/ledger/pos-sales': {},
    './pos-business-day-close-view': closeViewPolicy,
    './pos-business-day-close': { resolvePosCloseSystemActor: async () => ({ id: 2 }), getPosBusinessDayCloseTime: async date => {
      dates.push(date); return { allowed: true, cutoffAt: '2026-10-08T03:00:00+07:00' };
    } },
    './pos-business-day-final-workflow': { runPosFinalWorkflow: async args => { assert.equal(args.date, '2026-10-07'); return { status: 'verified_unchanged' }; } },
    './pos-business-day-refresh': {}, './pos-business-day-final-policy': finalPolicy, '@/lib/ledger/pos-sales-source': sources,
    '@/lib/store-settings/business-time-adapter': { loadBusinessTimeAdapter: async () => ({ databaseBusinessDate: '2026-10-08', snapshot: { isFallback: false } }) },
    '@/lib/store-settings/business-time-core': businessTime,
  });
  assert.equal((await api.finalizePreviousPosBusinessDay('https://local.test', now)).status, 'verified_unchanged');
  assert.deepEqual(dates, ['2026-10-07']);
  const cron = JSON.parse(readFileSync('vercel.json', 'utf8')).crons.find(row => row.path === '/api/cron/sales-close-final');
  assert.equal(cron.schedule, '5 20 * * *');
});
