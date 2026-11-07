import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const { buildCardFeeEstimate } = require('../lib/ledger/card-fee-estimate.ts');
const { buildCardFeeHistory } = require('../lib/ledger/card-fee-history.ts');
const componentPath = 'app/(protected)/admin/ledger/card-settlements/CardFeeAnalysis.tsx';
const pagePath = 'app/(protected)/admin/ledger/card-settlements/page.tsx';
const feeRoutePath = 'app/api/admin/ledger/card-fees/route.ts';
function load(path, dependencies = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { assert.ok(name in dependencies, `Unexpected import ${name}`); return dependencies[name]; }, testModule, testModule.exports);
  return testModule.exports;
}

// October 2026 as booked: no official closure, provisional manual voucher #4119, month closed.
const october = () => buildCardFeeEstimate({
  monthCardGross: 192125640, currentOutstanding: 5699112, historicalConfirmedFee: 0, monthEndFee: 0,
  hasClosure: false, manualExpenses: [{ id: 4119, amount: 5699112, memo: '[잠정 추정·추후 정산검증]' }],
});
// Production values (read-only check 2026-11-07): sale-month attributed fees.
const productionMonths = () => [
  { month: '2026-07', gross: 3694200, saleDays: 1, historicalConfirmedFee: 82596.578, monthEndFee: 0, hasClosure: false, currentOutstanding: 0, monthClosed: false, provisionalFee: 0 },
  { month: '2026-08', gross: 225925720, saleDays: 31, historicalConfirmedFee: 4255533.422, monthEndFee: 0, hasClosure: false, currentOutstanding: 0, monthClosed: true, provisionalFee: 0 },
  { month: '2026-09', gross: 181045460, saleDays: 27, historicalConfirmedFee: 0, monthEndFee: 4332575, hasClosure: true, currentOutstanding: 0, monthClosed: true, provisionalFee: 0 },
  { month: '2026-10', gross: 192125640, saleDays: 29, historicalConfirmedFee: 0, monthEndFee: 0, hasClosure: false, currentOutstanding: 5699112, monthClosed: true, provisionalFee: 5699112 },
  { month: '2026-11', gross: 60337620, saleDays: 6, historicalConfirmedFee: 0, monthEndFee: 0, hasClosure: false, currentOutstanding: 21441362, monthClosed: false, provisionalFee: 0 },
];
const pct = rate => (rate * 100).toFixed(2);

test('estimate keeps the provisional voucher apart from an official confirmation', () => {
  const e = october();
  assert.deepEqual([e.gross, e.confirmedFee, e.unconfirmedEstimate, e.currentEstimate], [192125640, 0, 5699112, 5699112]);
  assert.equal(pct(e.rate), '2.97');
  assert.deepEqual([e.manualExpenseTotal, e.manualCoveredEstimate, e.unrecognizedEstimate, e.provisionalManualOnly, e.duplicateRisk], [5699112, 5699112, 0, true, false]);
  assert.ok(!('scenarios' in e) && !('rangeStatus' in e), 'reference-rate comparison removed');
  const dup = buildCardFeeEstimate({ monthCardGross: 200000000, currentOutstanding: 0, historicalConfirmedFee: 0, monthEndFee: 4300000, hasClosure: true, manualExpenses: [{ id: 1, amount: 4300000, memo: null }] });
  assert.equal(dup.duplicateRisk, true);
});

test('historical rates match production: Aug 1.88%, Sep 2.39%, weighted 2.11%; July, October and November excluded', () => {
  const h = buildCardFeeHistory({ months: productionMonths(), currentMonth: '2026-11' });
  assert.deepEqual(h.months.map(row => [row.month, row.status, row.rate === null ? null : pct(row.rate)]), [
    ['2026-10', 'provisional', '2.97'], ['2026-09', 'confirmed', '2.39'], ['2026-08', 'confirmed', '1.88'], ['2026-07', 'partial', '2.24'],
  ]);
  assert.equal(h.confirmedCount, 2);
  assert.equal(pct(h.averageRate), '2.11');
  assert.equal(h.averageRate.toFixed(6), ((4255533.422 + 4332575) / (225925720 + 181045460)).toFixed(6), 'sales-weighted, not a mean of rates');
  assert.deepEqual([h.lowest.month, pct(h.lowest.rate), h.highest.month, pct(h.highest.rate)], ['2026-08', '1.88', '2026-09', '2.39']);
});

