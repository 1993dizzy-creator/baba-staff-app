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
  assert.match(route, /feeHistory, estimateException, history:/);
  for (const source of [readFileSync(pagePath, 'utf8'), readFileSync(componentPath, 'utf8')]) assert.doesNotMatch(source, /receipt-candidates|scenarios|rangeStatus|targetRate/);
});

function render(lang, feeOverrides = {}, history = buildCardFeeHistory({ months: productionMonths(), currentMonth: '2026-11' })) {
  const mod = load(componentPath, { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), './card-settlements.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) } });
  const fee = { month: '2026-10', monthClosed: true, autoStatus: 'pending', historicalConfirmedFee: 0, monthEndFee: 0, currentOutstanding: 5699112, projectedTotalFee: 5699112, finalConfirmedFee: null, remainingRate: 5699112 / 192125640, confirmedRate: null, closure: null, estimate: october(), feeHistory: history, settlementStatus: 'review_required', ...feeOverrides };
  return renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(mod.default, { fee, lang }), history ? React.createElement(mod.CardFeeHistory, { history, lang }) : null));
}
const BANNED = /자동 확정 대기|익월 카드입금 처리 중 자동 확정됩니다|공식 확정 전에 수기 전표를 취소|Chờ xác nhận tự động|Cần hủy bút toán thủ công/;

test('October card: plain cost wording, no store-average note, tidy settlement detail and history', () => {
  const html = render('ko');
  const has = fragment => assert.ok(html.includes(fragment), fragment);
  has('<span>잠정 정산 차액</span><strong>5.699.112 ₫</strong>');
  // Rate KPI has no sub-text; the store average lives in the history block only.
  has('<span>잠정 차액률</span><strong>2.97%</strong></article>');
  assert.doesNotMatch(html.slice(0, html.indexOf('📈')), /매장 평균|kpiNote/);
  // Cost state in plain words, no voucher term or id in the default view.
  has('<dl class="feeState"><div><dt>비용 처리</dt><dd>임시 비용 반영 · 5.699.112 ₫</dd></div><div><dt>정산 상태</dt><dd class="feeStateReview">확인 필요</dd></div></dl>');
  assert.doesNotMatch(html, /수기 전표|수기 비용 전표|#4119|\[잠정 추정/);
  has('같은 금액이 자동 확정으로 다시 비용 처리되지 않도록 보호됩니다.');
  // Settlement detail: collapsed, four amounts only.
  has('<details class="feeDetails"><summary>정산 상세</summary>');
  assert.doesNotMatch(html, /<details[^>]* open/);
  const details = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
  for (const row of ['<dt>카드매출</dt><dd>192.125.640 ₫</dd>', '<dt>입금 반영</dt><dd>186.426.528 ₫</dd>', '<dt>미정산 차액</dt><dd>5.699.112 ₫</dd>', '<dt>비용 반영 금액</dt><dd>5.699.112 ₫</dd>']) assert.ok(details.includes(row), row);
  assert.doesNotMatch(details, /<dd>0 ₫<\/dd>/);
  // History KPIs: no sub-text; lowest/highest carry year.month right after the rate.
  has('📈 역대 카드수수료율');
  has('<span>평균</span><strong>2.11%</strong></article>');
  has('<span>최저</span><strong class="rateWithMonth">1.88%<small>(2026.08)</small></strong>');
  has('<span>최고</span><strong class="rateWithMonth">2.39%<small>(2026.09)</small></strong>');
  assert.doesNotMatch(html, /확정 2개월|매출 가중<\/small>/);
  // Month labels always carry the year; newest first.
  has('<th scope="row">2026년 10월</th><td>2.97%</td><td>잠정 · 평균 제외</td>');
  has('<th scope="row">2026년 9월</th><td>2.39%</td><td>확정</td>');
  has('<th scope="row">2026년 7월</th><td>2.24%</td><td>참고 · 카드매출 1일</td>');
  assert.ok(html.indexOf('2026년 10월') < html.indexOf('2026년 7월'));
  assert.doesNotMatch(html, /data-history-scroll/, '4 rows: no inner scroll');
  assert.doesNotMatch(html, BANNED);
});

test('history shows up to 5 rows inline and scrolls 6+ rows inside a box; years are always shown', () => {
  const row = (month, fee) => ({ month, gross: 200000000, saleDays: 30, historicalConfirmedFee: fee, monthEndFee: 0, hasClosure: false, currentOutstanding: 0, monthClosed: true, provisionalFee: 0 });
  const five = buildCardFeeHistory({ months: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((m, i) => row(m, 4000000 + i * 100000)), currentMonth: '2026-11' });
  const fiveHtml = render('ko', {}, five);
  assert.equal((fiveHtml.match(/<tbody>[\s\S]*<\/tbody>/)[0].match(/<tr/g) || []).length, 5);
  assert.doesNotMatch(fiveHtml, /data-history-scroll/);
  const many = buildCardFeeHistory({ months: ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m, i) => row(m, 3800000 + i * 120000)), currentMonth: '2026-11' });
  const manyHtml = render('ko', {}, many);
  assert.match(manyHtml, /<div class="historyTableBox historyTableScroll" data-history-scroll="true"><table class="feeTable"><thead>/);
  for (const label of ['2026년 5월', '2025년 12월', '2025년 11월']) assert.ok(manyHtml.includes(`<th scope="row">${label}</th>`), label);
  assert.ok(manyHtml.indexOf('2026년 5월') < manyHtml.indexOf('2025년 11월'), 'newest first across years');
  assert.ok(manyHtml.includes('<strong class="rateWithMonth">1.90%<small>(2025.11)</small></strong>'));
  const vi = render('vi', {}, many);
  for (const label of ['>T5/2026<', '>T11/2025<', '<small>(T11/2025)</small>']) assert.ok(vi.includes(label), label);
});

