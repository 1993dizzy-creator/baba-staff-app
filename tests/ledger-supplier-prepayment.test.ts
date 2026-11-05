import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isSupplierPrepayment, planPrepaymentApplication, totalUnusedPrepayment, unusedPrepaymentAmount, type UnusedPrepayment } from "../lib/ledger/supplier-prepayments.ts";
import { MANUAL_EXPENSE_SPECIAL_ACTIONS, isSupplierPrepaymentManualAction, SUPPLIER_PREPAYMENT_MANUAL_ACTION } from "../lib/ledger/manual-entry-policy.ts";

const read = (path: string) => readFileSync(path, "utf8");
const prepay = (id: number, businessDate: string, unusedAmount: number): UnusedPrepayment => ({ id, partyId: 20, businessDate, amount: unusedAmount, unusedAmount, memo: null });

test("unused balance = amount - allocations, never negative; only flagged confirmed payable payments count", () => {
  assert.equal(unusedPrepaymentAmount(6_402_000, []), 6_402_000);
  assert.equal(unusedPrepaymentAmount("5000000.000", [{ allocated_amount: "3000000.000" }, { allocated_amount: 1_500_000.5 }]), 499_999.5);
  assert.equal(unusedPrepaymentAmount(100, [{ allocated_amount: 150 }]), 0);
  assert.equal(isSupplierPrepayment({ type: "payable_payment", status: "confirmed", source_snapshot: { prepayment: true } }), true);
  assert.equal(isSupplierPrepayment({ type: "payable_payment", status: "confirmed", source_snapshot: { allocationMode: "custom" } }), false);
  assert.equal(isSupplierPrepayment({ type: "payable_payment", status: "cancelled", source_snapshot: { prepayment: true } }), false);
  assert.equal(totalUnusedPrepayment([prepay(1, "2026-11-04", 0.1), prepay(2, "2026-11-05", 0.2)]), 0.3);
});

test("plan splits several receipts over prepayments oldest first, merging pairs", () => {
  const plan = planPrepaymentApplication([prepay(9, "2026-11-06", 3_000_000), prepay(7, "2026-11-04", 2_000_000)],
    [{ payableId: 101, allocatedAmount: 1_500_000 }, { payableId: 102, allocatedAmount: 2_500_000 }]);
  assert.ok(!("error" in plan));
  assert.deepEqual(plan.allocations, [
    { prepaymentTransactionId: 7, payableId: 101, allocatedAmount: 1_500_000 },
    { prepaymentTransactionId: 7, payableId: 102, allocatedAmount: 500_000 },
    { prepaymentTransactionId: 9, payableId: 102, allocatedAmount: 2_000_000 },
  ]);
  assert.equal(plan.amount, 4_000_000);
});

test("plan never exceeds the unused balance (partial prepayment: the rest is paid normally)", () => {
  assert.deepEqual(planPrepaymentApplication([prepay(7, "2026-11-04", 3_000_000)], [{ payableId: 101, allocatedAmount: 6_402_000 }]), { error: "insufficient", available: 3_000_000 });
  const partial = planPrepaymentApplication([prepay(7, "2026-11-04", 3_000_000)], [{ payableId: 101, allocatedAmount: 3_000_000 }]);
  assert.ok(!("error" in partial)); assert.equal(partial.allocations.length, 1);
  assert.deepEqual(planPrepaymentApplication([prepay(7, "2026-11-04", 3_000_000)], []), { error: "empty", available: 3_000_000 });
  assert.deepEqual(planPrepaymentApplication([], [{ payableId: 1, allocatedAmount: 1 }]), { error: "insufficient", available: 0 });
});

test("manual expense form offers 💸 선결제 as a special action routed to the prepayment API", () => {
  assert.ok(MANUAL_EXPENSE_SPECIAL_ACTIONS.some(action => action.value === SUPPLIER_PREPAYMENT_MANUAL_ACTION && action.emoji === "💸"));
  assert.equal(isSupplierPrepaymentManualAction("__supplier_prepayment__"), true);
  const page = read("app/(protected)/admin/ledger/entries/page.tsx");
  assert.match(page, /supplierPrepayment \? "\/api\/admin\/ledger\/prepayments"/);
  assert.match(page, /partyId: Number\(selectedPartner\?\.ledgerPartyId\),\s+fundAccountId: Number\(fromAccountId\),/);
  assert.match(page, /if \(supplierPrepayment && !selectedPartner\?\.ledgerPartyId\) throw/);
  assert.match(page, /if \(supplierPrepayment\) setAdvanceRequestId\(crypto\.randomUUID\(\)\);/);
  // the prepayment body sits after the payroll-advance and investment bodies (both unchanged)
  assert.ok(page.indexOf("} : supplierPrepayment ? {") > page.indexOf("} : isInvestmentAdjustment ? {"));
});

