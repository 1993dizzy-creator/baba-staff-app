import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const {
  buildProvisionalOperatingProfit,
  currentCardFeeRate,
  previousCardFeeRate,
  unrecognizedPayrollCost,
  MAX_PLAUSIBLE_CARD_FEE_RATE,
} = createRequire(import.meta.url)("../lib/ledger/provisional-operating-profit.ts") as typeof import("../lib/ledger/provisional-operating-profit");

const dashboardPage = readFileSync("app/(protected)/admin/ledger/page.tsx", "utf8");
const dashboardCompact = dashboardPage.replace(/\s+/g, "");
const helperSource = readFileSync("lib/ledger/provisional-operating-profit.ts", "utf8");
const payrollRoute = readFileSync("app/api/admin/payroll/overview/route.ts", "utf8");

// Ledger summary already includes welfare costs (회식, 숙박, 주거비 ...) inside expense.
const summary = { income: 1_000_000, expense: 400_000, operatingProfit: 600_000 };
const payroll = {
  summary: { totalCompanyCostAmount: 250_000, mealAllowanceAmount: 30_000 },
  projectedSummary: { totalCompanyCostAmount: 900_000, mealAllowanceAmount: 90_000 },
  paymentBatch: null,
};
const currentCard = { monthlyCardGross: 300_000, monthlySettledGross: 200_000, monthlySettlementDifference: 4_000, actualDifferenceRate: 0.5 };
const previousCard = { monthlyCardGross: 500_000, monthlySettledGross: 500_000, monthlySettlementDifference: 12_500, actualDifferenceRate: 0.025 };
const input = { isCurrentMonth: true, summary, payroll, currentCard, previousCard };

test("current month uses the current Payroll summary minus meal allowance and the current settled card rate", () => {
  const result = buildProvisionalOperatingProfit(input);
  assert.equal(result.mode, "provisional");
  assert.equal(result.needsCheck, false);
  assert.equal(result.recognizedRevenue, summary.income);
  assert.equal(result.recognizedExpense, summary.expense);
  assert.equal(result.payrollAdjustment, 220_000);
  assert.equal(result.cardFeeRateSource, "current");
  assert.equal(result.cardFeeRate, 0.02);
  assert.equal(result.unsettledCardGross, 100_000);
  assert.equal(result.estimatedCardFee, 2_000);
  assert.equal(result.provisionalExpense, summary.expense + 220_000 + 2_000);
  assert.equal(result.operatingProfit, summary.income - (summary.expense + 220_000 + 2_000));
  assert.deepEqual(result.warnings, []);
});

test("projectedSummary is never used for the provisional KPI", () => {
  const result = buildProvisionalOperatingProfit({ ...input, payroll: { ...payroll, projectedSummary: { totalCompanyCostAmount: 1e12, mealAllowanceAmount: 0 } } as typeof payroll });
  assert.equal(result.payrollAdjustment, 220_000);
  assert.doesNotMatch(helperSource.replace(/\/\/.*$/gm, ""), /projectedSummary/);
});

test("meal allowance is removed so daily ledger meal expenses are not counted twice", () => {
  const cost = unrecognizedPayrollCost(payroll)!;
  assert.equal(cost.accruedExcludingMeal, payroll.summary.totalCompanyCostAmount - payroll.summary.mealAllowanceAmount);
  assert.equal(cost.mealAllowance, 30_000);
  // Payroll overview's summary really includes meal allowance in totalCompanyCostAmount.
  assert.match(payrollRoute, /totalCompanyCostAmount:overview\.summary\.totalCompanyCostAmount\+mealAllowance\.currentAmount/);
});

test("Payroll cost already booked by a completed batch is not added again", () => {
  const completed = { ...payroll, paymentBatch: { status: "completed", actual_company_cost_total: 220_000 } };
  assert.equal(buildProvisionalOperatingProfit({ ...input, payroll: completed }).payrollAdjustment, 0);
  const partly = { ...payroll, paymentBatch: { status: "completed", actual_company_cost_total: 200_000 } };
  assert.equal(buildProvisionalOperatingProfit({ ...input, payroll: partly }).payrollAdjustment, 20_000);
  const open = { ...payroll, paymentBatch: { status: "in_progress", actual_company_cost_total: 220_000 } };
  assert.equal(buildProvisionalOperatingProfit({ ...input, payroll: open }).payrollAdjustment, 220_000);
});

