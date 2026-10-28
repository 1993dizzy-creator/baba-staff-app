import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { buildLedgerEntries, entryDisplaySubtotal, isHiddenRentAllocation, type TransactionRow } from "../lib/ledger/entries.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { calculateOperatingResidual, monthNewReserve, monthRentRecognized, reserveAttributionMonth } from "../lib/ledger/operating-residual.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { buildRentUsageSchedule, parseRentContractPayload, rentPaymentSummary, rentReserveOutlook } from "../lib/ledger/rent-contracts.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { parseReserveEntryRequest, restorableReleases } from "../lib/ledger/reserve-entry-request.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { reserveManualOffset, reservePlannedRecurringAmount } from "../lib/ledger/reserve-recurring.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { reserveCurrentAmount } from "../lib/ledger/reserve-balances.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { ledgerHrefWithoutInventoryFocus, parseTransactionLedgerFocus } from "../lib/ledger/inventory-entry-focus.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { ledgerMonthHref } from "../lib/ledger/month-query.ts";

// Production shapes read on 2026-10-28 (read only): reserve plan #1 entries #1 (+60M 9/30),
// #2 (+60M 10/21, schedule #2) and #3 (release 100M 10/21); rent plan #3 recognitions
// #3302/#3305/#3306 (50M each, no movement); closed operating profit Aug 267,236,765.578
// and Sep 70,507,820.4.
const reserveEntries = [
  { id: 1, entry_type: "allocate", amount: "60000000.000", occurred_at: "2026-09-30T05:00:00+00:00", allocation_kind: null, attribution_month: null },
  { id: 2, entry_type: "allocate", amount: "60000000.000", occurred_at: "2026-10-21T05:00:00+00:00", allocation_kind: null, attribution_month: null },
  { id: 3, entry_type: "release", amount: "100000000.000", occurred_at: "2026-10-21T05:01:00+00:00", allocation_kind: null, attribution_month: null },
];
const rentRecognitions = ["2026-08", "2026-09", "2026-10"].map((month, index) => ({ id: [3302, 3305, 3306][index], recognition_month: `${month}-01`, amount: "50000000.000", economic_effect_sign: 1 }));

test("operating residual: Aug 317,236,765.578 and Sep 60,507,820.4 from the closed profits; no double deduction", () => {
  const aug = calculateOperatingResidual({ operatingProfit: 267_236_765.578, rentRecognized: monthRentRecognized(rentRecognitions, "2026-08"), newReserve: monthNewReserve(reserveEntries, "2026-08") });
  const sep = calculateOperatingResidual({ operatingProfit: 70_507_820.4, rentRecognized: monthRentRecognized(rentRecognitions, "2026-09"), newReserve: monthNewReserve(reserveEntries, "2026-09") });
  assert.deepEqual(aug, { operatingProfit: 267_236_765.578, rentRecognized: 50_000_000, newReserve: 0, residual: 317_236_765.578 });
  assert.deepEqual(sep, { operatingProfit: 70_507_820.4, rentRecognized: 50_000_000, newReserve: 60_000_000, residual: 60_507_820.4 });
  // October: the 60M regular allocation counts; the 100M loan release does not add back.
  assert.equal(monthNewReserve(reserveEntries, "2026-10"), 60_000_000);
  assert.equal(calculateOperatingResidual({ operatingProfit: null, rentRecognized: 1, newReserve: 1 }), null);
});

test("operating residual: extra counts once in its month; restore never counts; v2 attribution beats occurred_at", () => {
  const entries = [
    ...reserveEntries,
    { id: 4, entry_type: "allocate", amount: "30000000", occurred_at: "2026-11-05T05:00:00Z", allocation_kind: "extra", attribution_month: "2026-11-01" },
    { id: 5, entry_type: "allocate", amount: "100000000", occurred_at: "2026-12-10T05:00:00Z", allocation_kind: "restore", attribution_month: "2026-12-01" },
    // A September schedule confirmed on 11/02 is attributed to November (the confirmation month).
    { id: 6, entry_type: "allocate", amount: "60000000", occurred_at: "2026-11-02T05:00:00Z", allocation_kind: "regular", attribution_month: "2026-11-01" },
  ];
  assert.equal(monthNewReserve(entries, "2026-11"), 90_000_000);
  assert.equal(monthNewReserve(entries, "2026-12"), 0);
  assert.equal(monthNewReserve(entries, "2026-09"), 60_000_000, "a late confirm never changes a closed month");
  // Business-day cut-off 03:00 VN: 10/31 19:59Z (= 11/01 02:59 VN) still belongs to October.
  assert.equal(reserveAttributionMonth({ occurred_at: "2026-10-31T19:59:00Z", attribution_month: null }), "2026-10");
  assert.equal(reserveAttributionMonth({ occurred_at: "2026-10-31T20:00:00Z", attribution_month: null }), "2026-11");
});

