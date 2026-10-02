import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const {
  buildProvisionalOperatingProfit,
  currentCardFeeRate,
  previousCardFeeRate,
  MAX_PLAUSIBLE_CARD_FEE_RATE,
} = createRequire(import.meta.url)("../lib/ledger/provisional-operating-profit.ts") as typeof import("../lib/ledger/provisional-operating-profit");

const dashboardPage = readFileSync("app/(protected)/admin/ledger/page.tsx", "utf8");
const dashboardCompact = dashboardPage.replace(/\s+/g, "");
const helperSource = readFileSync("lib/ledger/provisional-operating-profit.ts", "utf8");
const payrollCostServer = readFileSync("lib/ledger/payroll-cost-server.ts", "utf8");

// Ledger summary already includes welfare costs (회식, 숙박, 주거비 ...) inside expense.
const summary = { income: 1_000_000, expense: 400_000, operatingProfit: 600_000 };
// Month payroll cost from /api/admin/ledger/payroll-cost (predicted: no completed batch yet).
const payroll = { month: "2026-10", status: "predicted" as const, amount: 220_000, recognizedAmount: 0, adjustment: 220_000, batchStatus: null };
const currentCard = { monthlyCardGross: 300_000, monthlySettledGross: 200_000, monthlySettlementDifference: 4_000, actualDifferenceRate: 0.5 };
const previousCard = { monthlyCardGross: 500_000, monthlySettledGross: 500_000, monthlySettlementDifference: 12_500, actualDifferenceRate: 0.025 };
const input = { isCurrentMonth: true, summary, payroll, currentCard, previousCard };

