import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const {
  breakdownChange,
  buildDashboardReport,
  buildExpenseBreakdown,
  buildIncomeBreakdown,
  cashDifferenceChange,
  percentageChange,
  previousLedgerMonth,
  sumBusinessFundBalances,
} = createRequire(import.meta.url)("../lib/ledger/dashboard-report.ts") as typeof import("../lib/ledger/dashboard-report");
const { buildDashboardCashReport } = createRequire(import.meta.url)("../lib/ledger/dashboard-cash-report.ts") as typeof import("../lib/ledger/dashboard-cash-report");

const read = (path: string) => readFileSync(path, "utf8");
const adminPage = read("app/(protected)/admin/page.tsx");
const dashboardPage = read("app/(protected)/admin/ledger/page.tsx");
const dashboardCompact = dashboardPage.replace(/\s+/g, "");
const dashboardStyles = read("app/(protected)/admin/ledger/ledger-dashboard.module.css");
const dashboardStylesCompact = dashboardStyles.replace(/\s+/g, "");
const entriesStyles = read("app/(protected)/admin/ledger/entries/entries.module.css");
const route = read("app/api/admin/ledger/route.ts");
const ledgerLayout = read("app/(protected)/admin/ledger/layout.tsx");
const ledgerTabs = read("lib/navigation/ledger-tabs.ts");

const categories = [
  { id: 10, name: "영업수입", kind: "income" as const, parent_id: null },
  { id: 11, name: "POS 매출", kind: "income" as const, parent_id: 10 },
  { id: 12, name: "예금이자", kind: "income" as const, parent_id: 10 },
  { id: 20, name: "매입비", kind: "expense" as const, parent_id: null },
  { id: 21, name: "식자재 매입", kind: "expense" as const, parent_id: 20 },
  { id: 22, name: "주류 매입", kind: "expense" as const, parent_id: 20 },
  { id: 31, name: "채소", kind: "expense" as const, parent_id: 21 },
  { id: 32, name: "맥주", kind: "expense" as const, parent_id: 22 },
];

const current = {
  month: "2026-09",
  fundsView: { mode: "live" as const },
  summary: { income: 110, expense: 130, operatingProfit: -20, receivedIncome: 105, actualCashOutflow: 120, otherIncome: 20 },
  accounts: [
    { code: "store_cash", type: "cash", is_business_fund: true, balance: 1_000, openingBalance: 800 },
    { code: "card_clearing", type: "card_clearing", is_business_fund: true, balance: 500, openingBalance: 400 },
    { code: "private", type: "bank", is_business_fund: false, balance: 900, openingBalance: 900 },
  ],
  categories,
  profitTransactions: [
    { type: "sales", amount: 100, category_id: 11, economic_effect_sign: 1 },
    { type: "sales", amount: 10, category_id: 11, economic_effect_sign: -1 },
    { type: "income", amount: 20, category_id: 12, economic_effect_sign: 1 },
    { type: "expense", amount: 100, category_id: 31, economic_effect_sign: 1 },
    { type: "expense", amount: 20, category_id: 31, economic_effect_sign: -1 },
    { type: "expense_recognition", amount: 50, category_id: 32, economic_effect_sign: 1 },
    { type: "investment", amount: 1_000, category_id: 11, economic_effect_sign: 1 },
    { type: "transfer", amount: 1_000, category_id: 31, economic_effect_sign: 1 },
    { type: "balance_adjustment", amount: 1_000, category_id: 31, economic_effect_sign: 1 },
  ],
  cashReport: { expenseBreakdown: [{ id: 20, name: "매입비", amount: 120, details: [{ id: 21, name: "식자재 매입", amount: 120 }] }], investmentCashFlow: 25, otherFundAdjustment: 190, operatingIncomeMovement: 105 },
};

const previous = {
  ...current,
  month: "2026-08",
  summary: { income: 100, expense: 100, operatingProfit: 0, receivedIncome: 90, actualCashOutflow: 90, otherIncome: 0 },
  profitTransactions: [{ type: "expense", amount: 100, category_id: 31, economic_effect_sign: 1 }],
  cashReport: { expenseBreakdown: [{ id: 20, name: "매입비", amount: 90, details: [] }], investmentCashFlow: 0, otherFundAdjustment: 200, operatingIncomeMovement: 90 },
};