test("recurring offset (v2): 60M + extra both accumulate; legacy v1 manual rows still offset", () => {
  const linked = new Set([2]);
  const month = [
    { id: 10, entry_type: "allocate", amount: 50_000_000, occurred_at: "2026-11-03T05:00:00Z", allocation_kind: "extra" },
    { id: 11, entry_type: "allocate", amount: 40_000_000, occurred_at: "2026-11-04T05:00:00Z", allocation_kind: "restore" },
  ];
  const offset = reserveManualOffset(month, "2026-11-01", linked);
  assert.equal(offset, 0);
  assert.equal(reservePlannedRecurringAmount({ monthlyAmount: 60_000_000, manualThisMonth: offset, targetAmount: 720_000_000, currentReserved: 110_000_000 }), 60_000_000);
  // v1 behaviour kept for legacy rows: entry #1 (unlinked, September) offsets September only.
  assert.equal(reserveManualOffset(reserveEntries, "2026-09-01", linked), 60_000_000);
  assert.equal(reserveManualOffset(reserveEntries, "2026-10-01", linked), 0, "#2 is schedule-linked");
  const balance = reserveCurrentAmount([...reserveEntries, ...month.map(row => ({ ...row, amount: String(row.amount) }))]);
  assert.equal(balance, 20_000_000 + 90_000_000);
});

test("reserve entry request: v2 kinds only, no date, restore needs its release, uuid request key", () => {
  const key = "6f1c7e4a-9b0d-4c2e-8f3a-1b2c3d4e5f60";
  assert.deepEqual(parseReserveEntryRequest({ kind: "extra", amount: 50_000_000, memo: " 추가 ", requestKey: key }), { kind: "extra", amount: 50_000_000, restoresEntryId: null, memo: "추가", requestKey: key });
  assert.equal(parseReserveEntryRequest({ kind: "regular", amount: 1, requestKey: key }), null);
  assert.equal(parseReserveEntryRequest({ kind: "allocate", amount: 1, requestKey: key }), null);
  assert.equal(parseReserveEntryRequest({ kind: "extra", amount: 1, requestKey: key, occurredAt: "2026-09-01T00:00:00+07:00" }), null, "back-dating field rejected");
  assert.equal(parseReserveEntryRequest({ kind: "restore", amount: 1, requestKey: key }), null);
  assert.equal(parseReserveEntryRequest({ kind: "extra", amount: 1, restoresEntryId: 3, requestKey: key }), null);
  assert.equal(parseReserveEntryRequest({ kind: "extra", amount: 0.0001, requestKey: key }), null);
  assert.equal(parseReserveEntryRequest({ kind: "extra", amount: 1, requestKey: "abc" }), null);
  assert.equal(parseReserveEntryRequest({ kind: "restore", amount: 1, restoresEntryId: 3, requestKey: key })?.restoresEntryId, 3);
  const releases = restorableReleases([...reserveEntries, { id: 7, entry_type: "allocate", amount: "40000000", occurred_at: "2026-12-01T05:00:00Z", allocation_kind: "restore", restores_entry_id: 3 }]);
  assert.deepEqual(releases.map(row => [row.id, row.remaining]), [[3, 60_000_000]]);
});