test("existing ledger expenses (welfare, housing, trips) are kept, never replaced", () => {
  const result = buildProvisionalOperatingProfit(input);
  assert.equal(result.recognizedExpense, summary.expense);
  assert.ok(result.provisionalExpense! >= summary.expense);
  assert.doesNotMatch(helperSource, /인건비|categor/i);
});

test("card fee falls back to the previous month's confirmed rate when the current rate is missing", () => {
  const noCurrentRate = { ...currentCard, monthlySettledGross: 0, monthlySettlementDifference: 0 };
  const result = buildProvisionalOperatingProfit({ ...input, currentCard: noCurrentRate });
  assert.equal(result.cardFeeRateSource, "previous");
  assert.equal(result.cardFeeRate, 0.025);
  assert.equal(result.unsettledCardGross, 300_000);
  assert.equal(result.estimatedCardFee, 7_500);
  assert.equal(result.needsCheck, false);
});

test("no trustworthy rate gives a zero fee estimate marked unavailable, never a hard-coded rate", () => {
  const noCurrentRate = { ...currentCard, monthlySettledGross: 0, monthlySettlementDifference: 0 };
  const result = buildProvisionalOperatingProfit({ ...input, currentCard: noCurrentRate, previousCard: { ...previousCard, actualDifferenceRate: null } });
  assert.equal(result.cardFeeRateSource, "unavailable");
  assert.equal(result.estimatedCardFee, 0);
  assert.deepEqual(result.warnings, ["CARD_FEE_RATE_UNAVAILABLE"]);
  assert.doesNotMatch(helperSource, /0\.0[1-9]\b|\b2%/);
});

test("rate guards reject non-positive settled gross, negative, NaN, Infinity and implausible rates", () => {
  assert.equal(currentCardFeeRate({ monthlySettledGross: 0, monthlySettlementDifference: 10 }), null);
  assert.equal(currentCardFeeRate({ monthlySettledGross: -5, monthlySettlementDifference: 10 }), null);
  assert.equal(currentCardFeeRate({ monthlySettledGross: 100, monthlySettlementDifference: -1 }), null);
  assert.equal(currentCardFeeRate({ monthlySettledGross: 100, monthlySettlementDifference: Number.NaN }), null);
  assert.equal(currentCardFeeRate({ monthlySettledGross: 100, monthlySettlementDifference: Number.POSITIVE_INFINITY }), null);
  assert.equal(currentCardFeeRate({ monthlySettledGross: 100, monthlySettlementDifference: 100 * MAX_PLAUSIBLE_CARD_FEE_RATE + 1 }), null);
  assert.equal(currentCardFeeRate({ monthlySettledGross: "1000", monthlySettlementDifference: "25" }), 0.025);
  assert.equal(previousCardFeeRate({ actualDifferenceRate: null }), null);
  assert.equal(previousCardFeeRate({ actualDifferenceRate: 0.5 }), null);
  assert.equal(previousCardFeeRate({ actualDifferenceRate: 0.021 }), 0.021);
});

test("fee estimate applies only to gross not yet matched, so booked fees are not added twice", () => {
  const allSettled = buildProvisionalOperatingProfit({ ...input, currentCard: { ...currentCard, monthlySettledGross: 300_000, monthlySettlementDifference: 6_000 } });
  assert.equal(allSettled.unsettledCardGross, 0);
  assert.equal(allSettled.estimatedCardFee, 0);
  assert.equal(allSettled.provisionalExpense, summary.expense + 220_000);
  // Partial allocations have no booked fee yet, so the base is gross − matched (settled) gross.
  const partial = buildProvisionalOperatingProfit({ ...input, currentCard: { ...currentCard, monthlyUnreconciledGross: 40_000 } as typeof currentCard });
  assert.equal(partial.unsettledCardGross, 100_000);
});

