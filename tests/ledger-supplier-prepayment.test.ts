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
