import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { calculateSalesReceiptExplanation } from '../lib/ledger/card-settlements.ts';

const require = createRequire(import.meta.url);
const render = require('react-dom/server').renderToStaticMarkup;
const rowModule = { exports: {} };
const rowCode = ts.transpileModule(readFileSync('components/ledger/DashboardDetailRow.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
new Function('require', 'module', 'exports', rowCode)(name => name.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) } : require(name), rowModule, rowModule.exports);
const source = readFileSync('components/ledger/SalesReceiptDetails.tsx', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const componentModule = { exports: {} };
new Function('require', 'module', 'exports', code)(name => name.endsWith('DashboardDetailRow') ? { __esModule: true, default: rowModule.exports.default } : name.endsWith('.css') ? { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) } : require(name), componentModule, componentModule.exports);
const Card = componentModule.exports.default;
const base = { posSales: 691165200, actualSalesReceipts: 712171963, monthEndUnsettledCardSales: 6926797, start: '2026-09-01', end: '2026-10-01' };
const allocation = (id, gross, date = '2026-08-20', extra = {}) => ({ reconciliation_id: id, allocated_gross_amount: gross, sale: { business_date: date }, reconciliation: { status: 'auto_allocated', deposit_date: '2026-09-12', deposit_amount: gross, matched_gross_amount: gross, ...extra } });
const september = calculateSalesReceiptExplanation({ ...base, allocations: [allocation(1, 27933560)] });

test('September bridge balances actual receipts without including other income', () => {
  assert.equal(september.posSales + september.priorMonthCardDeposits - september.monthEndUnsettledCardSales, 712171963);
  assert.equal(september.actualSalesReceipts + 5819069, 717991032);
  assert.equal(september.allocationDifference, 0);
});

test('cash is attributed to real allocations from every prior month, not prior outstanding amounts', () => {
  const result = calculateSalesReceiptExplanation({ ...base, allocations: [allocation(1, 100, '2026-08-20'), allocation(2, 200, '2026-07-20'), allocation(3, 300, '2025-01-01')] });
  assert.equal(result.priorMonthCardDeposits, 600);
});

for (const [unsettled, actual] of [[0, 100], [20, 80], [100, 0]]) {
  test('current card sales with unsettled ' + unsettled + ' preserve the existing receipt result', () => {
    const result = calculateSalesReceiptExplanation({ ...base, posSales: 100, actualSalesReceipts: actual, monthEndUnsettledCardSales: unsettled, allocations: [] });
    assert.equal(result.allocationDifference, 0); assert.equal(result.actualSalesReceipts, actual);
  });
}

test('zero sales and zero deposits display natural zero amounts', () => {
  const result = calculateSalesReceiptExplanation({ ...base, posSales: 0, actualSalesReceipts: 0, monthEndUnsettledCardSales: 0, allocations: [] });
  assert.deepEqual(result, { posSales: 0, actualSalesReceipts: 0, monthEndUnsettledCardSales: 0, priorMonthCardDeposits: 0, allocationDifference: 0 });
  const html = render(require('react').createElement(Card, { month: '2026-09', data: result, lang: 'ko' }));
  assert.equal((html.match(/<strong class="detailAmount">[^<]*0 ₫<[/]strong>/g) ?? []).length, 3);
  assert.ok(!html.includes('입금 배분·정산 차이'));
});

test('cancelled, unallocated, current-month sales and deposits outside the month cannot become prior receipts', () => {
  const allocations = [allocation(1, 100, undefined, { status: 'cancelled' }), allocation(2, 100, undefined, { status: 'unmatched' }), allocation(3, 100, '2026-09-01'), allocation(4, 100, undefined, { deposit_date: '2026-08-31' }), allocation(5, 100, undefined, { deposit_date: '2026-10-01' }), { ...allocation(6, 100), sale: null }];
  assert.equal(calculateSalesReceiptExplanation({ ...base, allocations }).priorMonthCardDeposits, 0);
});

test('legacy net deposits use recorded allocation shares and expose fee differences without changing receipts', () => {
  const reconciliation = { status: 'matched', deposit_date: '2026-09-12', deposit_amount: 90, matched_gross_amount: 100 };
  const result = calculateSalesReceiptExplanation({ ...base, posSales: 100, actualSalesReceipts: 140, monthEndUnsettledCardSales: 40, allocations: [allocation(1, 60, undefined, reconciliation)] });
  assert.equal(result.priorMonthCardDeposits, 54); assert.equal(result.actualSalesReceipts, 140);
  assert.equal(result.allocationDifference, 26);
});

test('partial or unmatched deposits expose unallocated cash instead of fabricating prior receipts', () => {
  const result = calculateSalesReceiptExplanation({ ...base, posSales: 0, actualSalesReceipts: 100, monthEndUnsettledCardSales: 0, allocations: [allocation(1, 60, undefined, { status: 'partial', deposit_amount: 100, matched_gross_amount: 60 })] });
  assert.equal(result.priorMonthCardDeposits, 60); assert.equal(result.allocationDifference, 40);
});

for (const lang of ['ko', 'vi']) {
  test(lang + ' explanation uses the same receipts, signs and amount formatting with clear receivable guidance', () => {
    const html = render(require('react').createElement(Card, { month: '2026-09', data: september, lang }));
    for (const amount of ['691.165.200 ₫', '+27.933.560 ₫', '−6.926.797 ₫']) assert.ok(html.includes(amount));
    assert.ok(html.includes(lang === 'ko' ? '9월 POS 결제매출' : 'Tháng 9 Doanh thu thanh toán POS'));
    assert.ok(html.includes(lang === 'ko' ? '지출이 아닌 받을 돈' : 'khoản phải thu, không phải chi phí'));
    assert.equal((html.match(/class="detailAmount"/g) ?? []).length, 3);
  });
  test(lang + ' missing response is shown as unavailable, never invented zeros', () => {
    const html = render(require('react').createElement(Card, { month: '2026-09', lang }));
    assert.ok(!html.includes('detailAmount')); assert.ok(!html.includes('0 ₫'));
  });
}