test("past or closed months keep the ledger operating profit without estimates", () => {
  const result = buildProvisionalOperatingProfit({ ...input, isCurrentMonth: false });
  assert.equal(result.mode, "final");
  assert.equal(result.operatingProfit, summary.operatingProfit);
  assert.equal(result.provisionalExpense, summary.expense);
  assert.equal(result.payrollAdjustment, 0);
  assert.equal(result.estimatedCardFee, 0);
});

test("a failed Payroll or card source marks the provisional profit as needs-check instead of assuming 0", () => {
  for (const failed of [{ payroll: null }, { currentCard: null }, { payroll: { summary: { totalCompanyCostAmount: Number.NaN, mealAllowanceAmount: 0 } } }]) {
    const result = buildProvisionalOperatingProfit({ ...input, ...failed });
    assert.equal(result.needsCheck, true);
    assert.equal(result.operatingProfit, null);
    assert.equal(result.provisionalExpense, null);
  }
  const noPreviousFallback = buildProvisionalOperatingProfit({ ...input, currentCard: { ...currentCard, monthlySettledGross: 0 }, previousCard: null });
  assert.equal(noPreviousFallback.needsCheck, true);
  assert.deepEqual(noPreviousFallback.warnings, ["PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE"]);
  // Previous month is only needed as a fallback.
  assert.equal(buildProvisionalOperatingProfit({ ...input, previousCard: null }).needsCheck, false);
});

test("dashboard loads Payroll/card sources only for the current month, in parallel, without failing the base report", () => {
  assert.match(dashboardCompact, /constisCurrentMonth=month===getBusinessDate\(\)\.slice\(0,7\);/);
  assert.match(dashboardCompact, /constprovisionalPromise=isCurrentMonth\?loadProvisionalSources\(month,previousMonth,controller\.signal\):Promise\.resolve\(null\);const\[currentResponse,previousResponse\]=awaitPromise\.all/);
  for (const url of ["/api/admin/payroll/overview?month=${month}", "/api/admin/ledger/card-settlements?month=${month}", "/api/admin/ledger/card-settlements?month=${previousMonth}"]) assert.ok(dashboardPage.includes(url), url);
  assert.match(dashboardCompact, /asyncfunctionloadOptionalMonthBody[^]*?catch\{returnnull;\}/);
  assert.match(dashboardCompact, /body\?\.month===month\?pick\(body\):null/);
  // Existing stale guards stay intact.
  assert.match(dashboardCompact, /requestSequence!==requestSequenceRef\.current/);
  assert.match(dashboardCompact, /currentBody\.month!==month\|\|previousBody\.month!==previousMonth/);
  assert.match(dashboardCompact, /controller\.abort\(\);requestSequenceRef\.current\+=1/);
  assert.match(dashboardCompact, /isCurrentMonth:isCurrentMonth&&dashboardState\.provisional!==null&&dashboardState\.current\.fundsView\.mode==="live"/);
});

test("KPI and P&L card switch between provisional (current) and final (past) labels", () => {
  assert.match(dashboardCompact, /operatingResult\.mode==="provisional"(\/\/[^?]*)?\?<KpiCardicon="📊"label=\{copy\.provisionalOperatingProfit\}amount=\{operatingResult\.operatingProfit\}note=\{operatingResult\.needsCheck\?copy\.needsCheck:copy\.provisional\}trendDirection=\{operatingResult\.needsCheck\?"down":undefined\}action=\{detailButton\}\/>/);
  assert.match(dashboardCompact, /:<KpiCardicon="📊"label=\{copy\.operatingProfit\}amount=\{report\.kpis\.operatingProfit\}\{\.\.\.signedTrend\(report\.kpis\.operatingProfitChange,copy\)\}action=\{detailButton\}\/>\}/);
  for (const key of ["operatingIncome", "ledgerExpense", "unrecognizedPayroll", "cardFeeEstimate", "provisionalExpense", "provisionalOperatingProfit", "provisionalNote", "estimateUnavailable", "needsCheck"]) assert.match(dashboardPage, new RegExp(`copy\\.${key}`));
  for (const label of ["잠정 영업이익", "현재 장부비용", "미반영 급여비용", "미정산 카드수수료 예상", "잠정 영업비용", "현재까지 발생 기준 · 미확정 급여와 카드수수료 예상분 포함", "계산 확인 필요", "예상 불가",
    "Lợi nhuận tạm tính", "Chi phí đã ghi sổ", "Chi phí lương chưa ghi sổ", "Phí thẻ chưa quyết toán (ước tính)", "Chi phí tạm tính", "gồm lương chưa chốt và phí thẻ ước tính", "Cần kiểm tra", "Chưa ước tính được"]) assert.ok(dashboardPage.includes(label), label);
});

