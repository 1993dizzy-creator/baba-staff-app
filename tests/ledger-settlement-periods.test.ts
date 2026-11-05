import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculatePurchaseSettlement } from "../lib/ledger/payables.ts";
import { buildSettlementPeriods, settlementPeriodFor, type SettlementPolicyValue } from "../lib/ledger/settlement-periods.ts";

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
  assert.equal((page.match(/<SettlementPeriodSummary lang=\{lang\} policy=\{party\.settlementPolicy\} periods=\{party\.settlementPeriods\}\/>/g) ?? []).length, 2);
  assert.match(page, /선택 일자 \$\{selectedDates\.size\}건 결제/);
  assert.match(page, /부분 지급/);
  const component = read("components/ledger/SettlementPeriodSummary.tsx");
  assert.doesNotMatch(component, /onClick|fetch\(|method:/);
  assert.match(component, /실제 지급일이나 연체 확정이 아닙니다/);
  assert.match(component, /ngày chốt|Ngày chốt/);
  assert.match(component, /lastPaid/);
});
