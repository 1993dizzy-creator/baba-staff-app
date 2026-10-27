import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardApi } from './helpers/ledger-dashboard-api-fixture.mjs';
import { dashboardTables } from './helpers/ledger-dashboard-tables.mjs';
import { buildAccrualReport, buildCloseComparison, buildRevenueAdjustments, isTechnicalExpenseCorrection } from '../lib/ledger/accrual-report.ts';

// Production-shaped 2026-08 categories (ids as in ledger_categories).
const categories = [
  { id: 16, name: '인건비', kind: 'expense', parent_id: null },
  { id: 7, name: '급여/인건비', kind: 'expense', parent_id: 16 },
  { id: 21, name: '보험·복리후생', kind: 'expense', parent_id: 16 },
  { id: 75, name: '보험', kind: 'expense', parent_id: 16 },
  { id: 18, name: '임차·시설비', kind: 'expense', parent_id: null },
  { id: 3, name: '임대료', kind: 'expense', parent_id: 18 },
  { id: 19, name: '일반관리비', kind: 'expense', parent_id: null },
  { id: 4, name: '기타 비용', kind: 'expense', parent_id: 19 },
];
const correction = (id, amount, sign, source_key, extra = {}) => ({
  id, type: 'expense', business_date: '2026-08-31', amount, economic_effect_sign: sign, category_id: 4,
  source_type: 'ledger_correction', source_key, correction_of_id: id === 1055 ? null : 1055, memo: `정정금액 · #${id}`, ...extra,
});
// #1055 and its offsets, exactly as recognized in 2026-08.
const augustTechnical = [
  correction(1055, 196211473.5, 1, 'legacy_sheet_expense_reconciliation:2026-08'),
  correction(1085, 226230407, -1, 'legacy_sheet_expense_detail_offset:2026-08:batch1'),
  correction(1089, 1080000, -1, 'legacy_sheet_expense_detail_offset:2026-08:meal'),
  correction(1117, 11672800, -1, 'legacy_sheet_expense_detail_offset:2026-08:batch2'),
  correction(1119, 20000, -1, 'legacy_sheet_expense_detail_offset:2026-08:hoa-honng'),
  correction(1307, 337000, -1, 'legacy_sheet_expense_detail_offset:2026-08:menu-kep-ghim'),
  correction(1448, 30628000, -1, 'legacy_sheet_expense_detail_offset:2026-08:bhxh'),
  correction(1498, 419632, -1, 'legacy-sheet-expense-detail-offset:2026-08:shipping-small-diff'),
];
const profit = (type, amount, category_id, economic_effect_sign = 1) => ({ type, amount, economic_effect_sign, category_id });
const augustProfit = [
  ...augustTechnical.map(row => profit(row.type, row.amount, row.category_id, row.economic_effect_sign)),
  profit('expense', 329632, 4), // #1497 sheet small differences: a real cost, not technical
  profit('expense', 8100000, 21), profit('expense', 22528000, 21), // BHXH under the retired category
  profit('expense_recognition', 172539197, 7),
  profit('sales', 734634810, null),
];
const report = (extra = {}) => buildAccrualReport({
  categories, profitRows: augustProfit, corrections: augustTechnical, prepaidRows: [], businessFundAccountIds: new Set([1]),
  reserveEntries: [], summary: { income: 734634810, otherIncome: 0, expense: 0, operatingProfit: 0 }, ...extra,
});

test('legacy sheet aggregate and its offsets are technical; real corrections stay operating', () => {
  for (const row of augustTechnical) assert.equal(isTechnicalExpenseCorrection(row), true, row.source_key);
  assert.equal(isTechnicalExpenseCorrection({ type: 'expense', source_type: 'manual', source_key: 'legacy-sheet-small-diff:2026-08' }), false);
  assert.equal(isTechnicalExpenseCorrection({ type: 'expense', source_type: 'ledger_correction', source_key: null }), false);
  assert.equal(isTechnicalExpenseCorrection({ type: 'sales', source_type: 'ledger_correction', source_key: 'legacy_sheet_expense_reconciliation:2026-08' }), false);
  assert.equal(isTechnicalExpenseCorrection({ type: 'expense', source_type: 'legacy_sheet_payroll_reversal', source_key: 'x' }), false);
});