test("rent schedule: July is pre-ledger usage, Aug–Oct recognized, a later July migration flips it to recognized", () => {
  const contract = { period_start: "2026-07-01", period_end: "2027-06-30", monthly_expense_amount: "50000000.000" };
  const usage = buildRentUsageSchedule({ contract, recognitions: rentRecognitions, ledgerStartMonth: "2026-08", currentMonth: "2026-10" });
  assert.equal(usage.length, 12);
  assert.deepEqual(usage.slice(0, 5).map(row => [row.month, row.status, row.amount]), [
    ["2026-07", "pre_ledger", 50_000_000], ["2026-08", "recognized", 50_000_000], ["2026-09", "recognized", 50_000_000],
    ["2026-10", "recognized", 50_000_000], ["2026-11", "upcoming", 50_000_000]]);
  assert.deepEqual(usage[2].transactionIds, [3305]);
  const migrated = buildRentUsageSchedule({ contract, recognitions: [...rentRecognitions, { id: 9200, recognition_month: "2026-07-01", amount: "50000000", economic_effect_sign: 1 }], ledgerStartMonth: "2026-08", currentMonth: "2026-10" });
  assert.equal(migrated[0].status, "recognized");
  // A ledger month without its recognition yet is flagged, not silently counted.
  assert.equal(buildRentUsageSchedule({ contract, recognitions: rentRecognitions.slice(0, 2), ledgerStartMonth: "2026-08", currentMonth: "2026-10" })[3].status, "missing");
});

test("rent payments and reserve outlook: 600M paid once each; 220M short, 120M after a 100M restore (warning only)", () => {
  const summary = rentPaymentSummary({ annual_amount: "600000000.000" }, [
    { source: "pre_ledger", amount: "300000000.000" }, { source: "ledger", amount: "300000000.000" }]);
  assert.deepEqual(summary, { contractAmount: 600_000_000, paid: 600_000_000, ledgerPaid: 300_000_000, preLedgerPaid: 300_000_000, remaining: 0 });
  const base = { targetAmount: 720_000_000, monthlyAmount: 60_000_000, targetDate: "2027-07-01", currentMonth: "2026-10", currentMonthDone: true };
  assert.deepEqual(rentReserveOutlook({ ...base, currentAmount: 20_000_000 }), { shortfallNow: 700_000_000, monthsLeft: 8, projected: 500_000_000, projectedShortfall: 220_000_000 });
  assert.equal(rentReserveOutlook({ ...base, currentAmount: 120_000_000 }).projectedShortfall, 120_000_000);
  assert.equal(rentReserveOutlook({ ...base, currentAmount: 20_000_000, currentMonthDone: false }).monthsLeft, 9);
});

test("contract payload: editable dates/terms, unknown terms stay empty, invalid input rejected", () => {
  const payload = parseRentContractPayload({ name: "매장 임대 (차기 계약)", periodStart: "2027-07-01", periodEnd: "2028-06-30", annualAmount: 720_000_000, status: "planned", reservePlanId: 1 });
  assert.deepEqual(payload, { name: "매장 임대 (차기 계약)", lessorName: null, periodStart: "2027-07-01", periodEnd: "2028-06-30", annualAmount: 720_000_000, monthlyExpenseAmount: null,
    status: "planned", termsStatus: "provisional", paymentMethod: null, paymentDueDate: null, paymentTermsNote: null, recurringPlanId: null, reservePlanId: 1, memo: null });
  assert.equal(parseRentContractPayload({ ...payload, periodEnd: "2027-06-30" }), null);
  assert.equal(parseRentContractPayload({ ...payload, paymentMethod: "monthly" }), null);
  assert.equal(parseRentContractPayload({ ...payload, annualAmount: -1 }), null);
  assert.equal(parseRentContractPayload({ ...payload, paymentDueDate: "2027-13-01" }), null);
  assert.equal(parseRentContractPayload({ ...payload, paymentMethod: "installments", paymentDueDate: "2027-06-25" })?.paymentDueDate, "2027-06-25");
});

const BANK = { id: 2, code: "baba_corporate_bank", display_name: "BABA 법인계좌" };
const rentPlan = { amount: 50_000_000, planId: 3, planName: "매장 임대료 (현 계약)", frequency: "monthly", effectiveTo: null, effectiveFrom: "2026-08-01", recognitionDay: 1 };
const recognition = (id: number, month: string, category = "임대료"): TransactionRow => ({
  id, type: "expense_recognition", status: "confirmed", business_date: `${month}-01`, recognition_month: `${month}-01`, amount: "50000000.000",
  source_type: "recurring_expense", source_key: `recurring:3:${month}`, memo: "매장 임대료 (현 계약)", economic_effect_sign: 1,
  category: { id: 40, name: category }, source_snapshot: rentPlan,
});
const prepaid1304: TransactionRow = {
  id: 1304, type: "prepaid_expense_payment", status: "confirmed", business_date: "2026-08-11", amount: "300000000.000",
  source_type: "legacy_sheet_detail", source_key: "legacy-sheet-detail:2026-08:row:132:annual-rent-payment", economic_effect_sign: 1,
  memo: "8월 시트 row 132 · 1년치 임대료 실제 지급 300,000,000₫", source_snapshot: {}, movements: [{ amount: -300_000_000, fund_account: BANK }],
};

