import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as partnerTextModule from "../lib/partners/text.ts";
import * as settlementPeriodsModule from "../lib/ledger/settlement-periods.ts";
import { calculatePurchaseSettlement } from "../lib/ledger/payables.ts";
import { buildSettlementPeriods, groupDatesBySettlementPeriod, periodSelectionState, setDatesSelected, settlementPeriodFor, type SettlementPolicyValue } from "../lib/ledger/settlement-periods.ts";

const read = (path: string) => readFileSync(path, "utf8");
const policy = (settlementRule: string, settlementDays: number[] | null): SettlementPolicyValue =>
  ({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule, settlementDays, defaultPaymentTermDays: null });
const phuong = policy("monthly_twice", [15, 0]);
const okMart = policy("weekly", [2]);
const paid = (date: string, amount: number) => ({ payment: { status: "confirmed", business_date: date }, allocated_amount: amount });
const payable = (id: number, businessDate: string | null, amount: number, allocations: ReturnType<typeof paid>[] = []) =>
  ({ id, businessDate, originalAmount: amount, settlement: calculatePurchaseSettlement(amount, allocations, { payableId: id }) });

test("Phương 15일·말일: 1~15 and 16~month end periods, reference date = cutoff", () => {
  assert.deepEqual(settlementPeriodFor(phuong, "2026-11-02"), { start: "2026-11-01", end: "2026-11-15", referenceDate: "2026-11-15" });
  assert.deepEqual(settlementPeriodFor(phuong, "2026-11-15"), { start: "2026-11-01", end: "2026-11-15", referenceDate: "2026-11-15" });
  assert.deepEqual(settlementPeriodFor(phuong, "2026-11-16"), { start: "2026-11-16", end: "2026-11-30", referenceDate: "2026-11-30" });
  assert.deepEqual(settlementPeriodFor(phuong, "2026-10-31"), { start: "2026-10-16", end: "2026-10-31", referenceDate: "2026-10-31" });
  // stored order does not matter
  assert.deepEqual(settlementPeriodFor(policy("monthly_twice", [0, 15]), "2026-11-20"), { start: "2026-11-16", end: "2026-11-30", referenceDate: "2026-11-30" });
});

test("month ends 28/29/30/31 and days beyond the month length use the month end", () => {
  assert.deepEqual(settlementPeriodFor(phuong, "2026-02-20"), { start: "2026-02-16", end: "2026-02-28", referenceDate: "2026-02-28" });
  assert.deepEqual(settlementPeriodFor(phuong, "2028-02-29"), { start: "2028-02-16", end: "2028-02-29", referenceDate: "2028-02-29" });
  assert.deepEqual(settlementPeriodFor(phuong, "2026-03-01"), { start: "2026-03-01", end: "2026-03-15", referenceDate: "2026-03-15" });
  assert.deepEqual(settlementPeriodFor(policy("monthly_once", [31]), "2026-04-10"), { start: "2026-04-01", end: "2026-04-30", referenceDate: "2026-04-30" });
  assert.deepEqual(settlementPeriodFor(policy("monthly_once", [0]), "2026-12-31"), { start: "2026-12-01", end: "2026-12-31", referenceDate: "2026-12-31" });
  // [30, 0] collapses to one cutoff in February instead of an empty period
  assert.deepEqual(settlementPeriodFor(policy("monthly_twice", [30, 0]), "2026-02-10"), { start: "2026-02-01", end: "2026-02-28", referenceDate: "2026-02-28" });
});

test("monthly once on the 25th spans month and year boundaries", () => {
  const p = policy("monthly_once", [25]);
  assert.deepEqual(settlementPeriodFor(p, "2026-11-28"), { start: "2026-11-26", end: "2026-12-25", referenceDate: "2026-12-25" });
  assert.deepEqual(settlementPeriodFor(p, "2026-12-28"), { start: "2026-12-26", end: "2027-01-25", referenceDate: "2027-01-25" });
  assert.deepEqual(settlementPeriodFor(p, "2027-01-10"), { start: "2026-12-26", end: "2027-01-25", referenceDate: "2027-01-25" });
});