test("payment verification offers the unused prepayment as a no-outflow settlement option", () => {
  const section = read("app/(protected)/admin/ledger/entries/PaymentVerificationSection.tsx");
  assert.match(section, /fetch\("\/api\/admin\/ledger\/prepayments", \{ cache: "no-store" \}\)/);
  assert.match(section, /<option value=\{PREPAYMENT_ACCOUNT\}>/);
  assert.match(section, /planPrepaymentApplication\(partyPrepayments, payment\.allocations\)/);
  assert.match(section, /fetch\("\/api\/admin\/ledger\/prepayments\/apply"/);
  // date/memo (a new outflow's fields) are not shown when settling from a prepayment
  assert.match(section, /\{usePrepayment \? <p className=\{styles\.verificationNotice\}/);
  // ordinary payments still go through the existing idempotent pay client
  assert.match(section, /await sendPayablePayment\(\{ partyId: payment\.partyId, fundAccountId: Number\(accountId\)/);
});

test("prepayment API routes call only the new RPCs with the actor id and validated ids", () => {
  const create = read("app/api/admin/ledger/prepayments/route.ts"), apply = read("app/api/admin/ledger/prepayments/apply/route.ts");
  assert.match(create, /rpc\("ledger_create_supplier_prepayment_v1"/);
  assert.match(create, /\.eq\("source_snapshot->>prepayment", "true"\)/);
  assert.match(apply, /rpc\("ledger_apply_supplier_prepayment_v1"/);
  for (const route of [create, apply]) {
    assert.match(route, /p_actor_user_id: auth\.actor\.id/);
    assert.match(route, /INVALID_REQUEST_ID/);
    assert.doesNotMatch(route, /\.from\("ledger_(movements|payable_allocations|payables)"\)\.(insert|update|delete)/);
  }
});

// ---------------------------------------------------------------------------
// P0-3 follow-up: month boundaries — application date vs original payment date
// ---------------------------------------------------------------------------
import { prepaymentApplicationDate, unusedPrepaymentAmountAsOf } from "../lib/ledger/supplier-prepayments.ts";

test("application date = greatest(prepayment, receipt); the prepayment date is never moved", () => {
  assert.equal(prepaymentApplicationDate("2026-10-31", "2026-11-02"), "2026-11-02");
  assert.equal(prepaymentApplicationDate("2026-11-04", "2026-10-30"), "2026-11-04");
  assert.equal(prepaymentApplicationDate("2026-11-04", null), "2026-11-04");
});

test("past-month unused balance is not changed by a later link (October stays 1,000,000 after a November link)", () => {
  const allocations = [{ allocated_amount: 600_000, receiptBusinessDate: "2026-11-02" }, { allocated_amount: 300_000, receiptBusinessDate: "2026-12-01" }];
  assert.equal(unusedPrepaymentAmountAsOf(1_000_000, "2026-10-31", allocations, "2026-11-01"), 1_000_000, "as of October end");
  assert.equal(unusedPrepaymentAmountAsOf(1_000_000, "2026-10-31", allocations, "2026-12-01"), 400_000, "as of November end: partial");
  assert.equal(unusedPrepaymentAmountAsOf(1_000_000, "2026-10-31", allocations, "2027-01-01"), 100_000, "as of December end");
  assert.equal(unusedPrepaymentAmountAsOf(1_000_000, "2026-11-04", [], "2026-11-01"), 0, "not yet paid in October");
  // a same-month receipt before the prepayment is applied on the prepayment date
  assert.equal(unusedPrepaymentAmountAsOf(500_000, "2026-11-04", [{ allocated_amount: 500_000, receiptBusinessDate: "2026-10-30" }], "2026-11-01"), 0);
  assert.equal(unusedPrepaymentAmountAsOf(500_000, "2026-11-04", [{ allocated_amount: 500_000, receiptBusinessDate: "2026-10-30" }], "2026-12-01"), 0);
});

test("unused prepayment API supports ?month as-of reads; cash report keeps later links out of the payment month", () => {
  const prepayments = read("app/api/admin/ledger/prepayments/route.ts"), ledger = read("app/api/admin/ledger/route.ts");
  assert.match(prepayments, /businessDateExclusive = payableMonthBounds\(month\)\.nextMonthStart/);
  assert.match(prepayments, /query = query\.lt\("business_date", businessDateExclusive\)/);
  assert.match(prepayments, /unusedPrepaymentAmountAsOf\(row\.amount, row\.business_date, allocations, businessDateExclusive\)/);
  assert.match(prepayments, /payable:ledger_payables\(expense:ledger_transactions!expense_transaction_id\(business_date\)\)/);
  assert.match(ledger, /row\.source_snapshot\?\.prepayment === true\)\.map\(\(row\) => \[Number\(row\.id\), String\(row\.business_date\)\]\)\),\s*nextMonth,/);
  assert.match(ledger, /return prepaymentApplicationDate\(prepaymentDate, expenseDates\.get\(expenseIdByPayable\.get\(Number\(row\.payable_id\)\) \?\? -1\)\) < businessDateExclusive;/);
  // ordinary payable payments are not filtered
  assert.match(ledger, /if \(prepaymentDate === undefined \|\| businessDateExclusive === undefined\) return true;/);
});

test("manual expense suggests 💸 선결제 for goods suppliers but never converts automatically", () => {
  const page = read("app/(protected)/admin/ledger/entries/page.tsx");
  assert.match(page, /const prepaymentHint = type === "expense" && !payrollAdvance && !supplierPrepayment && !!selectedPartner\?\.ledgerPartyId\s*&& \["food", "alcohol", "beverage", "consumable"\]\.includes\(selectedPartner\.partnerType\);/);
  assert.match(page, /입고 전에 지급한 매입대금이라면 선결제로 기록하세요/);
  assert.match(page, /onClick=\{\(\) => setCategoryId\(SUPPLIER_PREPAYMENT_MANUAL_ACTION\)\}/);
  // the only places that select the prepayment action are the hint button and the category selector
  assert.equal((page.match(/setCategoryId\(SUPPLIER_PREPAYMENT_MANUAL_ACTION\)/g) ?? []).length, 1);
  assert.doesNotMatch(page, /useEffect\([^)]*SUPPLIER_PREPAYMENT_MANUAL_ACTION/);
});