test('2026-08: technical corrections are separated and the breakdown still adds up', () => {
  const result = report();
  assert.equal(result.technical.total, -74176365.5);
  assert.deepEqual(result.technical.items.map(item => item.id), [1055, 1085, 1089, 1117, 1119, 1307, 1448, 1498]);
  assert.equal(result.technical.items[0].name, '#1055');
  const general = result.expenses.find(row => row.name === '일반관리비');
  assert.deepEqual(general.details, [{ id: 4, name: '기타 비용', amount: 329632 }]);
  // The inactive category is still reported under 인건비.
  const labor = result.expenses.find(row => row.name === '인건비');
  assert.equal(labor.amount, 172539197 + 30628000);
  assert.ok(labor.details.some(detail => detail.name === '보험·복리후생' && detail.amount === 30628000));
  const recognized = augustProfit.filter(row => row.type !== 'sales').reduce((sum, row) => sum + row.amount * row.economic_effect_sign, 0);
  assert.equal(result.totalExpense, Math.round(recognized * 1000) / 1000);
  assert.equal(result.operatingExpense + result.technical.total, result.totalExpense);
  assert.ok(result.expenses.every(row => row.amount > 0));
});

test('2026-08 rent scenario: 50M rent and a 60M #1055 offset show as rent and technical, net -10M', () => {
  const before = report();
  const rentOffset = correction(9001, 60000000, -1, 'legacy_sheet_expense_detail_offset:2026-08:rent');
  const after = buildAccrualReport({
    categories,
    profitRows: [...augustProfit, profit('expense_recognition', 50000000, 3), profit('expense', 60000000, 4, -1)],
    corrections: [...augustTechnical, rentOffset],
    prepaidRows: [], businessFundAccountIds: new Set([1]), reserveEntries: [],
    summary: { income: 734634810, otherIncome: 0, expense: 0, operatingProfit: 0 },
  });
  assert.equal(after.totalExpense - before.totalExpense, -10000000);
  assert.equal(after.technical.total, -134176365.5);
  assert.deepEqual(after.expenses.find(row => row.name === '임차·시설비').details, [{ id: 3, name: '임대료', amount: 50000000 }]);
});

test('2026-08 production totals: before/after correction and the close card attribution', () => {
  const close = { revenue: { total: 734634810 }, expense: { total: 478003436.327, cardAttributionAdjustment: 522795.327 }, operatingResult: { operatingProfit: 256631373.673 } };
  const result = buildAccrualReport({
    categories, corrections: augustTechnical, prepaidRows: [], businessFundAccountIds: new Set(), reserveEntries: [],
    // Every non-technical August expense, aggregated into one row.
    profitRows: [...augustTechnical.map(row => profit(row.type, row.amount, row.category_id, row.economic_effect_sign)), profit('expense', 551657006.5, 7), profit('sales', 734634810, null)],
    summary: { income: 734634810 + 51743, otherIncome: 51743, expense: 477480641, operatingProfit: 734634810 + 51743 - 477480641 },
    closeSnapshot: close, closeRevision: 3,
  });
  assert.equal(result.operatingExpense, 551657006.5); // 보정 전 원장 비용
  assert.equal(result.technical.total, -74176365.5); // 기술적 보정·상쇄
  assert.equal(result.totalExpense, 477480641); // 보정 후 원장 비용
  assert.equal(result.close.cardAttribution, 522795.327); // 마감 손익비용과의 카드 귀속 차이
  assert.equal(Math.round((result.totalExpense + result.close.cardAttribution) * 1000) / 1000, close.expense.total);
  assert.equal(result.close.ledgerChange, 0);
  assert.equal(result.close.otherIncome, 51743);
});