test("main P&L card is removed and its rows live in the operating-profit detail sheet", () => {
  const dashboardStylesCompact = readFileSync("app/(protected)/admin/ledger/ledger-dashboard.module.css", "utf8").replace(/\s+/g, "");
  const body = dashboardCompact.slice(dashboardCompact.indexOf("functionDashboardReport("), dashboardCompact.indexOf("functionOperatingProfitSheet("));
  assert.doesNotMatch(body, /copy\.profitAndLoss\}|<ReportValue/);
  assert.doesNotMatch(dashboardPage, /profitAndLoss:|영업 손익"|Lãi lỗ kinh doanh|급여 발생분 반영|Lương phát sinh chưa ghi sổ|payrollAccrual/);
  // Main order: KPI → income → expense → cash flow.
  const order = ["className={styles.kpiGrid}", "copy.incomeComposition}", "copy.expenseComposition}", "copy.cashFlow}"].map((marker) => body.indexOf(marker));
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > order[position - 1])), order.join(","));

  // KPI meta is one compact row: status text + small pill button, same height rules for all four cards.
  assert.match(dashboardCompact, /<spanclassName=\{styles\.kpiMetaRow\}><spanclassName=\{`\$\{styles\.kpiMeta\}\$\{trendClass\}`\}>\{note\?\?trendLabel\?\?trend\}<\/span>\{action\}<\/span><\/article>/);
  // Detail button sits right next to the status text; row stays 16px so KPI height does not grow.
  assert.match(dashboardStylesCompact, /\.kpiMetaRow\{display:flex;align-items:center;justify-content:flex-start;gap:7px;min-width:0;min-height:16px;margin-top:4px;\}/);
  assert.match(dashboardStylesCompact, /\.kpiDetailButton\{flex-shrink:0;height:18px;margin:-1px0;padding:08px;border:1pxsolid#374151;border-radius:999px;background:#374151;color:#fff;font-size:10px;font-weight:800;line-height:16px;/);
  assert.equal((dashboardPage.match(/action=\{detailButton\}/g) ?? []).length, 2, "current and past KPI share the same button");
  assert.match(dashboardCompact, /\{note\?\?trendLabel\?\?trend\}<\/span>\{action\}<\/span>/, "status text first, button adjacent");
  assert.match(dashboardStylesCompact, /\.kpiGrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:6px;/);

  // Open / close through the shared ledger BarSheet (backdrop, × button, Escape, body scroll lock).
  assert.match(dashboardPage, /import \{ BarSheet \} from "@\/components\/bar\/keeping\/KeepingUi";/);
  assert.match(dashboardCompact, /<buttonref=\{detailButtonRef\}type="button"className=\{styles\.kpiDetailButton\}aria-haspopup="dialog"onClick=\{\(\)=>setOperatingDetailOpen\(true\)\}>\{copy\.detail\}›<\/button>/);
  assert.match(dashboardCompact, /\{operatingDetailOpen\?<OperatingProfitSheetcopy=\{copy\}report=\{report\}operatingResult=\{operatingResult\}returnFocusRef=\{detailButtonRef\}onClose=\{\(\)=>setOperatingDetailOpen\(false\)\}\/>:null\}/);
  assert.doesNotMatch(dashboardPage, /<BarSheet kind="bottom"/);
  // Read-only detail uses the shared BarSheet's centered compact mode (all corners rounded, auto height, inner scroll).
  const keepingUi = readFileSync("components/bar/keeping/KeepingUi.tsx", "utf8");
  assert.match(keepingUi, /alignItems:topAligned\?"flex-start":kind==="bottom"\?"flex-end":"center"/);
  assert.match(keepingUi, /height:fillAvailable\?`calc\(100dvh - \$\{topMargin\} - 8px\)`:kind==="full"&&!compact\?"min\(92vh,92dvh,820px\)":"auto"/);
  assert.match(keepingUi, /maxHeight:topAligned\?`calc\(100dvh - \$\{topMargin\} - 8px\)`:kind==="bottom"\?"min\(86vh,86dvh\)":compact\?"min\(92vh,92dvh\)":undefined/);
  assert.match(keepingUi, /borderRadius:topAligned\?16:kind==="bottom"\?"18px 18px 0 0":16/);
  assert.match(dashboardCompact, /<BarSheetkind="full"compacttitle=\{`📊\$\{provisional\?copy\.provisionalDetailTitle:copy\.operatingProfitDetailTitle\}`\}closeLabel=\{copy\.close\}onClose=\{onClose\}/);
  assert.match(dashboardCompact, /footer=\{<buttontype="button"className=\{styles\.sheetCloseButton\}onClick=\{onClose\}>\{copy\.close\}<\/button>\}/);
});