test("daily list hides only the rent's monthly allocation; payment, other recurring rows, detail data and totals stay", () => {
  const entries = buildLedgerEntries([recognition(3305, "2026-09"), recognition(3401, "2026-09", "보험"), prepaid1304], [], new Map(), [], "2026-09");
  const rent = entries.find(entry => entry.transactionId === 3305)!;
  const insurance = entries.find(entry => entry.transactionId === 3401)!;
  const payment = entries.find(entry => entry.transactionId === 1304)!;
  assert.equal(isHiddenRentAllocation(rent), true);
  assert.equal(isHiddenRentAllocation(insurance), false);
  assert.equal(isHiddenRentAllocation(payment), false);
  // Still in data.entries (detail + deep link) with its P&L amount; the day subtotal never included it.
  assert.equal(rent.amount, 50_000_000);
  assert.deepEqual(entryDisplaySubtotal(rent), { income: 0, expense: 0 });
  assert.deepEqual(entryDisplaySubtotal(payment), { income: 0, expense: 300_000_000 });
  const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
  const loop = page.slice(page.indexOf("for (const entry of listEntries)"), page.indexOf("const businessAccounts"));
  assert.match(loop, /if \(isHiddenRentAllocation\(entry\)\) continue;\s*if \(!entryMatchesListFilter\(entry, filter\)\) continue;/);
});

test("transaction deep link: one-shot, cleared on month switch, finds hidden rows via data.entries", () => {
  assert.equal(parseTransactionLedgerFocus(new URLSearchParams("month=2026-09&transactionId=3305")), 3305);
  for (const bad of ["transactionId=0", "transactionId=-1", "transactionId=3.5", "transactionId=x", ""]) assert.equal(parseTransactionLedgerFocus(new URLSearchParams(bad)), null);
  assert.equal(ledgerHrefWithoutInventoryFocus("/admin/ledger/entries", "month=2026-09&transactionId=3305"), "/admin/ledger/entries?month=2026-09");
  assert.equal(ledgerMonthHref("/admin/ledger/entries", "month=2026-09&transactionId=3305", "2026-10"), "/admin/ledger/entries?month=2026-10");
  const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
  const effect = page.slice(page.indexOf("const transactionFocusHandledRef"), page.indexOf("function editCandidate"));
  assert.match(effect, /data\.entries\.find\(entry => entry\.transactionId === focusTransactionId\)/);
  assert.match(effect, /router\.replace\(ledgerHrefWithoutInventoryFocus/);
  assert.doesNotMatch(effect, /router\.push/);
});

test("wiring: v2 RPCs in API/cron, recurring panel off screen, close sync kept, KPI outside the close snapshot", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  assert.match(read("app/api/admin/ledger/reserves/[id]/entries/route.ts"), /ledger_create_reserve_entry_v2/);
  assert.match(read("app/api/admin/ledger/reserves/schedule/route.ts"), /ledger_generate_reserve_schedule_v2/);
  assert.match(read("app/api/admin/ledger/reserves/schedule/[scheduleId]/route.ts"), /ledger_confirm_reserve_schedule_v2/);
  assert.match(read("app/api/cron/ledger-reserve-schedule/route.ts"), /ledger_generate_reserve_schedule_v2/);
  const settings = read("app/(protected)/admin/ledger/settings/page.tsx");
  assert.doesNotMatch(settings, /RecurringExpensePanel/);
  assert.match(settings, /<RentManagementPanel /);
  // The month-close sheet still books rent through the recurring sync before closing.
  assert.match(read("app/(protected)/admin/ledger/entries/MonthCloseSheet.tsx"), /recurring-expenses[\s\S]*action: "sync"/);
  // The close snapshot (and so the 8·9월 hashes) knows nothing about the new KPI or rent tables.
  const close = read("lib/ledger/month-close.ts");
  assert.doesNotMatch(close, /residual|rent_contract|allocation_kind|attribution_month/);
  const operating = read("lib/ledger/month-close-operating.ts");
  assert.doesNotMatch(operating, /residual|reserve/);
});