test('dashboard labels describe ledger expense before/after correction, never "실제 운영비"', () => {
  const page = readFileSync('app/(protected)/admin/ledger/page.tsx', 'utf8');
  for (const label of ['보정 전 원장 비용', '기술적 보정·상쇄', '보정 후 원장 비용', '마감 손익비용과의 카드 귀속 차이', 'Chi phí sổ trước điều chỉnh', 'Chi phí sổ sau điều chỉnh']) assert.ok(page.includes(`"${label}"`), label);
  assert.doesNotMatch(page, /: "실제 운영비"|operatingCosts/);
  // Exact ledger money (3 decimals) in the accrual view.
  assert.match(page, /maximumFractionDigits: 3/);
});

test('rent prepayment and reserve entries are reported as non-expense movements', () => {
  const result = report({
    prepaidRows: [
      { type: 'prepaid_expense_payment', movements: [{ amount: -300000000, fund_account: { id: 1 } }] },
      { type: 'prepaid_expense_payment', movements: [{ amount: -5, fund_account: { id: 99 } }] },
      { type: 'expense', movements: [{ amount: -7, fund_account: { id: 1 } }] },
    ],
    reserveEntries: [{ entry_type: 'allocate', amount: 60000000 }, { entry_type: 'allocate', amount: '60000000' }, { entry_type: 'release', amount: 100000000 }],
  });
  assert.deepEqual(result.nonExpense, { prepaidPayments: 300000000, reserveAllocated: 120000000, reserveReleased: 100000000 });
});

test('revenue corrections keep their recorded sale dates (#1054) or their own date (#1029)', () => {
  const details = [
    ['2026-08-01', 50000], ['2026-08-04', -589000], ['2026-08-07', 1331000], ['2026-08-08', 398600], ['2026-08-09', 172500],
    ['2026-08-23', 146000], ['2026-08-25', -27000], ['2026-08-28', 484000], ['other', -300],
  ].map(([date, delta]) => ({ date, delta, note: '수기/POS 수정 반영 차이' }));
  const rows = buildRevenueAdjustments([
    { id: 1054, type: 'sales', business_date: '2026-08-31', amount: 1965800, economic_effect_sign: 1, source_type: 'ledger_correction', source_key: 'legacy_sheet_sales_reconciliation:2026-08', memo: '정정금액 · 8월 시트 매출 교차검증 보정', source_snapshot: { details } },
    { id: 1029, type: 'sales', business_date: '2026-08-18', amount: 1540000, economic_effect_sign: 1, source_type: 'ledger_correction', memo: '정정금액 · 8/18 BR4 POS 영수증 수정 누락', source_snapshot: {} },
    { id: 5, type: 'expense', business_date: '2026-08-18', amount: 1, economic_effect_sign: 1, source_type: 'ledger_correction' },
  ]);
  assert.deepEqual(rows.map(row => [row.id, row.amount, row.items.length]), [[1029, 1540000, 1], [1054, 1965800, 9]]);
  assert.deepEqual(rows[0].items, [{ date: '2026-08-18', note: '', amount: 1540000 }]);
  const august7 = rows[1].items.find(item => item.date === '2026-08-07');
  assert.equal(august7.amount, 1331000);
  assert.equal(rows[1].items.find(item => item.date === null).amount, -300);
  assert.equal(rows[1].name, '8월 시트 매출 교차검증 보정');
  // A recorded breakdown that does not add up keeps the remainder visible.
  const partial = buildRevenueAdjustments([{ id: 1, type: 'sales', business_date: '2026-08-31', amount: 100, economic_effect_sign: 1, source_type: 'ledger_correction', source_snapshot: { details: [{ date: '2026-08-02', delta: 60 }] } }]);
  assert.deepEqual(partial[0].items.at(-1), { date: null, note: '잔여 차이', amount: 40 });
});