test("current month adds the predicted payroll cost and the current settled card rate", () => {
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

test("payroll uses the resolved month cost, never the Payroll overview's projected or meal-inclusive totals", () => {
  // The ledger payroll-cost server reads loadPayrollOverview() directly: its raw summary has no meal allowance.
  assert.match(payrollCostServer, /const overview = await loadPayrollOverview\(month\);\s*const companyCost = Number\(overview\.summary\.totalCompanyCostAmount\);/);
  assert.doesNotMatch(payrollCostServer.replace(/\/\/.*$/gm, ""), /projectedSummary|mealAllowance/);
  assert.doesNotMatch(helperSource.replace(/\/\/.*$/gm, ""), /projectedSummary|mealAllowanceAmount/);
});

test("Payroll cost already booked by a completed batch is not added again", () => {
  const finalizedBooked = { ...payroll, status: "finalized" as const, amount: 220_000, recognizedAmount: 220_000, adjustment: 0, batchStatus: "completed" };
  assert.equal(buildProvisionalOperatingProfit({ ...input, payroll: finalizedBooked }).payrollAdjustment, 0);
  const finalizedMissing = { ...finalizedBooked, recognizedAmount: 200_000, adjustment: 20_000 };
  assert.equal(buildProvisionalOperatingProfit({ ...input, payroll: finalizedMissing }).payrollAdjustment, 20_000);
  assert.equal(buildProvisionalOperatingProfit({ ...input, payroll: { ...payroll, batchStatus: "paying" } }).payrollAdjustment, 220_000);
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

test("past months: finalized payroll keeps the final ledger operating profit; predicted payroll makes it provisional", () => {
  const finalized = { ...payroll, month: "2026-08", status: "finalized" as const, amount: 220_000, recognizedAmount: 220_000, adjustment: 0, batchStatus: "completed" };
  const final = buildProvisionalOperatingProfit({ ...input, isCurrentMonth: false, payroll: finalized });
  assert.equal(final.mode, "final");
  assert.equal(final.operatingProfit, summary.operatingProfit);
  assert.equal(final.provisionalExpense, summary.expense);
  assert.equal(final.payrollAdjustment, 0);
  assert.equal(final.estimatedCardFee, 0);
  assert.deepEqual(final.payroll, { status: "finalized", amount: 220_000 });
  // September closed before its 10/10 payroll: P&L carries the predicted cost, no card estimate.
  const predicted = buildProvisionalOperatingProfit({ ...input, isCurrentMonth: false, payroll: { ...payroll, month: "2026-09" } });
  assert.equal(predicted.mode, "provisional");
  assert.equal(predicted.needsCheck, false);
  assert.equal(predicted.payrollAdjustment, 220_000);
  assert.equal(predicted.estimatedCardFee, 0);
  assert.equal(predicted.provisionalExpense, summary.expense + 220_000);
  assert.equal(predicted.operatingProfit, summary.income - summary.expense - 220_000);
  assert.deepEqual(predicted.payroll, { status: "predicted", amount: 220_000 });
  // Months before payroll tracking, or without a payroll source, stay final.
  assert.equal(buildProvisionalOperatingProfit({ ...input, isCurrentMonth: false, payroll: { ...payroll, status: "not_tracked" as const, amount: 0, adjustment: 0 } }).mode, "final");
  assert.equal(buildProvisionalOperatingProfit({ ...input, isCurrentMonth: false, payroll: null }).mode, "final");
});

test("an unavailable or still-loading payroll estimate is never treated as 0", () => {
  const unavailable = { ...payroll, status: "unavailable" as const, amount: null, adjustment: null };
  for (const isCurrentMonth of [true, false]) {
    const result = buildProvisionalOperatingProfit({ ...input, isCurrentMonth, payroll: unavailable });
    assert.equal(result.mode, "provisional");
    assert.equal(result.needsCheck, true);
    assert.equal(result.operatingProfit, null);
    assert.ok(result.warnings.includes("PAYROLL_UNAVAILABLE"));
    const loading = buildProvisionalOperatingProfit({ ...input, isCurrentMonth, payroll: null, payrollLoading: true });
    assert.equal(loading.operatingProfit, null);
    assert.ok(loading.warnings.includes("PAYROLL_LOADING"));
    assert.deepEqual(loading.payroll, { status: "loading", amount: null });
  }
});

test("a failed Payroll or card source marks the provisional profit as needs-check instead of assuming 0", () => {
  for (const failed of [{ payroll: null }, { currentCard: null }, { payroll: { ...payroll, status: "unavailable" as const, amount: null, adjustment: null } }]) {
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

test("dashboard loads payroll cost for every month without blocking the report; card sources stay current-month only", () => {
  assert.match(dashboardCompact, /constisCurrentMonth=month===getBusinessDate\(\)\.slice\(0,7\);/);
  assert.match(dashboardCompact, /constpayrollPromise=loadPayrollCost\(month,controller\.signal\);constcardPromise=isCurrentMonth\?loadCardSources\(month,previousMonth,controller\.signal\):Promise\.resolve\(null\);/);
  for (const url of ["/api/admin/ledger/payroll-cost?month=${month}", "/api/admin/ledger/card-settlements?month=${month}", "/api/admin/ledger/card-settlements?month=${previousMonth}"]) assert.ok(dashboardPage.includes(url), url);
  assert.doesNotMatch(dashboardPage, /\/api\/admin\/payroll\/overview/);
  // The report renders first (payroll loading), then payroll fills in for the same month only.
  assert.match(dashboardCompact, /provisional:\{payroll:null,payrollLoading:true,cards\},?\}\);constpayroll=awaitpayrollPromise;if\(controller\.signal\.aborted\|\|requestSequence!==requestSequenceRef\.current\|\|payroll\.month!==month\)return;/);
  assert.match(dashboardCompact, /asyncfunctionloadOptionalMonthBody[^]*?catch\{returnnull;\}/);
  assert.match(dashboardCompact, /body\?\.month===month\?pick\(body\):null/);
  // A failed payroll request is "unavailable", not 0.
  assert.match(dashboardCompact, /returnpayroll\?\?\{month,status:"unavailable",amount:null,recognizedAmount:0,adjustment:null,batchStatus:null,reason:"PAYROLL_ESTIMATE_FAILED"\};/);
  // Existing stale guards stay intact.
  assert.match(dashboardCompact, /requestSequence!==requestSequenceRef\.current/);
  assert.match(dashboardCompact, /currentBody\.month!==month\|\|previousBody\.month!==previousMonth/);
  assert.match(dashboardCompact, /controller\.abort\(\);requestSequenceRef\.current\+=1/);
  assert.match(dashboardCompact, /isCurrentMonth:isCurrentMonth&&dashboardState\.provisional\.cards!==null&&dashboardState\.current\.fundsView\.mode==="live"/);
});

test("KPI and P&L card switch between provisional (current) and final (past) labels", () => {
  assert.match(dashboardCompact, /operatingResult\.mode==="provisional"(\/\/[^?]*)?\?<KpiCardicon="📊"label=\{copy\.provisionalOperatingProfit\}amount=\{operatingResult\.operatingProfit\}note=\{operatingResult\.warnings\.includes\("PAYROLL_LOADING"\)\?copy\.checking:operatingResult\.needsCheck\?copy\.needsCheck:copy\.provisional\}trendDirection=\{operatingResult\.needsCheck\?"down":undefined\}action=\{detailButton\}\/>/);
  assert.match(dashboardCompact, /:<KpiCardicon="📊"label=\{copy\.operatingProfit\}amount=\{report\.kpis\.operatingProfit\}\{\.\.\.signedTrend\(report\.kpis\.operatingProfitChange,copy\)\}action=\{detailButton\}\/>\}/);
  for (const key of ["operatingIncome", "ledgerExpense", "unrecognizedPayroll", "cardFeeEstimate", "provisionalExpense", "provisionalOperatingProfit", "provisionalNote", "estimateUnavailable", "needsCheck", "payrollCost", "payrollPredicted", "payrollFinalized", "checking"]) assert.match(dashboardPage, new RegExp(`copy\\.${key}`));
  for (const label of ["급여/인건비", "예상", "확정", "확인 중", "Chi phí lương", "Dự kiến", "Đã chốt", "Đang kiểm tra"]) assert.ok(dashboardPage.includes(`"${label}"`), label);
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
  const sheet = dashboardCompact.slice(dashboardCompact.indexOf("functionOperatingProfitSheet("), dashboardCompact.indexOf("functionpayrollLabel("));
  const provisional = sheet.slice(sheet.indexOf("{provisional?"), sheet.indexOf(":<div>"));
  const rows = [...provisional.matchAll(/<ReportValue(?:expense)?label=\{(.*?)\}amount=\{(.*?)\}(?=fallback|total|emphasis|expense|\/>)/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(rows, [
    ["copy.operatingIncome", "operatingResult.recognizedRevenue"],
    ["copy.ledgerExpense", "operatingResult.recognizedExpense"],
    ["`+${payrollLabel(operatingResult,copy)}`", "operatingResult.warnings.includes(\"PAYROLL_UNAVAILABLE\")||operatingResult.warnings.includes(\"PAYROLL_LOADING\")?null:operatingResult.payrollAdjustment"],
    ["`+${copy.cardFeeEstimate}`", "operatingResult.cardFeeRateSource===\"unavailable\"||operatingResult.warnings.includes(\"CARD_SETTLEMENTS_UNAVAILABLE\")||operatingResult.warnings.includes(\"PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE\")?null:operatingResult.estimatedCardFee"],
    ["copy.provisionalExpense", "operatingResult.provisionalExpense"],
    ["copy.provisionalOperatingProfit", "operatingResult.operatingProfit"],
  ]);
  assert.match(provisional, /operatingResult\.warnings\.includes\("CARD_FEE_PENDING"\)\?copy\.cardFeePendingNote:copy\.provisionalNote/);
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