test("dashboard cash KPIs use received income and actual cash outflow while preserving P&L", () => {
  const report = buildDashboardReport(current, previous);
  assert.deepEqual({ income: report.kpis.income, expense: report.kpis.expense, cashDifference: report.kpis.cashDifference }, { income: 105, expense: 120, cashDifference: -15 });
  assert.deepEqual(report.profitAndLoss, { income: 110, expense: 130, operatingProfit: -20 });
  assert.equal(report.profitAndLoss.operatingProfit, report.profitAndLoss.income - report.profitAndLoss.expense);
  assert.equal(report.income.reduce((sum, row) => sum + row.amount, 0), current.summary.receivedIncome);
  assert.equal(report.expenses.reduce((sum, row) => sum + row.amount, 0), current.summary.actualCashOutflow);
  assert.equal(report.kpis.cashDifference, current.summary.receivedIncome - current.summary.actualCashOutflow);
});

test("month and percentage comparisons handle ordinary, zero-base and sign-crossing values", () => {
  assert.equal(previousLedgerMonth("2026-01"), "2025-12");
  assert.ok(Math.abs(percentageChange(112.4, 100)! - 12.4) < 1e-9);
  assert.equal(percentageChange(10, 0), null);
  assert.equal(percentageChange(20, -10), 300);
  assert.ok(Number.isFinite(percentageChange(-20, 10)!));
  assert.deepEqual(cashDifferenceChange(10, -5), { percent: null, transition: "deficit_to_surplus" });
  assert.deepEqual(cashDifferenceChange(-10, 5), { percent: null, transition: "surplus_to_deficit" });
  assert.deepEqual(cashDifferenceChange(10, 0), { percent: null, transition: null });
});

test("expense leaves roll through their parent to the top level and corrections reduce the net amount", () => {
  const rows = buildExpenseBreakdown(categories, current.profitTransactions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "매입비");
  assert.equal(rows[0].amount, 130);
  assert.deepEqual(rows[0].details.map((row) => [row.name, row.amount]), [["식자재 매입", 80], ["주류 매입", 50]]);
});

test("investment, transfer and balance adjustment stay outside P&L breakdowns", () => {
  const expenses = buildExpenseBreakdown(categories, current.profitTransactions);
  const income = buildIncomeBreakdown(categories, current.profitTransactions);
  assert.equal(expenses[0].amount, 130);
  // Child income categories roll up to their top-level parent (영업수입).
  assert.deepEqual(income.map((row) => [row.name, row.amount]), [["영업수입", 110]]);
});

test("business fund balance excludes card clearing and non-business accounts", () => {
  assert.equal(sumBusinessFundBalances(current.accounts, "balance"), 1_000);
  assert.equal(sumBusinessFundBalances(current.accounts, "openingBalance"), 800);
});

test("operating income absorbs 예금이자 and expands to memo details, including the interest, whose net sum matches", () => {
  const incomeCategories = [
    { id: 1, name: "영업수입", kind: "income" as const, parent_id: null },
    { id: 2, name: "POS 매출", kind: "income" as const, parent_id: 1 },
    { id: 3, name: "예금이자", kind: "income" as const, parent_id: 1 },
  ];
  const directIncome = [5_200_000, 280_000, 172_800, 40_000, 70_000];
  const rows = buildIncomeBreakdown(
    incomeCategories,
    [
      ...directIncome.map((amount) => ({ type: "income", amount, category_id: 1, economic_effect_sign: 1 })),
      { type: "income", amount: 10_000, category_id: 3, economic_effect_sign: 1 },
    ],
    [
      { id: 1, type: "income", amount: 5_200_000, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "balentinr 21 · 9월 시트 현금수입 · Vương 계정 수입", category: { id: 1 } },
      { id: 2, type: "income", amount: 280_000, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "pizza mv · 9월 시트 현금수입", category: { id: 1 } },
      { id: 3, type: "income", amount: 172_800, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "br10 · Vương 계정 수입", category: { id: 1 } },
      { id: 4, type: "income", amount: 40_000, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "ruou trai tien thua", category: { id: 1 } },
      { id: 5, type: "income", amount: 70_000, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "tien tai nghe", category: { id: 1 } },
      { id: 6, type: "income", amount: 10_000, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "interest", category: { id: 3 } },
    ],
    "2026-09",
  );
  const operatingIncome = rows.find((row) => row.id === 1)!;
  assert.equal(rows.length, 1);
  assert.equal(operatingIncome.amount, 5_762_800 + 10_000);
  assert.equal(operatingIncome.details.reduce((sum, row) => sum + row.amount, 0), operatingIncome.amount);
  assert.deepEqual(operatingIncome.details.map((row) => row.name), ["balentinr 21", "pizza mv", "br10", "tien tai nghe", "ruou trai tien thua", "예금이자 · interest"]);
  assert.equal(rows.find((row) => row.id === 3), undefined, "no separate 예금이자 top-level row");
});