test("Ok Mart weekly Tuesday: Mon~Sun purchases reference the following Tuesday", () => {
  assert.deepEqual(settlementPeriodFor(okMart, "2026-11-01"), { start: "2026-10-26", end: "2026-11-01", referenceDate: "2026-11-03" }); // Sunday
  assert.deepEqual(settlementPeriodFor(okMart, "2026-11-02"), { start: "2026-11-02", end: "2026-11-08", referenceDate: "2026-11-10" }); // Monday
  assert.deepEqual(settlementPeriodFor(okMart, "2026-11-05"), { start: "2026-11-02", end: "2026-11-08", referenceDate: "2026-11-10" });
  assert.deepEqual(settlementPeriodFor(policy("weekly", [7]), "2026-11-05"), { start: "2026-11-02", end: "2026-11-08", referenceDate: "2026-11-15" });
});

test("Phương November: five unpaid purchases total 11,998,000 in one open period", () => {
  const rows = [payable(1, "2026-11-02", 2_400_000), payable(2, "2026-11-02", 1_598_000), payable(3, "2026-11-03", 3_000_000), payable(4, "2026-11-05", 2_500_000), payable(5, "2026-11-05", 2_500_000)];
  const [period, ...rest] = buildSettlementPeriods(phuong, rows, "2026-11-05")!;
  assert.equal(rest.length, 0);
  assert.equal(period.start, "2026-11-01"); assert.equal(period.referenceDate, "2026-11-15");
  assert.equal(period.payableCount, 5); assert.equal(period.purchaseAmount, 11_998_000);
  assert.equal(period.paidAmount, 0); assert.equal(period.remainingAmount, 11_998_000);
  assert.equal(period.position, "open"); assert.equal(period.lastPaymentDate, null);
});

test("Ok Mart Nov 1~5: weekly boundary splits 29 purchases into two periods totalling 11,861,000", () => {
  // 3 purchases on Sun 11/1 belong to 10/26~11/1; 26 purchases 11/2~11/5 belong to 11/2~11/8.
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => payable(100 + i, "2026-11-01", 401_000)),
    ...Array.from({ length: 26 }, (_, i) => payable(200 + i, ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"][i % 4], i === 25 ? 408_000 : 410_000)), // 3×401,000 + 25×410,000 + 408,000
  ];
  const periods = buildSettlementPeriods(okMart, rows, "2026-11-05")!;
  assert.deepEqual(periods.map(p => [p.start, p.end, p.referenceDate, p.payableCount, p.position]), [
    ["2026-10-26", "2026-11-01", "2026-11-03", 3, "reference_passed"],
    ["2026-11-02", "2026-11-08", "2026-11-10", 26, "open"],
  ]);
  assert.equal(periods.reduce((sum, p) => sum + p.remainingAmount, 0), 11_861_000);
});

test("partial payment and carry-over: settled periods are omitted, partially paid ones keep paid and remaining", () => {
  const rows = [
    payable(1, "2026-10-05", 1_000_000, [paid("2026-10-20", 1_000_000)]), // 10/1~10/15 fully paid on 10/20
    payable(2, "2026-10-20", 2_000_000, [paid("2026-10-31", 500_000)]), // 10/16~10/31 partially paid
    payable(3, "2026-11-02", 700_000),
  ];
  const periods = buildSettlementPeriods(phuong, rows, "2026-11-05")!;
  assert.deepEqual(periods.map(p => p.key), ["2026-10-16~2026-10-31", "2026-11-01~2026-11-15"]);
  assert.deepEqual([periods[0].purchaseAmount, periods[0].paidAmount, periods[0].remainingAmount], [2_000_000, 500_000, 1_500_000]);
  // actual payment date (10/31) is shown apart from the settlement reference date
  assert.equal(periods[0].lastPaymentDate, "2026-10-31"); assert.equal(periods[0].referenceDate, "2026-10-31");
  assert.equal(periods[0].position, "reference_passed");
});

test("past-month as-of: allocations after month end are excluded by the caller's as-of set", () => {
  // As of 10/31 the 11/3 payment is not counted (caller passes month-filtered allocations).
  const asOf = [payable(2, "2026-10-20", 2_000_000, [])];
  const [period] = buildSettlementPeriods(phuong, asOf, "2026-10-31")!;
  assert.equal(period.remainingAmount, 2_000_000); assert.equal(period.position, "open");
});

test("undated purchases form their own bucket; cancelled/settled-only parties yield an empty list", () => {
  const periods = buildSettlementPeriods(phuong, [payable(1, null, 300_000), payable(2, "2026-11-02", 100_000)], "2026-11-05")!;
  assert.deepEqual(periods.map(p => [p.kind, p.position]), [["period", "open"], ["undated", "unknown"]]);
  assert.deepEqual(buildSettlementPeriods(phuong, [payable(1, "2026-11-02", 100_000, [paid("2026-11-03", 100_000)])], "2026-11-05"), []);
});

