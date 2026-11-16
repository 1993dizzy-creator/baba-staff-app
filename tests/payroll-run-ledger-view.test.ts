import assert from "node:assert/strict";
import test from "node:test";
import { buildPaymentOutflows } from "../lib/payroll/payment-outflows.ts";
import { digestDifferenceReasons, nextRunLedgerTab, RUN_LEDGER_TABS, shortPaymentDate, summarizeRunOutflow } from "../lib/payroll/run-ledger-view.ts";

// Synthetic amounts only (public repository). Real batch figures are verified outside Git.

test("summary: total outflow = employee paid + unassigned residual; stored batch total only compared, never replaced", () => {
  const employees = [
    { id: 1, employee_name: "A", payment_status: "paid" as const, actual_paid_amount: 5000000, payment_date: "2026-11-10", fund_account_id: 2 },
    { id: 2, employee_name: "B", payment_status: "paid" as const, actual_paid_amount: 4000002, payment_date: "2026-11-10", fund_account_id: 2 },
    { id: 3, employee_name: "C", payment_status: "unpaid" as const, actual_paid_amount: null, payment_date: null, fund_account_id: null },
  ];
  const residuals = [{ id: 1, payment_date: "2026-11-10", fund_account_id: 2, amount: 1, reason: "synthetic" }];
  const outflows = buildPaymentOutflows({ employees, residuals });
  assert.deepEqual(summarizeRunOutflow(9000002, outflows), { outflowTotal: 9000003, employeePaidTotal: 9000002, residualTotal: 1, storedPaidTotal: 9000002, paidTotalMatches: true });
  assert.equal(summarizeRunOutflow("9000000", outflows).paidTotalMatches, false);
  assert.equal(summarizeRunOutflow(null, buildPaymentOutflows({ employees: [] })).outflowTotal, 0, "empty / paying batch");
});

test("difference digest: common lead shown once, amount segment dropped from the short note, originals untouched", () => {
  const lead = "2026-10 synthetic corrected sheet basis";
  const reasons = [
    `${lead} · APP 계산 100₫ → 실지급 92₫ (차액 −8₫)`,
    `${lead} · APP 계산 200₫ → 실지급 202₫ (차액 +2₫) · bank 150₫ + cash refund 52₫`,
    null,
  ];
  const before = JSON.stringify(reasons);
  const digest = digestDifferenceReasons(reasons);
  assert.equal(digest.commonLead, lead);
  assert.deepEqual(digest.notes, [null, "bank 150₫ + cash refund 52₫", null]);
  assert.equal(JSON.stringify(reasons), before, "input reasons are not modified");
  // 서로 다른 자유 입력 사유(일반 급여월): 공통 사유 없음, 전체가 짧은 안내(화면에서 2줄 말줄임, 원문은 상세)
  assert.deepEqual(digestDifferenceReasons(["교통비 정산", "현금 반올림"]), { commonLead: null, notes: ["교통비 정산", "현금 반올림"] });
  // 1명뿐이면 공통 사유로 묶지 않는다
  assert.deepEqual(digestDifferenceReasons([`${lead} · APP 계산 1₫ → 실지급 2₫ (차액 +1₫)`]), { commonLead: null, notes: [lead] });
});

test("tabs switch in a fixed order with arrow/Home/End keys", () => {
  assert.deepEqual(RUN_LEDGER_TABS, ["payments", "differences", "audit"]);
  assert.equal(nextRunLedgerTab("payments", "ArrowRight"), "differences");
  assert.equal(nextRunLedgerTab("audit", "ArrowRight"), "payments");
  assert.equal(nextRunLedgerTab("payments", "ArrowLeft"), "audit");
  assert.equal(nextRunLedgerTab("differences", "Home"), "payments");
  assert.equal(nextRunLedgerTab("differences", "End"), "audit");
  assert.equal(nextRunLedgerTab("differences", "Enter"), null);
});

test("short payment date keeps unknown formats as-is", () => {
  assert.equal(shortPaymentDate("2026-11-10"), "11/10");
  assert.equal(shortPaymentDate("2026-01-05"), "1/5");
  assert.equal(shortPaymentDate(null), "—");
  assert.equal(shortPaymentDate("legacy"), "legacy");
});
