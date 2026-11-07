import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const { buildCardFeeEstimate } = require('../lib/ledger/card-fee-estimate.ts');
const { rankCardReceiptCandidates } = require('../lib/ledger/card-fee-receipt-candidates.ts');
const componentPath = 'app/(protected)/admin/ledger/card-settlements/CardFeeAnalysis.tsx';
const pagePath = 'app/(protected)/admin/ledger/card-settlements/page.tsx';
const routePath = 'app/api/admin/ledger/card-fees/receipt-candidates/route.ts';
const feeRoutePath = 'app/api/admin/ledger/card-fees/route.ts';

// October 2026 as booked: no official closure, provisional manual voucher #4119, month closed.
const october = () => buildCardFeeEstimate({
  monthCardGross: 192125640, currentOutstanding: 5699112, historicalConfirmedFee: 0, monthEndFee: 0,
  hasClosure: false, manualExpenses: [{ id: 4119, amount: 5699112, memo: '[잠정 추정·추후 정산검증]' }],
});

test('October estimate keeps the provisional voucher apart from an official confirmation', () => {
  const e = october();
  assert.equal(e.gross, 192125640);
  assert.equal(e.confirmedFee, 0);
  assert.equal(e.unconfirmedEstimate, 5699112);
  assert.equal(e.currentEstimate, 5699112);
  assert.equal(e.rate.toFixed(6), (5699112 / 192125640).toFixed(6));
  assert.equal(e.rangeStatus, 'above');
  assert.deepEqual(e.scenarios.map(s => [s.key, s.expectedFee, s.difference]), [
    ['min', 3458262, 2240850], ['target', 4130701, 1568411], ['max', 4803141, 895971],
  ]);
  assert.equal(e.manualExpenseTotal, 5699112);
  assert.equal(e.manualCoveredEstimate, 5699112);
  assert.equal(e.unrecognizedEstimate, 0, 'the manual voucher already covers the whole remainder: nothing more to book');
  assert.equal(e.provisionalManualOnly, true);
  assert.equal(e.duplicateRisk, false);
});

test('confirmed closure, in-range rate and duplicate manual expense are classified separately', () => {
  const confirmed = buildCardFeeEstimate({ monthCardGross: 200000000, currentOutstanding: 0, historicalConfirmedFee: 1000000, monthEndFee: 3300000, hasClosure: true, manualExpenses: [] });
  assert.equal(confirmed.confirmedFee, 4300000);
  assert.equal(confirmed.unconfirmedEstimate, 0);
  assert.equal(confirmed.rangeStatus, 'within');
  assert.equal(confirmed.scenarios.find(s => s.key === 'target').difference, 0);
  assert.equal(confirmed.provisionalManualOnly, false);
  // Comparison data still exists inside the range.
  assert.equal(confirmed.scenarios.length, 3);
  const dup = buildCardFeeEstimate({ monthCardGross: 200000000, currentOutstanding: 0, historicalConfirmedFee: 0, monthEndFee: 4300000, hasClosure: true, manualExpenses: [{ id: 1, amount: 4300000, memo: null }] });
  assert.equal(dup.duplicateRisk, true);
  // Without a closure the month-end fee is not counted as confirmed.
  const pending = buildCardFeeEstimate({ monthCardGross: 100000000, currentOutstanding: 1000000, historicalConfirmedFee: 0, monthEndFee: 999, hasClosure: false, manualExpenses: [] });
  assert.equal(pending.confirmedFee, 0);
  assert.equal(pending.rangeStatus, 'below');
  assert.equal(buildCardFeeEstimate({ monthCardGross: 0, currentOutstanding: 0, historicalConfirmedFee: 0, monthEndFee: 0, hasClosure: false, manualExpenses: [] }).rangeStatus, 'no_sales');
});

const receipt = (id, date, finalAmount, extra = {}) => ({ id, ref_no: `R${id}`, business_date: date, ref_date: `${date}T20:00:00`, payment_status: 3, is_canceled: false, final_amount: finalAmount, ...extra });
const pay = (id, receiptId, date, amount, name = 'VISA') => ({ id, receipt_id: receiptId, business_date: date, payment_type: name === 'Tiền mặt' ? 1 : 2, payment_name: name, card_name: name === 'Tiền mặt' ? null : name, amount: String(amount) });

