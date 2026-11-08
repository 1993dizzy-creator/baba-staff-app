// 일간매출현황 1차 리뉴얼: server phase drives the 영업중 / 마감 하기 display; the browser never decides canClose.
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
import { salesText } from '../lib/text/sales.ts';

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
const source = (amount = 100_000) => sources.buildPosBusinessDaySource(businessDate, [{ id: 1, ref_no: 'receipt', business_date: businessDate,
  ref_date: null, payment_status: 3, is_canceled: false, final_amount: amount, revision: 1, updated_at: null }],
[{ id: 1, receipt_id: 1, business_date: businessDate, payment_type: 9, payment_name: 'khac', card_name: null, amount }]);
const noPending = { count: 0, totalAmount: 0, receipts: [] };
const serverClient = 'supa' + 'base';
function service(time, closure = null) {
  const closed = source();
  const row = closure && { id: 10, revision: 1, close_method: 'manual', closed_at: closure, closed_by: 55,
    source_snapshot: closed.sourceSnapshot, source_fingerprint: closed.sourceFingerprint, actor: { name: 'HAN' } };
  const tables = { pos_sales_business_day_closures: row, pos_sales_business_day_close_checks: null, ledger_month_closures: null,
    ledger_transactions: closure ? closed.rows.filter(r => r.amount > 0).map(r => ({ source_key: 'pos:' + businessDate + ':' + r.bucket,
      amount: r.amount, status: 'confirmed', source_fingerprint: r.fingerprint, movements: [{ amount: r.amount }] })) : [] };
  const client = { from(table) { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: tables[table], error: null }),
    then: (resolve, reject) => Promise.resolve({ data: tables[table], error: null }).then(resolve, reject) }; return q; },
  rpc() { assert.fail('view must never mutate the database'); } };
  return load('lib/sales/pos-business-day-final.ts', {
    'server-only': {}, '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { role: 'owner' } }) },
    [`@/lib/${serverClient}/server`]: { [`${serverClient}Server`]: client }, '@/lib/ledger/pos-sales': { loadPosBusinessDaySource: async () => source() },
    './pos-business-day-close': { getPosBusinessDayManualCloseTime: async () => time },
    './pos-business-day-close-view': closeViewPolicy, './pos-business-day-final-workflow': workflow,
    './pos-business-day-refresh': { loadLatestPosSyncRun: async () => null }, './pos-business-day-final-policy': finalPolicy,
    '@/lib/ledger/pos-sales-source': sources, '@/lib/store-settings/business-time-adapter': {},
    '@/lib/store-settings/business-time-core': businessTime,
    './pos-pending-payment': { loadPendingPaymentReceipts: async () => noPending, loadPendingCloseHoldDates: async () => [] },
  });
}
const timeFor = (phase, allowed = phase === 'closeable' || phase === 'past') => ({ allowed,
  reason: phase === 'past' ? 'past_business_date' : phase === 'future' ? 'future_business_date' : 'manual_close_time', phase,
  openAt: phase === 'hours_unavailable' ? null : '2026-10-06T16:00:00+07:00', manualCloseAt: '2026-10-07T00:00:00+07:00',
  closeAt: '2026-10-07T01:00:00+07:00', cutoffAt: '2026-10-07T03:00:00+07:00' });
function render(view, lang = 'ko') {
  const hooks = { ...React,
    useState(initial) { return [initial === null ? view : initial === true ? false : initial, () => {}]; },
    useEffect() {}, useCallback(fn) { return fn; },
  };
  const panel = load('components/sales/PosBusinessDayClosePanel.tsx', {
    react: hooks, 'react/jsx-runtime': jsxRuntime,
    '@/lib/language-context': { useLanguage: () => ({ lang }) },
    '@/lib/text/sales-close': { salesCloseText }, '@/lib/styles/ui': { ui: { subButton: {}, button: {} } },
    'next/link': { __esModule: true, default: ({ href, style, children }) => jsxRuntime.jsx('a', { href, style, children }) },
  });
  return renderToStaticMarkup(panel.default({ businessDate, refreshKey: 0, onClosed: async () => {}, onBusyChange: () => {} }));
}
const view = async (phase, now = '2026-10-06T20:00:00+07:00', closure = null) => service(timeFor(phase), closure).getPosBusinessDayCloseView(businessDate, new Date(now));
const green = /background:#166534;color:#fff/;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('status contract carries the server phase, open time, 00:00 manual close time and server clock', async () => {
  const v = await view('open');
  assert.equal(v.businessPhase, 'open');assert.equal(v.canClose, false);assert.equal(v.closeEligibilityReason, 'manual_close_time');
  assert.equal(v.openAt, '2026-10-06T16:00:00+07:00');assert.equal(v.manualCloseAt, '2026-10-07T00:00:00+07:00');
  assert.equal(v.serverNow, new Date('2026-10-06T20:00:00+07:00').toISOString());
  const c = await view('closeable', '2026-10-07T00:00:00+07:00');
  assert.equal(c.businessPhase, 'closeable');assert.equal(c.canClose, true);
  const closed = await view('closeable', '2026-10-07T00:11:00+07:00', '2026-10-07T00:10:00+07:00');
  assert.equal(closed.businessPhase, 'closed');assert.equal(closed.canClose, false);
});