test("breakdown rows carry previous-month change and cash flow reuses actual-cash report values", () => {
  const report = buildDashboardReport(current, previous);
  assert.ok(!("expenseComparison" in report));
  assert.deepEqual(report.expenses.map((row) => [row.name, row.change]), [["매입비", { kind: "percent", percent: 33.33333333333333 }]]);
  assert.deepEqual(report.income.map((row) => [row.name, row.change]), [["실제 매출입금", { kind: "percent", percent: ((85 - 90) / 90) * 100 }], ["영업수입", { kind: "new" }]]);
  assert.deepEqual(breakdownChange(0, 0), { kind: "none" });
  assert.deepEqual(breakdownChange(10, 0), { kind: "new" });
  assert.deepEqual(breakdownChange(100, 100), { kind: "none" });
  assert.deepEqual(breakdownChange(90, 100), { kind: "percent", percent: -10 });
  assert.deepEqual(breakdownChange(0, 100), { kind: "percent", percent: -100 });
  assert.deepEqual(report.cashFlow, { openingBalance: 800, receivedIncome: 105, investmentCashFlow: 25, otherFundAdjustment: 190, actualCashOutflow: 120, closingBalance: 1_000, reconciliationDifference: 0 });
});

test("actual cash expense categories trace split payable allocations and payroll while investments stay separate", () => {
  const transactions = [
    { id: 1, type: "payable_payment", status: "confirmed", business_date: "2026-09-10", source_type: "payable_payment", movements: [{ amount: -100, fund_account: { id: 1 } }] },
    { id: 2, type: "payroll_payment", status: "confirmed", business_date: "2026-09-11", source_type: "payroll", movements: [{ amount: -50, fund_account: { id: 1 } }] },
    { id: 3, type: "investment", status: "confirmed", business_date: "2026-09-12", source_type: "owner_investment", movements: [{ amount: 200, fund_account: { id: 1 } }] },
    { id: 4, type: "balance_adjustment", status: "confirmed", business_date: "2026-09-13", source_type: "owner_recovery", source_key: "owner-capital-recovery:4", movements: [{ amount: -30, fund_account: { id: 1 } }] },
    { id: 5, type: "transfer", status: "confirmed", business_date: "2026-09-14", source_type: "manual", movements: [{ amount: -20, fund_account: { id: 1 } }, { amount: 20, fund_account: { id: 2 } }] },
    { id: 6, type: "expense", status: "confirmed", business_date: "2026-09-15", source_type: "manual", category: { id: 31 }, movements: [{ amount: -25, fund_account: { id: 1 } }] },
    { id: 7, type: "investment", status: "confirmed", business_date: "2026-09-16", source_type: "owner_investment", movements: [] },
    { id: 8, type: "balance_adjustment", status: "confirmed", business_date: "2026-09-17", source_type: "technical_adjustment", source_key: "rebook:8", movements: [{ amount: -999, fund_account: { id: 1 } }] },
  ];
  const expenseCategories = [...categories, { id: 40, name: "인건비", kind: "expense" as const, parent_id: null }];
  const report = buildDashboardCashReport(transactions, expenseCategories, [
    { paymentTransactionId: 1, allocatedAmount: 60, expenseCategoryId: 31 },
    { paymentTransactionId: 1, allocatedAmount: 40, expenseCategoryId: 32 },
  ], new Set([1, 2]), "2026-09");
  assert.equal(report.expenseBreakdown.reduce((sum, row) => sum + row.amount, 0), 175);
  assert.deepEqual(report.expenseBreakdown.map((row) => [row.name, row.amount]), [["매입비", 125], ["인건비", 50]]);
  assert.equal(report.investmentCashFlow, 170);
  assert.equal(report.otherFundAdjustment, 0);
});