test('history updates itself when a month confirms and says "collecting" with no confirmed month', () => {
  const months = productionMonths();
  months[3] = { ...months[3], hasClosure: true, monthEndFee: 4500000, currentOutstanding: 0, provisionalFee: 0 };
  const after = buildCardFeeHistory({ months, currentMonth: '2026-11' });
  assert.equal(after.confirmedCount, 3);
  assert.equal(after.averageRate.toFixed(6), ((4255533.422 + 4332575 + 4500000) / (225925720 + 181045460 + 192125640)).toFixed(6));
  const pending = buildCardFeeHistory({ months: [{ ...productionMonths()[3], provisionalFee: 0 }], currentMonth: '2026-11' });
  assert.deepEqual([pending.months[0].status, pending.months[0].rate, pending.averageRate, pending.lowest, pending.confirmedCount], ['pending', null, null, null, 0]);
});

test('sale-month attribution comes from the existing month state, not the booking date', () => {
  const cardSettlements = load('lib/ledger/card-settlements.ts');
  const { buildCardFeeMonthState } = load('lib/ledger/card-fee-closures.ts', { './card-settlements': cardSettlements, './card-fee-policy': require('../lib/ledger/card-fee-policy.ts') });
  // August sales matched by a September deposit: the difference belongs to August.
  const sales = [{ id: 1, business_date: '2026-08-20', amount: 1000000 }, { id: 2, business_date: '2026-09-10', amount: 1000000 }];
  const reconciliations = [{ id: 9, deposit_date: '2026-09-02', deposit_amount: 980000, matched_gross_amount: 1000000, difference_amount: 20000, status: 'matched' }];
  const lines = [{ reconciliation_id: 9, pos_card_transaction_id: 1, allocated_gross_amount: 1000000, reconciliation: { status: 'matched', deposit_date: '2026-09-02' } }];
  const stateFor = month => buildCardFeeMonthState({ month, currentMonth: '2026-11', closedMonths: new Set(['2026-08', '2026-09']), sales, lines, reconciliations, closures: [] });
  const months = ['2026-08', '2026-09'].map(month => { const s = stateFor(month); return { month, gross: s.monthCardGross, saleDays: 30, historicalConfirmedFee: s.historicalConfirmedFee, monthEndFee: s.monthEndFee, hasClosure: false, currentOutstanding: s.currentOutstanding, monthClosed: true, provisionalFee: 0 }; });
  const h = buildCardFeeHistory({ months, currentMonth: '2026-11' });
  assert.deepEqual(h.months.map(row => [row.month, row.status, row.fee]), [['2026-09', 'pending', null], ['2026-08', 'confirmed', 20000]]);
});

test('reference-rate comparison and receipt review are removed; history is served by the card-fees API', () => {
  assert.equal(existsSync('app/api/admin/ledger/card-fees/receipt-candidates/route.ts'), false);
  assert.equal(existsSync('lib/ledger/card-fee-receipt-candidates.ts'), false);
  const route = readFileSync(feeRoutePath, 'utf8');
  assert.match(route, /buildCardFeeHistory\(/);
  assert.match(route, /feeHistory, history:/);
  for (const source of [readFileSync(pagePath, 'utf8'), readFileSync(componentPath, 'utf8')]) assert.doesNotMatch(source, /receipt-candidates|scenarios|rangeStatus|targetRate/);
});

function render(lang, feeOverrides = {}, history = buildCardFeeHistory({ months: productionMonths(), currentMonth: '2026-11' })) {
  const mod = load(componentPath, { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), './card-settlements.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) } });
  const fee = { month: '2026-10', monthClosed: true, autoStatus: 'pending', historicalConfirmedFee: 0, monthEndFee: 0, currentOutstanding: 5699112, projectedTotalFee: 5699112, finalConfirmedFee: null, remainingRate: 5699112 / 192125640, confirmedRate: null, closure: null, estimate: october(), feeHistory: history, ...feeOverrides };
  return renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(mod.default, { fee, lang }), history ? React.createElement(mod.CardFeeHistory, { history, lang }) : null));
}
const BANNED = /자동 확정 대기|익월 카드입금 처리 중 자동 확정됩니다|공식 확정 전에 수기 전표를 취소|Chờ xác nhận tự động|Cần hủy bút toán thủ công/;