test("non-period policies return null so the existing list is shown unchanged", () => {
  for (const value of [
    { paymentMode: "postpaid", settlementMode: "ad_hoc", settlementRule: null, settlementDays: null, defaultPaymentTermDays: null },
    policy("net_days", null),
    policy("monthly_twice", null),
    policy("weekly", []),
    { paymentMode: "immediate", settlementMode: null, settlementRule: null, settlementDays: null, defaultPaymentTermDays: null },
    { paymentMode: "unspecified", settlementMode: null, settlementRule: null, settlementDays: null, defaultPaymentTermDays: null },
    null,
  ] as (SettlementPolicyValue | null)[]) assert.equal(buildSettlementPeriods(value, [payable(1, "2026-11-02", 1)], "2026-11-05"), null);
});

test("non-cash writeoff adjustments are reported separately from cash payments", () => {
  const writeoff = { allocated_amount: 500, payment: { id: 9, status: "confirmed", type: "expense", source_type: "ledger_correction", economic_effect_sign: -1, business_date: "2026-11-04", amount: 500, memo: "small diff",
    source_key: "payable-small-diff:2026-11:1", source_snapshot: { adjustmentType: "payable_small_difference_writeoff", nonCash: true, cashMovementAmount: 0, payableId: 1, originalTransactionId: 77, originalAmount: 100_500, writeoffAmount: 500 }, movements: [{ amount: 0 }] } };
  const row = { id: 1, businessDate: "2026-11-02", originalAmount: 100_500, settlement: calculatePurchaseSettlement(100_500, [writeoff, paid("2026-11-04", 50_000)], { payableId: 1, transactionId: 77 }) };
  const [period] = buildSettlementPeriods(phuong, [row], "2026-11-05")!;
  assert.deepEqual([period.purchaseAmount, period.adjustmentAmount, period.paidAmount, period.remainingAmount], [100_500, -500, 50_000, 50_000]);
});