test("detail sheet renders the same provisional result as the KPI, with fail-safe fallbacks", () => {
  const sheet = dashboardCompact.slice(dashboardCompact.indexOf("functionOperatingProfitSheet("), dashboardCompact.indexOf("functionKpiCard("));
  const provisional = sheet.slice(sheet.indexOf("{provisional?"), sheet.indexOf(":<div>"));
  const rows = [...provisional.matchAll(/<ReportValue(?:expense)?label=\{(.*?)\}amount=\{(.*?)\}(?=fallback|total|emphasis|expense|\/>)/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(rows, [
    ["copy.operatingIncome", "operatingResult.recognizedRevenue"],
    ["copy.ledgerExpense", "operatingResult.recognizedExpense"],
    ["`+${copy.unrecognizedPayroll}`", "operatingResult.warnings.includes(\"PAYROLL_UNAVAILABLE\")?null:operatingResult.payrollAdjustment"],
    ["`+${copy.cardFeeEstimate}`", "operatingResult.cardFeeRateSource===\"unavailable\"||operatingResult.warnings.includes(\"CARD_SETTLEMENTS_UNAVAILABLE\")||operatingResult.warnings.includes(\"PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE\")?null:operatingResult.estimatedCardFee"],
    ["copy.provisionalExpense", "operatingResult.provisionalExpense"],
    ["copy.provisionalOperatingProfit", "operatingResult.operatingProfit"],
  ]);
  assert.match(provisional, /<pclassName=\{styles\.sectionNote\}>\{copy\.provisionalNote\}<\/p>/);
  assert.match(provisional, /amount=\{operatingResult\.provisionalExpense\}fallback=\{copy\.needsCheck\}totalexpense\/>/);
  assert.match(provisional, /amount=\{operatingResult\.operatingProfit\}fallback=\{copy\.needsCheck\}emphasis\/>/);
  // null amounts render the fallback text, never a silent 0.
  assert.match(dashboardCompact, /\{amount===null\?fallback:money\(amount\)\}/);

  const final = sheet.slice(sheet.indexOf(":<div>"));
  assert.match(final, /\{copy\.profitAndLossNote\}/);
  assert.deepEqual([...final.matchAll(/<ReportValuelabel=\{([^}]*)\}/g)].map((match) => match[1]), ["copy.operatingIncome", "copy.operatingExpense", "copy.operatingProfit"]);
  assert.doesNotMatch(final, /unrecognizedPayroll|cardFeeEstimate|provisionalExpense/);

  // Sheet sums equal the helper's formula (values come from the helper, not hard-coded).
  const result = buildProvisionalOperatingProfit(input);
  assert.equal(result.provisionalExpense, result.recognizedExpense + result.payrollAdjustment + result.estimatedCardFee);
  assert.equal(result.operatingProfit, result.recognizedRevenue - result.provisionalExpense!);

  for (const label of ["상세보기", "잠정 영업이익 상세", "영업이익 상세", "닫기", "Chi tiết", "Chi tiết lợi nhuận tạm tính", "Chi tiết lợi nhuận hoạt động", "Đóng"]) assert.ok(dashboardPage.includes(label), label);
});