test('confirmed month and a month without data use the same plain wording', () => {
  const sep = buildCardFeeEstimate({ monthCardGross: 181045460, currentOutstanding: 0, historicalConfirmedFee: 0, monthEndFee: 4332575, hasClosure: true, manualExpenses: [] });
  const confirmed = render('ko', { month: '2026-09', currentOutstanding: 0, monthEndFee: 4332575, finalConfirmedFee: 4332575, closure: { confirmed_at: '2026-10-08T05:00:00Z', finalization_business_date: '2026-10-08' }, estimate: sep });
  assert.ok(confirmed.includes('<dt>비용 처리</dt><dd>비용 반영 완료</dd>'));
  const details = confirmed.slice(confirmed.indexOf('<details'), confirmed.indexOf('</details>'));
  for (const row of ['<dt>카드매출</dt><dd>181.045.460 ₫</dd>', '<dt>입금 반영</dt><dd>176.712.885 ₫</dd>', '<dt>비용 반영 금액</dt><dd>4.332.575 ₫</dd>']) assert.ok(details.includes(row), row);
  assert.doesNotMatch(details, /미정산 차액|<dd>0 ₫<\/dd>/);
  const empty = render('ko', { estimate: undefined, currentOutstanding: 0, projectedTotalFee: 0 }, buildCardFeeHistory({ months: [], currentMonth: '2026-11' }));
  assert.ok(empty.includes('<dt>비용 처리</dt><dd>비용 미반영</dd>'));
  assert.ok(empty.includes('집계 중 · 아직 확정된 달이 없습니다.'));
  assert.doesNotMatch(empty, /0\.00%|historyTableBox/);
});