test("payables API attaches read-only settlement periods without writes or due-date derivation", () => {
  const route = read("app/api/admin/ledger/payables/route.ts");
  assert.match(route, /from\("business_partners"\)\.select\("id,partner_type,payment_mode,settlement_mode,settlement_rule,settlement_days,default_payment_term_days"\)/);
  assert.match(route, /for\(const row of ordinarySources\)\{if\(row\.status==="cancelled"/); // 결제 미확인 stays excluded
  assert.match(route, /buildSettlementPeriods\(settlementPolicy,/);
  assert.match(route, /calculatePurchaseSettlement\(row\.original_amount,allocationsByPayable\.get/);
  assert.match(route, /const asOfAllocations=month===null\?allConfirmedAllocations:confirmedAllocationsThroughMonth/);
  assert.doesNotMatch(route, /\.(insert|update|upsert|delete)\(|\.rpc\(/);
  assert.doesNotMatch(read("lib/ledger/settlement-periods.ts"), /due_date|supabase|fetch\(/);
});

test("both payable sheets show the read-only summary; payment controls are unchanged", () => {
  const page = read("app/(protected)/admin/ledger/entries/page.tsx");
  assert.equal((page.match(/<SettlementPeriodSummary lang=\{lang\} policy=\{party\.settlementPolicy\} periods=\{party\.settlementPeriods\} viewMonth=/g) ?? []).length, 2);
  assert.match(page, /선택 일자 \$\{selectedDates\.size\}건 결제/);
  assert.match(page, /부분 지급/);
  const component = read("components/ledger/SettlementPeriodSummary.tsx");
  // display-only: local 상세 toggle and the optional jump callback; no payment or selection writes
  assert.doesNotMatch(component, /fetch\(|method:|onPaid|setSelected/);
});

// Render the real component (KO/VI) with React; module CSS resolves to class names.
function renderSummary(props: Record<string, unknown>) {
  const require = createRequire(import.meta.url);
  const React = require("react"), runtime = require("react/jsx-runtime"), { renderToStaticMarkup } = require("react-dom/server");
  const code = ts.transpileModule(read("components/ledger/SettlementPeriodSummary.tsx"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} as { default: (p: unknown) => unknown } };
  const deps: Record<string, unknown> = { react: React, "react/jsx-runtime": runtime, "@/lib/partners/text": partnerTextModule, "@/lib/ledger/settlement-periods": settlementPeriodsModule, "./SettlementPeriodSummary.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) } };
  new Function("require", "module", "exports", code)((name: string) => { assert.ok(name in deps, name); return deps[name]; }, mod, mod.exports);
  return renderToStaticMarkup(React.createElement(mod.exports.default, props)) as string;
}
const strip = (html: string) => html.replace(/<[^>]+>/g, "");

test("compact summary: Phương single period is one line with range and 기준일, no badges or amounts", () => {
  const periods = buildSettlementPeriods(phuong, [payable(1, "2026-11-02", 9_394_000), payable(2, "2026-11-05", 1_298_000)], "2026-11-30")!;
  const ko = renderSummary({ lang: "ko", policy: phuong, periods });
  assert.equal(strip(ko), "📅 매월 15일·말일 정산 · 11/1~11/15 거래분 · 기준일 11/15(일)");
  assert.doesNotMatch(ko, /기준일 지남|진행 중|₫|<button|연체/);
  const vi = renderSummary({ lang: "vi", policy: phuong, periods });
  assert.equal(strip(vi), "📅 Chốt ngày 15 và cuối tháng hằng tháng · 11/1~11/15 giao dịch · chốt 11/15(CN)");
});

test("compact summary: several periods show a count and an on-demand detail toggle", () => {
  const periods = buildSettlementPeriods(okMart, [payable(1, "2026-10-28", 4_144_500), payable(2, "2026-11-01", 939_000), payable(3, "2026-11-02", 10_922_000)], "2026-11-05")!;
  const ko = renderSummary({ lang: "ko", policy: okMart, periods });
  assert.equal(strip(ko), "📅 매주 화요일 지급 기준 · 미지급 정산기간 2개상세›");
  assert.match(ko, /aria-expanded="false"/);
  assert.doesNotMatch(ko, /<ul|₫|기준일 지남/);
  assert.equal(strip(renderSummary({ lang: "vi", policy: okMart, periods })), "📅 Thứ Ba hằng tuần (mốc thanh toán) · 2 kỳ còn nợChi tiết›");
});

test("compact summary: non-period terms show the term only; non-postpaid renders nothing", () => {
  const adHoc = { paymentMode: "postpaid", settlementMode: "ad_hoc", settlementRule: null, settlementDays: null, defaultPaymentTermDays: null };
  assert.equal(strip(renderSummary({ lang: "ko", policy: adHoc, periods: null })), "📅 비정기 정산");
  assert.equal(renderSummary({ lang: "ko", policy: { ...adHoc, paymentMode: "immediate", settlementMode: null }, periods: null }), "");
});

test("Phương 11/15 showed 기준일 지남 on 11/5: the month view passes the month end as the as-of date", () => {
  // The entries page always loads ?month=YYYY-MM, so the API as-of is the month end (11/30), not today.
  assert.match(read("app/api/admin/ledger/payables/route.ts"), /const asOfDate=bounds\?new Date\(Date\.parse\(bounds\.nextMonthStart\+"T00:00:00Z"\)-86400000\)/);
  assert.match(read("app/(protected)/admin/ledger/entries/page.tsx"), /fetch\(`\/api\/admin\/ledger\/payables\?month=\$\{requestedMonth\}`/);
  const asOfMonthEnd = buildSettlementPeriods(phuong, [payable(1, "2026-11-02", 1)], "2026-11-30")![0];
  assert.equal(asOfMonthEnd.position, "reference_passed");
  // The period dates themselves are correct; only the as-of date differs.
  assert.deepEqual([asOfMonthEnd.start, asOfMonthEnd.end, asOfMonthEnd.referenceDate], ["2026-11-01", "2026-11-15", "2026-11-15"]);
  assert.equal(buildSettlementPeriods(phuong, [payable(1, "2026-11-02", 1)], "2026-11-05")![0].position, "open");
  // The compact UI no longer renders any position badge.
  assert.doesNotMatch(read("components/ledger/SettlementPeriodSummary.tsx"), /position/);
});

test("payable sheet header uses the shared partner category emoji and a collapsed payment-info toggle", () => {
  const page = read("app/(protected)/admin/ledger/entries/page.tsx");
  assert.match(page, /partyEmoji=\{ledgerPartyEmoji\(partnerByLedgerParty\.get\(payableParty\.partyId\)\?\.emoji,payableParty\.partnerType\)\}/);
  assert.doesNotMatch(page, /<strong>🤝 \{party\.partyName\}/);
  assert.match(page, /const \[paymentInfoOpen,setPaymentInfoOpen\]=useState\(false\);/);
  // selecting a date never toggles the payment info panel
  assert.doesNotMatch(page, /onSelectDate=\{date=>\{?[^}]*setPaymentInfoOpen/);
  assert.match(read("app/(protected)/admin/ledger/entries/entries.module.css"), /\.payableSheetBody>\.payableDates\{min-height:min\(184px,42vh\)\}/);
});

// ---------------------------------------------------------------------------
// Selected-date list grouped by settlement period (P0-2 follow-up 2)
// ---------------------------------------------------------------------------
const dateGroup = (businessDate: string, total: number, count = 1) => ({ businessDate, total, rows: Array.from({ length: count }, (_, i) => ({ id: i })) });

test("Phương monthly twice: dates group under 1~15 / 16~end with the summary's period totals", () => {
  const rows = [payable(1, "2026-10-20", 500_000), payable(2, "2026-11-02", 9_394_000), payable(3, "2026-11-03", 1_306_000), payable(4, "2026-11-05", 1_298_000)];
  const periods = buildSettlementPeriods(phuong, rows, "2026-11-30")!;
  const groups = groupDatesBySettlementPeriod(phuong, [dateGroup("2026-10-20", 500_000), dateGroup("2026-11-02", 9_394_000, 2), dateGroup("2026-11-03", 1_306_000, 2), dateGroup("2026-11-05", 1_298_000)], periods, "2026-11")!;
  assert.deepEqual(groups.map(g => [g.key, g.referenceDate, g.carriedFromMonth, g.dates.map(d => d.businessDate)]), [
    ["2026-10-16~2026-10-31", "2026-10-31", "2026-10", ["2026-10-20"]],
    ["2026-11-01~2026-11-15", "2026-11-15", null, ["2026-11-02", "2026-11-03", "2026-11-05"]],
  ]);
  // header amount/count are the same numbers as the summary rows
  for (const group of groups) {
    const period = periods.find(p => p.key === group.key)!;
    assert.deepEqual([group.remainingAmount, group.payableCount], [period.remainingAmount, period.payableCount]);
  }
  assert.equal(groups[1].remainingAmount, 11_998_000);
});

test("Ok Mart weekly Tuesday: the 10/26~11/1 week is marked as carrying October", () => {
  const rows = [payable(1, "2026-10-28", 4_144_500), payable(2, "2026-11-01", 939_000), payable(3, "2026-11-02", 2_901_000), payable(4, "2026-11-05", 8_021_000)];
  const periods = buildSettlementPeriods(okMart, rows, "2026-11-30")!;
  const groups = groupDatesBySettlementPeriod(okMart, [dateGroup("2026-10-28", 4_144_500), dateGroup("2026-11-01", 939_000), dateGroup("2026-11-02", 2_901_000), dateGroup("2026-11-05", 8_021_000)], periods, "2026-11")!;
  assert.deepEqual(groups.map(g => [g.start, g.end, g.referenceDate, g.carriedFromMonth, g.remainingAmount]), [
    ["2026-10-26", "2026-11-01", "2026-11-03", "2026-10", 5_083_500],
    ["2026-11-02", "2026-11-08", "2026-11-10", null, 10_922_000],
  ]);
});

test("ad hoc / unspecified partners keep the plain date list; undated dates trail in their own group", () => {
  const adHoc = { paymentMode: "postpaid", settlementMode: "ad_hoc", settlementRule: null, settlementDays: null, defaultPaymentTermDays: null };
  assert.equal(groupDatesBySettlementPeriod(adHoc, [dateGroup("2026-11-02", 1)], [], "2026-11"), null);
  assert.equal(groupDatesBySettlementPeriod(null, [dateGroup("2026-11-02", 1)], [], "2026-11"), null);
  const groups = groupDatesBySettlementPeriod(phuong, [dateGroup("", 300), dateGroup("2026-11-02", 100)], [], "2026-11")!;
  assert.deepEqual(groups.map(g => [g.kind, g.remainingAmount, g.payableCount]), [["period", 100, 1], ["undated", 300, 1]]);
});

test("period header select-all adds or clears only that period's dates and reports all/some/none", () => {
  const week1 = ["2026-10-28", "2026-11-01"], week2 = ["2026-11-02", "2026-11-05"];
  let selected: ReadonlySet<string> = new Set(["2026-11-05"]);
  assert.equal(periodSelectionState(week2, selected), "some");
  selected = setDatesSelected(selected, week1, true);
  assert.deepEqual([...selected].sort(), ["2026-10-28", "2026-11-01", "2026-11-05"]);
  assert.equal(periodSelectionState(week1, selected), "all");
  selected = setDatesSelected(selected, week2, true);
  assert.equal(periodSelectionState(week2, selected), "all");
  selected = setDatesSelected(selected, week1, false);
  assert.deepEqual([...selected].sort(), week2);
  assert.equal(periodSelectionState(week1, selected), "none");
  assert.equal(periodSelectionState([], selected), "none");
});

// Renders the summary with its 상세 list open (first useState seeded true).
function renderOpenSummary(props: Record<string, unknown>) {
  const React = createRequire(import.meta.url)("react");
  const original = React.useState;
  let first = true;
  React.useState = (initial: unknown) => { if (first) { first = false; return original(true); } return original(initial); };
  try { return renderSummary(props); } finally { React.useState = original; }
}

test("summary detail rows are compact period rows with 기준일, count, remaining and carry-over; click jumps to the group", () => {
  const periods = buildSettlementPeriods(okMart, [payable(1, "2026-10-28", 4_144_500), payable(2, "2026-11-01", 939_000), payable(3, "2026-11-02", 10_922_000)], "2026-11-30")!;
  const ko = renderOpenSummary({ lang: "ko", policy: okMart, periods, viewMonth: "2026-11", onSelectPeriod: () => {} });
  const text = strip(ko);
  assert.match(text, /10\/26~11\/1 거래분기준일 11\/3\(화\) · 2건 · 10월 이월 포함5\.083\.500 ₫›/);
  assert.match(text, /11\/2~11\/8 거래분기준일 11\/10\(화\) · 1건10\.922\.000 ₫›/);
  assert.equal((ko.match(/<button type="button" class="row"/g) ?? []).length, 2);
  assert.match(ko, /class="carried"/);
  assert.doesNotMatch(ko, /지급 \d|기준일 지남|장부 집계 기준/); // no paid-amount repeat, badge or long note
  const vi = strip(renderOpenSummary({ lang: "vi", policy: okMart, periods, viewMonth: "2026-11", onSelectPeriod: () => {} }));
  assert.match(vi, /10\/26~11\/1 giao dịchchốt 11\/3\(T3\) · 2 khoản · gồm nợ T10/);
  // without a jump target (historical sheet) rows are plain, not buttons
  assert.doesNotMatch(renderOpenSummary({ lang: "ko", policy: okMart, periods, viewMonth: "2026-11" }), /<button type="button" class="row"/);
});

test("selected-date list renders period headers only for 정기정산, with select-all, collapse and the same totals", () => {
  const page = read("app/(protected)/admin/ledger/entries/page.tsx");
  assert.match(page, /settlement&&selectable\?groupDatesBySettlementPeriod\(settlement\.policy,groups,settlement\.periods,settlement\.viewMonth\):null/);
  assert.match(page, /\{periodGroups&&settlement\?periodGroups\.map\(period=>\{/);
  assert.match(page, /\}\):groups\.map\(renderDate\)\}<\/div>;/); // non-period partners: unchanged list
  assert.match(page, /onChange=\{\(\)=>settlement\.onSetDates\(dates,!allSelected\)\}/);
  assert.match(page, /onSetDates:\(dates,checked\)=>setSelectedDates\(current=>setDatesSelected\(current,dates,checked\)\)/);
  assert.match(page, /<b>\{money\(period\.remainingAmount\)\}<\/b>/);
  assert.match(page, /id=\{`payable-period-\$\{period\.key\}`\}/);
  assert.match(page, /document\.getElementById\(`payable-period-\$\{key\}`\)\?\.scrollIntoView\(\{block:"start"/);
  assert.match(page, /onSelectPeriod=\{focusPeriod\}/);
  // the historical (read-only) sheet gets no grouping or jump
  assert.match(page, /viewMonth=\{\(party\.settlementAsOf\?\?""\)\.slice\(0,7\)\}\/>/);
  // payment paths unchanged
  assert.match(page, /allocations:selectedPayables\.map\(row=>\(\{payableId:row\.id,allocatedAmount:row\.outstandingAmount\}\)\)/);
  assert.match(page, /planPartialPayablePayment\(partialRows,parseLedgerAmount\(partialAmount\)\?\?0\)/);
});