test('close comparison: 2026-08 has no drift; 2026-09 shows payroll #2752 booked after close', () => {
  const august = buildCloseComparison(
    { revenue: { total: 734634810 }, expense: { total: 478003436.327, cardAttributionAdjustment: 522795.327 }, operatingResult: { operatingProfit: 256631373.673 } },
    3, { income: 734634810, otherIncome: 0, expense: 477480641, operatingProfit: 257154169 },
  );
  assert.equal(august.drift, false);
  assert.equal(august.ledgerChange, 0);
  assert.equal(august.snapshotOperatingProfit + august.ledgerChange + august.cardAttribution + august.otherIncome, august.dashboardOperatingProfit);
  const september = buildCloseComparison(
    { revenue: { total: 691165200 }, expense: { total: 406899585.6, cardAttributionAdjustment: 0 }, operatingResult: { operatingProfit: 284265614.4 } },
    3, { income: 691165200, otherIncome: 0, expense: 583085379.6, operatingProfit: 108079820.4 },
  );
  assert.equal(september.drift, true);
  assert.equal(september.expenseChange, 176185794);
  assert.equal(september.ledgerChange, -176185794);
  assert.equal(september.revision, 3);
  assert.equal(buildCloseComparison(null, null, { income: 0, otherIncome: 0, expense: 0, operatingProfit: 0 }), null);
});

test('dashboard scope returns the accrual view; totals equal the summary and the ledger is untouched', async () => {
  const tables = dashboardTables(), snapshot = JSON.stringify(tables);
  for (const month of ['2026-08', '2026-09', '2026-10']) {
    const api = dashboardApi(tables);
    const body = await (await api.get(month, '&scope=dashboard')).json();
    assert.equal(body.accrual.totalExpense, body.summary.expense, month);
    assert.equal(body.accrual.nonExpense.prepaidPayments, 3000, month);
    assert.equal(body.accrual.nonExpense.reserveAllocated, 100, month);
    // Display-only: no RPC (the fixture throws on rpc) and no write.
    const full = await (await dashboardApi(tables).get(month)).json();
    assert.ok(!('accrual' in full), 'full GET contract unchanged');
  }
  assert.equal(JSON.stringify(tables), snapshot);
});

test('route builds the accrual view only for the dashboard scope', () => {
  const route = readFileSync('app/api/admin/ledger/route.ts', 'utf8');
  assert.match(route, /const accrualInputsPromise = dashboardOnly \? Promise\.all\(/);
  assert.match(route, /if \(dashboardOnly\) \{\n\s+const \[reportCategoriesResult, accrualCorrectionsResult\] = await accrualInputsPromise!;/);
  assert.equal((route.match(/buildAccrualReport\(/g) || []).length, 1);
  // Reserve entries come from the single shared reserve query (month window only).
  assert.equal((route.match(/from\("ledger_reserve_entries"\)/g) || []).length, 1);
});

test('dashboard page: accrual check is its own card and sheet; the KPI operating-profit sheet is unchanged', () => {
  const page = readFileSync('app/(protected)/admin/ledger/page.tsx', 'utf8');
  const compact = page.replace(/\s+/g, '');
  const body = compact.slice(compact.indexOf('functionDashboardReport('), compact.indexOf('functionOperatingProfitSheet('));
  assert.ok(body.indexOf('<AccrualCheckCard') > body.indexOf('copy.cashFlow}'), 'after the cash flow card');
  const sheet = compact.slice(compact.indexOf('functionOperatingProfitSheet('), compact.indexOf('functionKpiCard('));
  assert.doesNotMatch(sheet, /accrual/i);
  // Korean and Vietnamese copy carry the same keys.
  const keys = lang => [...page.slice(page.indexOf(`  ${lang}: {`), page.indexOf('  },', page.indexOf(`  ${lang}: {`))).matchAll(/^ {4}(\w+):/gm)].map(match => match[1]);
  assert.deepEqual(keys('vi'), keys('ko'));
  assert.ok(keys('ko').includes('technicalNote') && keys('ko').includes('nonExpenseNote'));
});