test('Vietnamese card and history have no Korean text', () => {
  const html = render('vi');
  for (const label of ['Chênh lệch quyết toán tạm tính', '<dt>Chi phí</dt><dd>Ghi chi phí tạm · 5.699.112 ₫</dd>', '<dt>Trạng thái quyết toán</dt><dd class="feeStateReview">Cần kiểm tra</dd>', '<summary>Chi tiết quyết toán</summary>', '<span>Trung bình</span><strong>2.11%</strong>', '<small>(T8/2026)</small>', '>T10/2026<', 'Tạm tính · không tính TB', 'Tham khảo · 1 ngày bán thẻ'])
    assert.ok(html.includes(label), label);
  // No memo is shown any more, so the whole Vietnamese view is free of Korean.
  assert.doesNotMatch(html, /[가-힣]/);
  assert.doesNotMatch(html, /#4119|Bút toán thủ công|TB cửa hàng/);
  assert.doesNotMatch(html, BANNED);
});

test('settlement block: statuses, numbers and the single confirmation; October exception never offers it', () => {
  const mod = load(componentPath, { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), './card-settlements.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) } });
  const estimate = buildCardFeeEstimate({ monthCardGross: 100000000, currentOutstanding: 2150000, historicalConfirmedFee: 0, monthEndFee: 0, hasClosure: false, manualExpenses: [] });
  const fee = { month: '2026-08', monthClosed: true, historicalConfirmedFee: 0, monthEndFee: 0, currentOutstanding: 2150000, projectedTotalFee: 2150000, finalConfirmedFee: null, remainingRate: 0.0215, confirmedRate: null, closure: null, estimate };
  const view = (props, lang = 'ko') => renderToStaticMarkup(React.createElement(mod.default, { lang, onSettle: () => {}, ...props }));
  // Awaiting confirmation (next-month deposit linked): numbers + checkbox + one button, no typed amount.
  const ready = view({ fee: { ...fee, settlementStatus: 'awaiting_confirmation' }, canSettle: true });
  for (const part of ['<dt>정산 상태</dt><dd>확인 대기</dd>', '<dt>전월 카드매출</dt><dd>100.000.000 ₫</dd>', '<dt>실제 입금 반영액</dt><dd>97.850.000 ₫</dd>', '<dt>남은 정산 차액</dt><dd>2.150.000 ₫</dd>', '<dt>예상 수수료율</dt><dd>2.15%</dd>', '이 달 카드대금이 모두 입금된 것을 확인했습니다.', '>카드수수료 확정</button>']) assert.ok(ready.includes(part), part);
  assert.match(ready, /<button type="button" class="primary" style="width:100%" disabled="">카드수수료 확정<\/button>/, 'disabled until ticked');
  assert.doesNotMatch(ready, /<input[^>]*type="(number|text)"/, 'fee amount and rate are never typed');
  assert.doesNotMatch(ready, /<details/);
  // Awaiting deposit: numbers, explanation, no button.
  const waiting = view({ fee: { ...fee, settlementStatus: 'awaiting_deposit' }, canSettle: false });
  assert.ok(waiting.includes('<dt>정산 상태</dt><dd>입금 대기</dd>') && waiting.includes('익월 첫 카드입금이 등록되면 확인 대기로 바뀝니다.'));
  assert.doesNotMatch(waiting, /카드수수료 확정<\/button>|type="checkbox"/);
  // Next-month deposit registered but not yet allocated to this month: waiting confirmation, cannot confirm.
  const notLinked = view({ fee: { ...fee, settlementStatus: 'awaiting_confirmation' }, canSettle: false });
  assert.ok(notLinked.includes('익월 입금이 아직 이 달 카드매출에 배분되지 않아 확정할 수 없습니다.'));
  assert.doesNotMatch(notLinked, /카드수수료 확정<\/button>/);
  // VI wording.
  const vi = view({ fee: { ...fee, settlementStatus: 'awaiting_confirmation' }, canSettle: true }, 'vi');
  for (const part of ['Chờ xác nhận', 'Tôi đã kiểm tra toàn bộ tiền thẻ của tháng này đã về.', '>Xác nhận phí thẻ</button>', 'Doanh thu thẻ tháng trước']) assert.ok(vi.includes(part), part);
  assert.doesNotMatch(vi, /[가-힣]/);
  // October after the one-off record: estimate exception, details view, no settlement controls.
  const exception = view({ fee: { ...fee, estimate: october(), currentOutstanding: 5699112, settlementStatus: 'estimate_exception', estimateException: { amount: 5699112, reason: 'x', recordedAt: '2026-11-08T00:00:00Z' } }, canSettle: false });
  for (const part of ['<dt>정산 상태</dt><dd>예외 마감 · 추정 기준</dd>', '<span>추정 기준 수수료</span>', '실제 카드사 수수료를 확인하지 못해 임시 비용 5.699.112 ₫ 기준으로 마감했습니다. 공식 확인된 수수료가 아니며 평균 수수료율에서 제외됩니다.', '<summary>정산 상세</summary>']) assert.ok(exception.includes(part), part);
  assert.doesNotMatch(exception, /카드수수료 확정<\/button>|type="checkbox"|같은 금액이 자동 확정으로/);
  // Confirmed month: done, no controls.
  const done = view({ fee: { ...fee, currentOutstanding: 0, closure: { confirmed_at: '2026-09-05T03:00:00Z', finalization_business_date: '2026-09-05' }, finalConfirmedFee: 2150000, monthEndFee: 2150000, settlementStatus: 'confirmed' }, canSettle: false });
  assert.ok(done.includes('<dd class="feeStateDone">확정 완료 · 자동 · '));
  assert.doesNotMatch(done, /카드수수료 확정<\/button>/);
});

test('settlement confirm stays disabled until the final deposit is ticked and sends the shown amount', () => {
  const source = readFileSync(componentPath, 'utf8');
  assert.match(source, /<input type="checkbox" checked=\{lastDepositChecked\}/);
  assert.match(source, /disabled=\{settling \|\| !lastDepositChecked\} onClick=\{\(\) => void onSettle\(fee\.currentOutstanding\)\}/);
  const page = readFileSync(pagePath, 'utf8');
  assert.match(page, /body: JSON\.stringify\(\{ month, lastDepositConfirmed: true, confirmedFee \}\)/);
});