test('October card: provisional difference KPIs, cost booked vs fee unconfirmed, tidy details and history', () => {
  const html = render('ko');
  const has = fragment => assert.ok(html.includes(fragment), fragment);
  has('<span>잠정 정산 차액</span><strong>5.699.112 ₫</strong>');
  has('<span>잠정 차액률</span><strong>2.97%</strong><small class="kpiNote">매장 평균 2.11%</small>');
  // Cost booking and fee confirmation are two separate facts, no badges.
  has('<dl class="feeState"><div><dt>비용 반영</dt><dd>수기 전표 #4119 · 5.699.112 ₫</dd></div><div><dt>수수료 확정</dt><dd>미확정</dd></div></dl>');
  has('같은 금액이 자동 확정으로 다시 비용 처리되지 않도록 보호됩니다. 실제 수수료가 확정되면 차액만 현재 열린 월에서 정정합니다.');
  assert.doesNotMatch(html, /잠정 비용 처리|자동 중복 확정 보호|공식 확정 미완료|chip/);
  has('<details class="feeDetails"><summary>세부 내역 · 수기 전표</summary>');
  assert.doesNotMatch(html, /<details[^>]* open/);
  has('수기 비용 전표 #4119');
  // Zero lines are gone from the breakdown.
  const details = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
  assert.doesNotMatch(details, /<dd>0 ₫<\/dd>|기존 확정|비용 미반영 차액/);
  // History block.
  has('📈 역대 카드수수료율');
  has('<span>매장 평균</span><strong>2.11%</strong><small class="kpiNote">확정 2개월 · 매출 가중</small>');
  has('<span>최저</span><strong>1.88%</strong><small class="kpiNote">8월</small>');
  has('<span>최고</span><strong>2.39%</strong><small class="kpiNote">9월</small>');
  has('<th scope="row">10월</th><td>2.97%</td><td>잠정 · 평균 제외</td>');
  has('<th scope="row">9월</th><td>2.39%</td><td>확정</td>');
  has('<th scope="row">8월</th><td>1.88%</td><td>확정</td>');
  has('<th scope="row">7월</th><td>2.24%</td><td>참고 · 카드매출 1일</td>');
  assert.doesNotMatch(html, /11월|1\.80%|2\.15%|2\.50%|참고 범위|POS 영수증|예상 수수료/);
  assert.doesNotMatch(html, BANNED);
});

test('no confirmed month shows "collecting", never 0%', () => {
  const empty = buildCardFeeHistory({ months: [], currentMonth: '2026-11' });
  const html = render('ko', {}, empty);
  assert.ok(html.includes('<small class="kpiNote">매장 평균 집계 중</small>'));
  assert.ok(html.includes('집계 중 · 아직 확정된 달이 없습니다.'));
  assert.doesNotMatch(html, /매장 평균 0\.00%/);
});

test('Vietnamese card and history have no Korean UI text', () => {
  const html = render('vi');
  for (const label of ['Chênh lệch quyết toán tạm tính', 'TB cửa hàng 2.11%', 'Bút toán thủ công #4119', '<dt>Xác nhận phí</dt><dd>Chưa xác nhận</dd>', 'Tỷ lệ phí thẻ các tháng', 'Thấp nhất', 'Cao nhất', '>T8<', 'Tạm tính · không tính TB', 'Tham khảo · 1 ngày bán thẻ'])
    assert.ok(html.includes(label), label);
  // The voucher memo is stored ledger data (shown as entered); every UI label is Vietnamese.
  assert.doesNotMatch(html.replace('[잠정 추정·추후 정산검증]', ''), /[가-힣]/);
  assert.doesNotMatch(html, BANNED);
});

test('settleable month offers the explicit card payment settlement step; provisional or confirmed months do not', () => {
  const mod = load(componentPath, { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), './card-settlements.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) } });
  const estimate = buildCardFeeEstimate({ monthCardGross: 100000000, currentOutstanding: 2150000, historicalConfirmedFee: 0, monthEndFee: 0, hasClosure: false, manualExpenses: [] });
  const fee = { month: '2026-08', monthClosed: true, historicalConfirmedFee: 0, monthEndFee: 0, currentOutstanding: 2150000, projectedTotalFee: 2150000, finalConfirmedFee: null, remainingRate: 0.0215, confirmedRate: null, closure: null, estimate };
  const html = renderToStaticMarkup(React.createElement(mod.default, { fee, lang: 'ko', canSettle: true, onSettle: () => {} }));
  assert.ok(html.includes('>카드대금 입금 완료 · 수수료 확정</button>'));
  assert.doesNotMatch(html, /카드대금 정산완료/, 'confirmation panel opens only on click');
  const vi = renderToStaticMarkup(React.createElement(mod.default, { fee, lang: 'vi', canSettle: true, onSettle: () => {} }));
  assert.ok(vi.includes('>Đã nhận đủ tiền thẻ · Xác nhận phí</button>'));
  // October (provisional) and any month without canSettle show no settlement button.
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(mod.default, { fee: { ...fee, estimate: october() }, lang: 'ko', canSettle: false, onSettle: () => {} })), /수수료 확정<\/button>/);
});