test('candidates rank by card payment amount, not receipt total, and compare POS with the ledger day', () => {
  const receipts = [
    receipt(1, '2026-10-18', 1569100), receipt(2, '2026-10-20', 1575000),
    receipt(3, '2026-10-21', 3000000), // split: 1,568,000 card + cash
    receipt(4, '2026-10-22', 1568411, { payment_status: 4, is_canceled: true }),
    receipt(5, '2026-10-23', 1568411), // cash only: never a card candidate
    receipt(6, '2026-10-24', 900000), receipt(7, '2026-10-25', 100000),
  ];
  const payments = [
    pay(11, 1, '2026-10-18', 1569100), pay(12, 2, '2026-10-20', 1575000),
    pay(13, 3, '2026-10-21', 1568000), pay(14, 3, '2026-10-21', 1432000, 'Tiền mặt'),
    pay(15, 4, '2026-10-22', 1568411), pay(16, 5, '2026-10-23', 1568411, 'Tiền mặt'),
    pay(17, 6, '2026-10-24', 900000), pay(18, 7, '2026-10-25', 100000),
  ];
  const ledgerDays = [
    { business_date: '2026-10-18', amount: 1569100 }, { business_date: '2026-10-20', amount: 1500000 },
    { business_date: '2026-10-21', amount: 1568000 }, { business_date: '2026-10-24', amount: 900000 },
  ];
  const rows = rankCardReceiptCandidates({ target: 1568411, receipts, payments, ledgerDays });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.receiptId), [4, 3, 1, 2, 6]);
  assert.ok(!rows.some(r => r.receiptId === 5), 'cash payment never becomes a card candidate');
  const split = rows.find(r => r.receiptId === 3);
  assert.equal(split.cardAmount, 1568000);
  assert.equal(split.receiptFinalAmount, 3000000);
  assert.equal(split.distance, 411);
  assert.deepEqual([rows[0].posStatus, rows[0].ledgerStatus], ['canceled', 'excluded']);
  assert.equal(rows.find(r => r.receiptId === 1).ledgerStatus, 'reflected');
  const mismatch = rows.find(r => r.receiptId === 2);
  assert.deepEqual([mismatch.ledgerStatus, mismatch.posDayCardAmount, mismatch.ledgerDayAmount], ['day_mismatch', 1575000, 1500000]);
  const missing = rankCardReceiptCandidates({ target: 100000, receipts, payments, ledgerDays, limit: 1 })[0];
  assert.deepEqual([missing.receiptId, missing.ledgerStatus], [7, 'ledger_missing']);
});

test('analysis APIs are read-only and candidates load only from the opened panel', () => {
  const route = readFileSync(routePath, 'utf8');
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  const feeRoute = readFileSync(feeRoutePath, 'utf8');
  assert.match(feeRoute, /buildCardFeeEstimate\(/);
  assert.match(feeRoute, /\.eq\("source_type", "manual"\)/);
  const page = readFileSync(pagePath, 'utf8');
  assert.doesNotMatch(page, /receipt-candidates/, 'the page load never requests candidates');
  const component = readFileSync(componentPath, 'utf8');
  assert.doesNotMatch(component, /useEffect|method:/);
  assert.match(component, /const toggle = \(\) => \{ const next = !open; setOpen\(next\); if \(next\) void lookup\(scenario\); \};/);
});

function renderAnalysis(lang, props = {}) {
  const requests = [];
  const code = ts.transpileModule(readFileSync(componentPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const deps = { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), './card-settlements.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', code)(name => { assert.ok(name in deps, `Unexpected import ${name}`); return deps[name]; }, mod, mod.exports, url => { requests.push(url); throw new Error('no network'); });
  const html = renderToStaticMarkup(React.createElement(mod.exports.default, { estimate: october(), month: '2026-10', lang, monthClosed: true, hasClosure: false, ...props }));
  return { html, requests };
}

test('October analysis renders the provisional notice and a collapsed review panel in Korean', () => {
  const { html, requests } = renderAnalysis('ko');
  for (const label of ['수수료 추정 분석', '192.125.640 ₫', '5.699.112 ₫', '2.97%', '확정 수수료', '미확정 추정액', '수기 비용 처리 #4119',
    '전표 #4119는 잠정 수기 비용입니다. 공식 카드수수료 확정 기록이 아닙니다.', '장부 마감 완료 · 공식 카드수수료 확정 기록 없음',
    '참고 범위(1.80%~2.50%)를 넘습니다', '최소 1.80%', '목표 2.15%', '최대 2.50%', '4.130.701 ₫', '+1.568.411 ₫', '+2.240.850 ₫', '+895.971 ₫', 'POS 영수증 검토 후보'])
    assert.ok(html.includes(label), label);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /id="card-fee-receipt-review"|검토 후보<\/span>/);
  assert.equal(requests.length, 0, 'rendering never fetches candidates');
});

test('Vietnamese analysis has no Korean text', () => {
  const { html } = renderAnalysis('vi');
  for (const label of ['Phân tích phí thẻ ước tính', 'Bút toán #4119 là chi phí thủ công tạm tính', 'Mục tiêu 2.15%', 'Hóa đơn POS cần xem xét', 'Đã chốt sổ'])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /[가-힣]/);
});