test("2026-09 fixture keeps actual cash KPIs separate from accounting profit", () => {
  const september = {
    ...current,
    summary: { income: 579_622_609, expense: 339_583_774, operatingProfit: 240_038_835, receivedIncome: 582_481_169, actualCashOutflow: 492_982_775, otherIncome: 5_762_800 },
    cashReport: { expenseBreakdown: [{ id: 20, name: "매입비", amount: 492_982_775, details: [] }], investmentCashFlow: -130_000_000, otherFundAdjustment: 0, operatingIncomeMovement: 582_481_169 },
  };
  const report = buildDashboardReport(september, previous);
  assert.equal(report.kpis.income, 582_481_169);
  assert.equal(report.kpis.expense, 492_982_775);
  assert.equal(report.kpis.cashDifference, 89_498_394);
  assert.equal(report.profitAndLoss.operatingProfit, 240_038_835);
  assert.equal(report.kpis.operatingProfit, september.summary.operatingProfit);
  assert.equal(report.cashFlow.investmentCashFlow, -130_000_000);
});

test("operating profit KPI reuses the summary value and the sign-safe month comparison", () => {
  const report = buildDashboardReport(current, previous);
  assert.equal(report.kpis.operatingProfit, current.summary.operatingProfit);
  assert.equal(report.kpis.operatingProfit, report.profitAndLoss.operatingProfit);
  assert.ok(!("businessFundBalance" in report.kpis));
  assert.deepEqual(report.kpis.operatingProfitChange, { percent: null, transition: null });
  const withSummary = (operatingProfit: number) => ({ ...current, summary: { ...current.summary, operatingProfit } });
  assert.deepEqual(buildDashboardReport(withSummary(50), withSummary(-10)).kpis.operatingProfitChange, { percent: null, transition: "deficit_to_surplus" });
  assert.deepEqual(buildDashboardReport(withSummary(-50), withSummary(10)).kpis.operatingProfitChange, { percent: null, transition: "surplus_to_deficit" });
  assert.deepEqual(buildDashboardReport(withSummary(120), withSummary(100)).kpis.operatingProfitChange, { percent: 20, transition: null });
  assert.equal(report.cashFlow.closingBalance, sumBusinessFundBalances(current.accounts, "balance"));
});

test("dashboard KPI shows operating profit instead of the fund balance, which stays in the cash-flow card", () => {
  const kpiSection = dashboardCompact.match(/<sectionclassName=\{styles\.kpiGrid\}.*?<\/section>/)![0];
  assert.match(kpiSection, /<KpiCardicon="📊"label=\{copy\.operatingProfit\}amount=\{report\.kpis\.operatingProfit\}\{\.\.\.signedTrend\(report\.kpis\.operatingProfitChange,copy\)\}action=\{detailButton\}\/>\}<\/section>/);
  assert.match(kpiSection, /\{\.\.\.signedTrend\(report\.kpis\.cashDifferenceChange,copy\)\}/);
  assert.doesNotMatch(kpiSection, /🏦|copy\.balance|businessFundBalance/);
  assert.match(dashboardCompact, /<span>\{fundsMode==="live"\?copy\.balance:copy\.monthEndBalance\}<\/span><strong>\{compactMoney\(report\.cashFlow\.closingBalance\)\}/);
  assert.match(dashboardCompact, /label=\{copy\.operatingIncome\}amount=\{report\.profitAndLoss\.income\}/);
  assert.match(dashboardCompact, /label=\{copy\.operatingExpense\}amount=\{report\.profitAndLoss\.expense\}/);
  assert.match(dashboardCompact, /label=\{copy\.operatingProfit\}amount=\{report\.profitAndLoss\.operatingProfit\}/);
  assert.doesNotMatch(dashboardPage, /손익 현황|회계상 수익|회계상 비용|Doanh thu kế toán|Chi phí kế toán|📋/);
  assert.match(dashboardStylesCompact, /\.sectionNote\{[^}]*color:#9ca3af;[^}]*font-size:11px;/);
  const order = ["copy.operatingProfit}amount={report.kpis.operatingProfit}", "copy.incomeComposition}", "copy.expenseComposition}", "copy.cashFlow}"].map((marker) => dashboardCompact.indexOf(marker));
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > order[position - 1])), order.join(","));
});

test("ledger API exposes the same recognition-month profit rows used by summary calculations", () => {
  assert.match(route, /select\("type,amount,economic_effect_sign,category_id"\)/);
  assert.match(route, /profitTransactions: profitRows/);
  assert.match(route, /expense, operatingProfit: recognizedIncome - expense/);
  assert.match(route, /cashReport, accounts/);
  assert.match(route, /loadPayableAllocationCategories/);
});

