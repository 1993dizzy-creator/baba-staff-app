import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculateManualAdjustmentTotals, calculatePayrollPayoutAmounts } from "../lib/payroll/adjustments.ts";

const read = (path: string) => readFileSync(path, "utf8");
const migration = read("supabase/migrations/20260908103734_add_payroll_advance_adjustment.sql");
const paymentMigration = read("supabase/migrations/202608050001_add_employee_payment_batches.sql");
const route = read("app/api/admin/payroll/adjustments/route.ts");
const overview = read("lib/payroll/overview.ts");
const paymentSnapshot = read("lib/payroll/payment-snapshot.ts");
const payments = read("app/api/admin/payroll/payments/route.ts");
const card = read("components/payroll/CompensationCard.tsx");
const attendancePage = read("app/(protected)/attendance/page.tsx");
const payrollCopy = read("lib/text/payroll-overview.ts");

function payout(
  adjustments: Array<{ kind: "incentive" | "penalty" | "advance"; amount: number }>,
) {
  const totals = calculateManualAdjustmentTotals(adjustments);
  return {
    totals,
    payout: calculatePayrollPayoutAmounts({
      automaticPreInsuranceAmount: 1_000_000,
      manualIncentiveAmount: totals.manualIncentiveAmount,
      manualPenaltyAmount: totals.manualPenaltyAmount,
      employeeInsuranceDeductionAmount: 100_000,
      advanceAmount: totals.advanceAmount,
    }),
  };
}

test("migration adds advance to kind and category without changing rows or lock/audit policies", () => {
  assert.match(migration, /kind in \('incentive', 'penalty', 'advance'\)/);
  assert.match(migration, /category in \('sales'[\s\S]*'manual','advance','other'\)/);
  assert.match(migration, /\(kind = 'advance'\) = \(category = 'advance'\)/);
  assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate)\b/i);
  assert.doesNotMatch(migration, /payroll_adjustment_cancel_audit|payroll_monthly_adjustments_paid_lock/);
  assert.match(paymentMigration, /before insert or update on public\.payroll_monthly_adjustments/);
  assert.match(paymentMigration, /PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE/);
});

test("API accepts advance as its own kind/category and keeps create/cancel security", () => {
  assert.match(route, /new Set\(\["incentive", "penalty", "advance"\]\)/);
  assert.match(route, /"manual","advance","other"/);
  assert.match(route, /\(kind==="advance"\)===\(category==="advance"\)/);
  assert.match(route, /requirePayrollActor\(\)/g);
  assert.match(route, /amount<1/);
  assert.match(route, /dateInMonth/);
  assert.match(route, /cancelled_at:new Date\(\)\.toISOString\(\)/);
  assert.match(route, /PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE/);
  assert.doesNotMatch(route, /\.delete\(/);
});

test("incentive-only and penalty-only calculations preserve existing results", () => {
  const incentive = payout([{ kind: "incentive", amount: 200_000 }]);
  assert.equal(incentive.payout.preInsurancePayoutAmount, 1_200_000);
  assert.equal(incentive.payout.netPayoutAmount, 1_100_000);
  const penalty = payout([{ kind: "penalty", amount: 150_000 }]);
  assert.equal(penalty.payout.preInsurancePayoutAmount, 850_000);
  assert.equal(penalty.payout.netPayoutAmount, 750_000);
});

test("advance-only reduces net but not pre-insurance pay or employee insurance", () => {
  const result = payout([{ kind: "advance", amount: 250_000 }]);
  assert.equal(result.totals.manualPenaltyAmount, 0);
  assert.equal(result.totals.advanceAmount, 250_000);
  assert.equal(result.payout.preInsurancePayoutAmount, 1_000_000);
  assert.equal(result.payout.netPayoutAmount, 650_000);
});

test("incentive, penalty, and advance stay separate in a combined calculation", () => {
  const result = payout([
    { kind: "incentive", amount: 200_000 },
    { kind: "penalty", amount: 50_000 },
    { kind: "advance", amount: 300_000 },
  ]);
  assert.deepEqual(result.totals, {
    manualIncentiveAmount: 200_000,
    manualPenaltyAmount: 50_000,
    advanceAmount: 300_000,
    incentiveCount: 1,
    penaltyCount: 1,
    advanceCount: 1,
  });
  assert.equal(result.payout.preInsurancePayoutAmount, 1_150_000);
  assert.equal(result.payout.netPayoutAmount, 750_000);
});

test("overview, payment snapshot/hash, and calculated net amount carry advance", () => {
  assert.match(overview, /advanceAmount: number;[\s\S]*advanceCount: number;/);
  assert.match(overview, /calculatePayrollPayoutAmounts\(\{automaticPreInsuranceAmount,manualIncentiveAmount,manualPenaltyAmount,employeeInsuranceDeductionAmount,advanceAmount\}\)/);
  assert.match(paymentSnapshot, /return \{employee,[\s\S]*adjustmentsSnapshot:employee\.adjustments/);
  assert.match(payments, /payrollPaymentSnapshotHash\(calculationSnapshot\)/);
  assert.match(payments, /p_calculated_net_amount:employee\.amounts\.netPayoutAmount/);
});

test("admin and attendance UI use the requested bilingual combined label and separate details", () => {
  assert.ok(payrollCopy.includes('penalty:"패널티&가불"'));
  assert.ok(payrollCopy.includes('penalty:"Phạt & Ứng lương"'));
  assert.ok(attendancePage.includes('penalty: "패널티&가불"'));
  assert.ok(attendancePage.includes('penalty: "Phạt & Ứng lương"'));
  assert.match(card, /option value="penalty"/);
  assert.match(card, /option value="advance"/);
  assert.match(card, /item\.kind === "advance" \? t\.advance : item\.kind === "penalty" \? t\.manualPenalty/);
  assert.match(attendancePage, /item\.category === "advance"[\s\S]*text\.advance/);
});