for (const lang of ['ko', 'vi']) {
  const t = salesCloseText[lang];
  test(`${lang}: open before 00:00 shows a green 영업중 status only, with right-aligned close-time text`, async () => {
    const html = render(await view('open'), lang);
    assert.match(html, new RegExp(`<div role="status" data-testid="pos-close-open" style="[^"]*background:#166534;color:#fff[^"]*">${esc(t.open)}</div>`));
    assert.ok(!html.includes(t.openCloseNow));assert.ok(!html.includes('<button'), 'no close action while open');
    assert.match(html, new RegExp(`text-align:right">${esc(t.beforeClose)}</p>`));
  });
  test(`${lang}: from 00:00 it becomes 영업중 (마감 하기 🌙), clickable only when the server canClose`, async () => {
    const enabled = render(await view('closeable', '2026-10-07T00:00:00+07:00'), lang);
    assert.match(enabled, new RegExp(`<button data-testid="pos-close-open-closeable" style="[^"]*background:#166534;color:#fff[^"]*">${esc(t.openCloseNow)}</button>`));
    const style = enabled.match(/data-testid="pos-close-open-closeable" style="([^"]*)"/)[1];
    assert.match(style, /opacity:1/);assert.match(style, /cursor:pointer/);assert.ok(!/disabled/.test(enabled.match(/<button data-testid="pos-close-open-closeable"[^>]*>/)[0]));
    const blocked = render({ ...(await view('closeable', '2026-10-07T00:00:00+07:00')), canClose: false, closeEligibilityReason: 'forbidden' }, lang);
    assert.match(blocked, /data-testid="pos-close-open-closeable"[^>]*disabled=""/);assert.ok(blocked.includes(t.forbidden));
  });
  test(`${lang}: before open, unknown hours and future dates never show 영업중; past dates keep the plain close button`, async () => {
    for (const phase of ['before_open', 'hours_unavailable', 'future']) {
      const html = render(await view(phase, '2026-10-06T10:00:00+07:00'), lang);
      assert.ok(!html.includes(t.openCloseNow) && !green.test(html), phase);
      assert.match(html, new RegExp(`disabled="">${esc(t.close)}</button>`), phase);
    }
    const past = render(await view('past', '2026-10-07T05:00:00+07:00'), lang);
    assert.ok(!green.test(past));assert.match(past, new RegExp(`<button[^>]*>${esc(t.close)}</button>`));assert.ok(!/<button[^>]*disabled/.test(past));
  });
}

test('closed day keeps the completed status; close metadata (method · actor · time) is right aligned', async () => {
  const html = render(await view('closeable', '2026-10-07T00:11:00+07:00', '2026-10-07T00:10:00+07:00'));
  assert.ok(html.includes(salesCloseText.ko.closed));assert.ok(!green.test(html));
  assert.match(html, new RegExp(`text-align:right">${esc(salesCloseText.ko.manual)} · HAN · `));
});

test('panel re-reads the server status at the next boundary and reports the live state; sales KPIs follow it', () => {
  const panel = readFileSync('components/sales/PosBusinessDayClosePanel.tsx', 'utf8');
  assert.match(panel, /\[status\.openAt,status\.manualCloseAt,status\.finalSync\?\.cutoffAt\]/);
  assert.match(panel, /setTimeout\(\(\)=>\{void load\(\);\}/, 'a boundary only triggers a server re-read');
  assert.match(panel, /const live=!loading&&!!status&&\(phase==='open'\|\|phase==='closeable'\)/);
  assert.match(panel, /disabled=\{!status\.canClose\|\|busy\|\|disabled\} onClick=\{\(\)=>setConfirmInitialClose\(true\)\}>\{busy\?t\.working:t\.openCloseNow\}/);
  assert.ok(!/cukcuk/i.test(panel), 'no browser CUKCUK call');
  const page = readFileSync('app/(protected)/admin/sales/page.tsx', 'utf8');
  assert.match(page, /onLiveChange=\{setIsLiveBusinessDay\}/);
  assert.match(page, /const kpiPrefix = isLiveBusinessDay \? dailyText\.currentPrefix : ""/);
  for (const key of ['totalSales', 'receipts', 'soldItems', 'averageReceiptAmount']) assert.match(page, new RegExp(`kpiPrefix \\+ dailyText\\.${key}`));
  assert.equal((page.match(/meta: paidBaseMeta,/g) || []).length, 2);
  assert.equal(salesText.ko.daily?.currentPrefix ?? findKey(salesText.ko, 'currentPrefix'), '현재 ');
  assert.equal(findKey(salesText.vi, 'openOrdersExcluded'), 'chưa gồm đơn đang mở');
  assert.equal(findKey(salesText.ko, 'openOrdersExcluded'), '진행 주문 미포함');
});
function findKey(obj, key) { if (obj && typeof obj === 'object') { if (key in obj) return obj[key]; for (const v of Object.values(obj)) { const r = findKey(v, key); if (r !== undefined) return r; } } return undefined; }