test("admin remains the original role-filtered management menu without monthly-report UI", () => {
  for (const href of ["/admin/sales", "/admin/users", "/admin/payroll/attendance", "/admin/ledger", "/admin/partners", "/admin/pos/mappings", "/admin/settings/store"]) assert.match(adminPage, new RegExp(`href: "${href}"`));
  assert.match(adminPage, /const visibleMenus/);
  assert.match(adminPage, /case "manage": return isManage\(currentUser\)/);
  assert.match(adminPage, /case "admin": return isAdmin\(currentUser\)/);
  assert.doesNotMatch(adminPage, /buildDashboardReport|getBusinessDate|profitTransactions|당월 수입|수입 구성|지출 구성/);
  assert.doesNotMatch(adminPage, /\/api\/admin\/ledger\?month=/);
});

test("ledger root contains the monthly report and replaces the legacy summary dashboard", () => {
  assert.match(dashboardCompact, /<KpiCardicon="💰"label=\{copy\.income\}/);
  assert.match(dashboardCompact, /<BreakdownCardicon="📊"title=\{copy\.incomeComposition\}/);
  assert.match(dashboardCompact, /copy\.expenseComposition/);
  assert.match(dashboardCompact, /copy\.cashFlow/);
  assert.doesNotMatch(dashboardPage, /\/api\/admin\/ledger\/candidates|transactions\.slice\(0, 5\)|function Summary/);
  // The month-over-month card and the in-dashboard shortcut section are gone.
  assert.doesNotMatch(dashboardPage, /expenseChange:|expenseComparison|전월 대비 지출 변화|quickLinks|quickSection|장부 주요 기능|Chức năng sổ cái|🔄|<Link|next\/link/);
  assert.doesNotMatch(dashboardStyles, /\.quick(Section|Links|Label)|\.comparisonPercent|\.signPlus|\.signMinus/);
  // The feature routes themselves still exist and the ledger tabs are unchanged.
  for (const route of ["entries", "card-settlements", "payables", "owners", "settings"]) assert.ok(existsSync(`app/(protected)/admin/ledger/${route}/page.tsx`), route);
});

