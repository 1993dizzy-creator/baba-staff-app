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
  const fee = { month: '2026-10', monthClosed: true, autoStatus: 'pending', historicalConfirmedFee: 0, monthEndFee: 0, currentOutstanding: 5699112, projectedTotalFee: 5699112, finalConfirmedFee: null, remainingRate: 5699112 / 192125640, confirmedRate: null, closure: null, estimate: october(), ...props };
  const html = renderToStaticMarkup(React.createElement(mod.exports.default, { fee, lang }));
  return { html, requests };
}
const BANNED = /자동 확정 대기|익월 카드입금 처리 중 자동 확정됩니다|공식 확정 전에 수기 전표를 취소|Chờ xác nhận tự động|Cần hủy bút toán thủ công/;

test('October renders one compact card: two KPIs, one-line warning, provisional status chips and a 3-row table', () => {
  const { html, requests } = renderAnalysis('ko');
  // KPIs: estimated fee and rate only.
  const has = fragment => assert.ok(html.includes(fragment), fragment);
  has('<span>추정 수수료</span><strong>5.699.112 ₫</strong>');
  has('<span>수수료율</span><strong>2.97%</strong><small class="kpiNote">참고 1.80%~2.50%</small>');
  has('⚠️ 참고 범위 초과 · 목표 대비 +1.568.411 ₫');
  for (const chip of ['🧾 잠정 비용 처리 #4119', '🛡️ 자동 중복 확정 보호', '⏳ 공식 확정 미완료']) has(chip);
  // Units and titles once in the header; rows carry bare numbers.
  has('<thead><tr><th scope="col">기준</th><th scope="col">예상 수수료(₫)</th><th scope="col">차액(₫)</th></tr></thead>');
  assert.equal((html.match(/<tr/g) || []).length, 4);
  has('<th scope="row">최소 1.80%</th><td>3.458.262</td><td>+2.240.850</td>');
  has('<tr class="feeTableTarget"><th scope="row">목표 2.15%</th><td>4.130.701</td><td>+1.568.411</td>');
  has('<th scope="row">최대 2.50%</th><td>4.803.141</td><td>+895.971</td>');
  // Breakdown and manual voucher sit in a collapsed details element.
  has('<details class="feeDetails"><summary>세부 내역 · 수기 전표</summary>');
  assert.doesNotMatch(html, /<details[^>]* open/);
  for (const label of ['192.125.640 ₫', '수기 비용 전표 #4119', '└ 남은 미반영 추정액']) assert.ok(html.slice(html.indexOf('<details')).includes(label), label);
  assert.doesNotMatch(html, BANNED);
  // POS review stays collapsed and silent.
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /id="card-fee-receipt-review"/);
  assert.equal(requests.length, 0, 'rendering never fetches candidates');
});

test('confirmed and plain pending months use the same compact card', () => {
  const confirmed = renderAnalysis('ko', { closure: { confirmed_at: '2026-10-08T05:00:00Z', finalization_business_date: '2026-10-08' }, finalConfirmedFee: 4332575, monthEndFee: 4332575, currentOutstanding: 0,
    estimate: { ...october(), currentEstimate: 4332575, confirmedFee: 4332575, unconfirmedEstimate: 0, rate: 0.0239, rangeStatus: 'within', manualExpenses: [], manualExpenseTotal: 0, provisionalManualOnly: false } }).html;
  assert.ok(confirmed.includes('<span>확정 수수료</span><strong>4.332.575 ₫</strong>'));
  assert.ok(confirmed.includes('✅ 공식 확정') && confirmed.includes('>자동<'));
  assert.doesNotMatch(confirmed, /⚠️|잠정 비용 처리/);
  const pending = renderAnalysis('ko', { estimate: { ...october(), currentEstimate: 4000000, rate: 0.0208, rangeStatus: 'within', manualExpenses: [], manualExpenseTotal: 0, provisionalManualOnly: false } }).html;
  for (const chip of ['⏳ 공식 확정 미완료', '🔒 장부 마감', '다음 카드입금 때 자동 확정 대상']) assert.ok(pending.includes(chip), chip);
  assert.doesNotMatch(pending, /⚠️|잠정 비용 처리|수기 비용 전표/);
});

test('Vietnamese card has no Korean text and no banned wording', () => {
  const { html } = renderAnalysis('vi');
  for (const label of ['Phí ước tính', 'Vượt khoảng tham chiếu', 'Đã ghi chi phí tạm tính #4119', 'Chặn xác nhận tự động trùng', 'Chưa xác nhận chính thức', 'Phí dự kiến (₫)', 'Mục tiêu 2.15%', 'Hóa đơn POS cần xem xét'])
    assert.ok(html.includes(label), label);
  // The voucher memo is stored ledger data (shown as entered); every UI label is Vietnamese.
  assert.ok(html.includes('#4119 [잠정 추정·추후 정산검증]'));
  assert.doesNotMatch(html.replace('[잠정 추정·추후 정산검증]', ''), /[가-힣]/);
  assert.doesNotMatch(html, BANNED);
});