test('nonzero allocation difference is explicit and reconciles to the existing actual receipts', () => {
  const html = render(require('react').createElement(Card, { month: '2026-09', data: { ...september, allocationDifference: -100 }, lang: 'ko' }));
  assert.ok(html.includes('입금 배분·정산 차이')); assert.ok(html.includes('−100 ₫'));
  assert.ok(html.includes('카드 정산 상세'));
});

test('dashboard integrates receipt details, resets expansion by month and keeps two KPI cards', () => {
  const page = readFileSync('app/(protected)/admin/ledger/page.tsx', 'utf8');
  assert.ok(!page.includes('SalesReceiptExplanationCard'));
  assert.match(page, /<DashboardReport\s+key=\{month\}/);
  assert.match(page, /change=\{report.kpis.incomeChange\}/);
  assert.match(page, /<CompositionChange change=\{report.kpis.expenseChange\}/);
  assert.match(page, /expandable=\{row.id === -1 \|\| row.details.length > 0\}/);
  assert.match(page, /expandedContent=\{row.id === -1 \? <SalesReceiptDetails/);
  assert.ok(!page.includes('label={copy.income}')); assert.ok(!page.includes('label={copy.expense}'));
  const css = readFileSync('app/(protected)/admin/ledger/ledger-dashboard.module.css', 'utf8');
  assert.match(css, /\.detailAmount\s*\{[^}]*white-space: nowrap/);
  assert.match(css, /\.detailRow\s*\{[^}]*18px minmax\(0, 1fr\) auto/);
});


const pageSource = readFileSync('app/(protected)/admin/ledger/page.tsx', 'utf8');
const pageModule = { exports: {} };
const pageCode = ts.transpileModule(pageSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
new Function('require', 'module', 'exports', pageCode + '\nexports.TestDashboard = DashboardReport; exports.TestChange = CompositionChange; exports.copy = text;')(name => {
  if (name === 'react' || name === 'react/jsx-runtime') return require(name);
  if (name.endsWith('.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
  if (name.endsWith('/DashboardDetailRow')) return { default: rowModule.exports.default, __esModule: true };
  if (name.endsWith('/SalesReceiptDetails')) return { default: Card, __esModule: true };
  return {};
}, pageModule, pageModule.exports);
const { buildDashboardReport } = require('../lib/ledger/dashboard-report.ts');
const fixture = { month: '2026-09', fundsView: { mode: 'closed_snapshot' }, categories: [{ id: 1, name: '기타 수입', kind: 'income', parent_id: null }],
  summary: { income: 696984269, otherIncome: 5819069, receivedIncome: 717991032, expense: 406979586, operatingProfit: 290004683, actualCashOutflow: 569415007 },
  profitTransactions: [{ type: 'income', amount: 5819069, category_id: 1 }], transactions: [], accounts: [],
  cashReport: { expenseBreakdown: [{ id: 2, name: '매입비', amount: 569415007, details: [{ id: 3, name: '매입', amount: 569415007 }] }] } };

for (const lang of ['ko', 'vi']) {
  test(lang + ' compact dashboard keeps September totals, bars, collapsed receipts and profit detail', () => {
    const report = buildDashboardReport(fixture, { ...fixture, month: '2026-08', summary: { ...fixture.summary, receivedIncome: 0, actualCashOutflow: 0 } });
    assert.equal(report.kpis.income, 717991032); assert.equal(report.kpis.expense, 569415007);
    assert.equal(report.kpis.cashDifference, 148576025); assert.equal(report.kpis.incomeChange, null);
    const html = render(require('react').createElement(pageModule.exports.TestDashboard, { copy: pageModule.exports.copy[lang], lang, month: '2026-09', fundsMode: 'closed_snapshot', report, detailEmoji: () => '💰', salesReceiptExplanation: september,
      operatingResult: { mode: 'provisional', operatingProfit: 113555068, warnings: [], needsCheck: false }, expandedExpenses: new Set(), onToggleExpense() {} }));
    for (const amount of ['717.991.032 ₫', '569.415.007 ₫', '148.576.025 ₫', '113.555.068 ₫', '712.171.963 ₫']) assert.ok(html.includes(amount));
    assert.equal((html.match(/class="kpiCard"/g) ?? []).length, 2);
    assert.equal((html.match(/class="barFillIncome"/g) ?? []).length, 2);
    assert.ok(html.includes('aria-haspopup="dialog"'));
    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(!html.includes('691.165.200 ₫')); assert.ok(!html.includes('detailRows'));
    assert.ok(!html.includes('매출과 입금액의 차이'));
    assert.ok(!html.includes('compositionChange'));
  });
}

test('composition header percent omits unavailable comparison and preserves direction and zero change', () => {
  for (const [change, expected] of [[null, ''], [0, '0.0%'], [12.34, '↑ 12.3%'], [-12.34, '↓ 12.3%']]) {
    const html = render(require('react').createElement(pageModule.exports.TestChange, { change }));
    if (change === null) assert.equal(html, ''); else assert.ok(html.includes(expected));
  }
});