test("month selection uses the BABA business date, URL month query and stale-response guards", () => {
  assert.match(dashboardCompact, /selectedLedgerMonth\(searchParams\.get\("month"\),getBusinessDate\(\)\.slice\(0,7\)\)/);
  assert.doesNotMatch(dashboardPage, /Intl\.DateTimeFormat/);
  assert.match(dashboardCompact, /router\.push\(ledgerMonthHref\(pathname,searchParams\.toString\(\),nextMonth\)/);
  assert.match(dashboardCompact, /Promise\.all\(\[fetch\(`\/api\/admin\/ledger\?month=\$\{month\}`/);
  assert.match(dashboardCompact, /requestSequence!==requestSequenceRef\.current/);
  assert.match(dashboardCompact, /currentBody\.month!==month\|\|previousBody\.month!==previousMonth/);
  assert.doesNotMatch(dashboardPage, /periodNetChange|investmentsBody/);
  assert.match(dashboardCompact, /controller\.abort\(\);requestSequenceRef\.current\+=1/);
});

test("ledger dashboard uses the compact entries-style month control and direction-only trend colors", () => {
  assert.match(dashboardCompact, /<ContainernoPaddingTop>/);
  assert.match(dashboardStylesCompact, /\.page\{display:grid;gap:10px;padding:8px024px;/);
  assert.match(dashboardStylesCompact, /\.monthNavigation\{display:grid;grid-template-columns:autominmax\(0,1fr\)auto;/);
  assert.match(dashboardStylesCompact, /\.monthButton\{min-height:36px;padding:9px10px;/);
  assert.match(dashboardStylesCompact, /\.monthButton\{[^}]*border:1pxsolid#111827;[^}]*background:#111827;[^}]*color:#fff;/);
  assert.match(dashboardStylesCompact, /\.monthInput\{width:100%;min-width:0;min-height:36px;/);
  assert.match(dashboardStylesCompact, /\.kpiGrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:6px;/);
  assert.match(dashboardStylesCompact, /\.barTrack\{display:block;height:5px;/);
  assert.match(dashboardStylesCompact, /\.trendUp\{color:#16805a;/);
  assert.match(dashboardStylesCompact, /\.trendDown\{color:#b4493e;/);
  assert.match(entriesStyles, /\.page\{max-width:800px;margin:0 auto;padding:8px 16px calc\(150px \+ env\(safe-area-inset-bottom\)\)/);
  for (const icon of ["💰", "💸", "📈", "📊", "📉", "💵"]) assert.ok(dashboardPage.includes(icon));
});

test("ledger layout authorization, subnav and child-route contract remain unchanged", () => {
  assert.match(ledgerLayout, /requireRole\(LEDGER_MANAGER_ROLES\)/);
  assert.match(ledgerLayout, /<LedgerSubNav \/>/);
  for (const href of ["/admin/ledger", "/admin/ledger/entries", "/admin/ledger/settings"]) assert.match(ledgerTabs, new RegExp(href));
});

test("dashboard keeps the requested Korean and Vietnamese core labels", () => {
  for (const label of ["당월 수입", "당월 지출", "영업이익", "현재 보유금", "월말 보유금", "당월 영업수익", "당월 영업비용", "실제 입출금일이 아닌 해당 월에 발생한 수익·비용 기준", "수입 구성", "지출 구성", "이번 달 자금 흐름", "신규", "Mới", "급여 지급", "Chi trả lương", "Thu nhập tháng", "Chi phí tháng", "Lợi nhuận hoạt động", "Doanh thu kinh doanh tháng", "Chi phí kinh doanh tháng", "không theo ngày thu chi thực tế", "Tiền hiện có", "Tiền cuối tháng", "Dòng tiền tháng này"])assert.match(dashboardPage, new RegExp(label));
});

test("income composition folds 예금이자 into 영업수입 and still totals receivedIncome", () => {
  const incomeCategories = [
    { id: 1, name: "영업수입", kind: "income" as const, parent_id: null },
    { id: 3, name: "예금이자", kind: "income" as const, parent_id: 1 },
  ];
  const september = {
    ...current,
    categories: incomeCategories,
    summary: { ...current.summary, receivedIncome: 582_481_169, otherIncome: 5_819_069 },
    profitTransactions: [
      { type: "income", amount: 5_762_800, category_id: 1, economic_effect_sign: 1 },
      { type: "income", amount: 56_269, category_id: 3, economic_effect_sign: 1 },
    ],
    transactions: [
      { id: 11, type: "income", amount: 5_000_000, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "balentinr 21", category: { id: 1 } },
      { id: 12, type: "income", amount: 762_800, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: "pizza mv", category: { id: 1 } },
      { id: 13, type: "income", amount: 56_269, economic_effect_sign: 1, recognition_month: "2026-09-01", memo: null, category: { id: 3 } },
    ],
  };
  const report = buildDashboardReport(september, previous);
  assert.deepEqual(report.income.map((row) => [row.name, row.amount]), [["실제 매출입금", 576_662_100], ["영업수입", 5_819_069]]);
  assert.equal(report.income.reduce((sum, row) => sum + row.amount, 0), september.summary.receivedIncome);
  assert.ok(!report.income.some((row) => row.name === "예금이자"));
  const operatingIncome = report.income.find((row) => row.name === "영업수입")!;
  assert.deepEqual(operatingIncome.details.find((row) => row.id === 13), { id: 13, name: "예금이자", amount: 56_269 });
  assert.equal(report.income.find((row) => row.id === -1)!.details.length, 0, "실제 매출입금 does not expand");
});

test("dashboard UI: KPI amount colors, adjacent detail button, shared category chevrons, no expense ledger link, red cost amounts in the modal", () => {
  assert.match(dashboardCompact, /<KpiCardicon="💰"label=\{copy\.income\}amount=\{report\.kpis\.income\}change=\{report\.kpis\.incomeChange\}amountClass=\{styles\.trendUp\}\/>/);
  assert.match(dashboardCompact, /<KpiCardicon="💸"label=\{copy\.expense\}amount=\{report\.kpis\.expense\}change=\{report\.kpis\.expenseChange\}amountClass=\{styles\.trendDown\}\/>/);
  assert.match(dashboardCompact, /<strongclassName=\{`\$\{styles\.kpiAmount\}\$\{amountClass\}`\}>/);
  assert.doesNotMatch(dashboardCompact, /<KpiCardicon="📈"[^>]*amountClass/);
  assert.ok(dashboardStylesCompact.indexOf(".trendUp{") > dashboardStylesCompact.indexOf(".kpiAmount{"), "trend color overrides the KPI amount color");

  // Income and expense rows share one CategoryRow with the same ▶/▼ chevron column and toggle button.
  assert.match(dashboardCompact, /functionIncomeRow\([^]*?return<CategoryRow[^]*?expandable=\{row\.details\.length>0\}/);
  assert.match(dashboardCompact, /functionExpenseRow\([^]*?return<CategoryRow[^]*?expandable/);
  assert.match(dashboardCompact, /<spanclassName=\{styles\.chevron\}aria-hidden="true">\{expandable\?expanded\?"▼":"▶":""\}<\/span>/);
  assert.match(dashboardCompact, /\{expandable\?<buttontype="button"className=\{styles\.expenseToggle\}aria-expanded=\{expanded\}onClick=\{onToggle\}>\{content\}<\/button>:<divclassName=\{styles\.staticToggle\}>\{content\}<\/div>\}/);
  assert.match(dashboardStylesCompact, /\.expenseToggle\.breakdownHeader,\.staticToggle\.breakdownHeader\{grid-template-columns:12pxminmax\(0,1fr\)autoauto;\}/);
  assert.doesNotMatch(dashboardPage, /[▸▾]/);

  // Expense card no longer links to the ledger; quick links stay.
  assert.doesNotMatch(dashboardPage, /ledgerLink|장부에서 보기|Xem trong sổ cái/);
  assert.doesNotMatch(dashboardStyles, /\.ledgerLink/);

  // Modal: only cost amounts are red; labels and revenue/profit amounts keep the default color; no sign coloring.
  assert.doesNotMatch(dashboardPage, /signPlus|signMinus|<ReportValue sign=/);
  assert.match(dashboardCompact, /<spanclassName=\{styles\.comparisonName\}>\{label\}<\/span><strongclassName=\{`\$\{styles\.comparisonAmount\}\$\{amount===null\?styles\.reportPending:expense\?styles\.expenseAmount:""\}`\}>/);
  assert.match(dashboardStylesCompact, /\.expenseAmount\{color:#b4493e;\}/);
  const sheet = dashboardCompact.slice(dashboardCompact.indexOf("functionOperatingProfitSheet("), dashboardCompact.indexOf("functionKpiCard("));
  const rows = [...sheet.matchAll(/<ReportValue(expense)?label=\{(.*?)\}amount=\{.*?\}(.*?)\/>/g)].map((match) => [match[2], Boolean(match[1]) || /expense/.test(match[3])]);
  assert.deepEqual(rows, [
    ["copy.operatingIncome", false],
    ["copy.ledgerExpense", true],
    ["`+${copy.unrecognizedPayroll}`", true],
    ["`+${copy.cardFeeEstimate}`", true],
    ["copy.provisionalExpense", true],
    ["copy.provisionalOperatingProfit", false],
    ["copy.operatingIncome", false],
    ["copy.operatingExpense", true],
    ["copy.operatingProfit", false],
  ]);

  // Month change sits beside the main category name; details carry none.
  assert.match(dashboardCompact, /<spanclassName=\{styles\.breakdownLabel\}><spanclassName=\{styles\.breakdownName\}>\{name\}<\/span>\{change\}<\/span><strongclassName=\{styles\.breakdownAmount\}>/);
  assert.match(dashboardCompact, /change=\{<MonthChangechange=\{row\.change\}increaseIsGoodnewLabel=\{newLabel\}\/>\}/);
  assert.match(dashboardCompact, /change=\{<MonthChangechange=\{row\.change\}increaseIsGood=\{false\}newLabel=\{newLabel\}\/>\}/);
  assert.match(dashboardCompact, /consttone=change\.kind==="none"\?"":increased===increaseIsGood\?styles\.trendUp:styles\.trendDown;/);
  assert.match(dashboardCompact, /change\.kind==="new"\?newLabel:change\.kind==="percent"\?`\$\{change\.percent>0\?"▲":"▼"\}\$\{Math\.abs\(change\.percent\)\.toFixed\(1\)\}%`:"-"/);
  assert.match(dashboardCompact, /<divclassName=\{styles\.detailRow\}key=\{detail\.id\}><span>\{detailName\(detail\.name\)\}<\/span><strong>\{money\(detail\.amount\)\}<\/strong><\/div>/);
  assert.match(dashboardStylesCompact, /\.rowChange\{flex-shrink:0;color:#9ca3af;font-size:9px;/);
});

test("every actual-cash expense row equals the sum of its details; payroll_payment appears as 급여 지급", () => {
  const cats = [
    { id: 20, name: "매입비", kind: "expense" as const, parent_id: null },
    { id: 21, name: "식자재 매입", kind: "expense" as const, parent_id: 20 },
    { id: 22, name: "주류 매입", kind: "expense" as const, parent_id: 20 },
    { id: 40, name: "인건비", kind: "expense" as const, parent_id: null },
    { id: 41, name: "보험·복리후생", kind: "expense" as const, parent_id: 40 },
    { id: 42, name: "직원 식대", kind: "expense" as const, parent_id: 40 },
    { id: 43, name: "직원 주거비", kind: "expense" as const, parent_id: 40 },
    { id: 50, name: "공과금", kind: "expense" as const, parent_id: null },
    { id: 51, name: "전기료", kind: "expense" as const, parent_id: 50 },
    { id: 60, name: "임차·시설비", kind: "expense" as const, parent_id: null },
    { id: 61, name: "임대료", kind: "expense" as const, parent_id: 60 },
    { id: 70, name: "일반관리비", kind: "expense" as const, parent_id: null },
  ];
  let id = 0;
  const out = (type: string, amount: number, extra: Record<string, unknown> = {}) => ({
    id: ++id, type, status: "confirmed", business_date: "2026-09-10", source_type: "manual",
    movements: [{ amount: -amount, fund_account: { id: 1 } }], ...extra,
  });
  const transactions = [
    out("expense", 23_465_000, { category: { id: 41 } }),
    out("expense", 8_190_000, { category: { id: 42 } }),
    out("expense", 2_500_000, { category: { id: 43 } }),
    out("payroll_payment", 100_000_000, { source_type: "payroll_payment_group" }),
    out("payroll_payment", 53_405_248, { source_type: "payroll_payment_group" }),
    out("payable_payment", 1_000, { source_type: "payable_payment" }), // id 6: 600 + 300 allocated, 100 unallocated
    out("expense", 700, { category: { id: 51 } }),
    out("expense", 50, { category: { id: 50 } }), // booked on the parent itself
    out("expense", 900, { category: { id: 61 } }),
    out("expense", 120, { category: { id: 70 } }),
    out("prepaid_expense_payment", 80, { source_snapshot: { categoryId: 61 } }),
    out("prepaid_expense_payment", 40),
    out("balance_adjustment", 30, { source_key: "sheet-balance-adjustment:1" }),
    out("expense", 20, { source_type: "ledger_correction", source_snapshot: { adjustmentType: "employee_meal" } }),
    out("expense", 10),
  ];
  const report = buildDashboardCashReport(transactions, cats, [
    { paymentTransactionId: 6, allocatedAmount: 600, expenseCategoryId: 21 },
    { paymentTransactionId: 6, allocatedAmount: 300, expenseCategoryId: 22 },
  ], new Set([1]), "2026-09");
  const rows = report.expenseBreakdown;
  const total = transactions.reduce((sum, row) => sum + Number(row.movements[0].amount) * -1, 0);
  assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), total, "rows still total actual cash outflow");
  for (const row of rows) {
    assert.ok(row.details.length > 0, `${row.name} has details`);
    assert.ok(Math.abs(row.details.reduce((sum, detail) => sum + detail.amount, 0) - row.amount) < 0.001, `${row.name} parent === Σ details`);
  }
  const byName = new Map(rows.map((row) => [row.name, row]));
  const labor = byName.get("인건비")!;
  assert.equal(labor.amount, 187_560_248);
  assert.deepEqual(labor.details.map((detail) => [detail.name, detail.amount]), [["급여 지급", 153_405_248], ["보험·복리후생", 23_465_000], ["직원 식대", 8_190_000], ["직원 주거비", 2_500_000]]);
  // 매입비 keeps payable-allocation tracing to the original categories.
  assert.deepEqual(byName.get("매입비")!.details.map((detail) => [detail.name, detail.amount]), [["식자재 매입", 600], ["주류 매입", 300]]);
  assert.deepEqual(byName.get("공과금")!.details.map((detail) => [detail.name, detail.amount]), [["전기료", 700], ["세부분류 없음", 50]]);
  assert.deepEqual(byName.get("임차·시설비")!.details.map((detail) => [detail.name, detail.amount]), [["임대료", 980]]);
  assert.deepEqual(byName.get("일반관리비")!.details.map((detail) => [detail.name, detail.amount]), [["세부분류 없음", 120]]);
  assert.deepEqual(byName.get("이월·기타조정")!.details.map((detail) => [detail.name, detail.amount]), [["잔액 조정", 30], ["장부 정정", 20]]);
  assert.deepEqual(byName.get("선급·기타지출")!.details.map((detail) => [detail.name, detail.amount]), [["선급비용 지급", 40]]);
  // Causes stay distinct: only a genuinely uncategorized expense is "분류 미지정".
  assert.deepEqual(byName.get("기타 실제지출")!.details.map((detail) => [detail.name, detail.amount]), [["미배분 미지급금 지급", 100], ["분류 미지정", 10]]);
});
