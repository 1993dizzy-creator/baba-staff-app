import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { getAttendanceAdjustmentTotal, selectAttendancePayrollSummary } from "../lib/payroll/attendance-self-summary.ts";
import type { PayrollOverviewEmployee } from "../lib/payroll/overview.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/payroll-summary/route.ts");

function employee(
  userId: number,
  values: Partial<PayrollOverviewEmployee["amounts"]> = {},
  calculationStatus: PayrollOverviewEmployee["calculationStatus"] = "calculable",
) : PayrollOverviewEmployee {
  return {
    userId,
    name: `Employee ${userId}`,
    username: `employee-${userId}`,
    birthDate: null,
    part: null,
    position: null,
    role: "staff",
    levelInfo: {
      eligible: false,
      reason: "PROGRAM_DISABLED",
      level: null,
      displayLabel: null,
      baseDate: null,
      baseDateSource: null,
      calculationDate: null,
      completedQuarterCount: 0,
      earnedRaiseCount: 0,
      raiseAmountPerStep: 500_000,
      cumulativeRaiseAmount: 0,
      nextLevelDate: null,
      negotiationEligibleAt: null,
      negotiationEligible: false,
    },
    calculationStatus,
    recognizedWorkdays: 0,
    recognizedMinutes: 0,
    insuranceEnrolled: false,
    tax: {
      status: "not_applicable",
      warningCodes: [],
      taxMode: "not_applicable",
      taxBurdenMode: "employee_deducted",
      taxPolicyId: null,
      taxPolicyRevision: null,
      taxProfileId: 1,
      taxProfileRevision: 1,
      personalDeductionAmount: 0,
      dependentCount: 0,
      dependentDeductionAmount: 0,
      taxableCompensationAmount: 2_850_000,
      deductibleInsuranceAmount: 0,
      taxableIncomeBeforeGrossUpAmount: 0,
      taxableIncomeAmount: 0,
      calculatedPitAmount: 0,
      employeePitDeductionAmount: 0,
      companyPitAmount: 0,
      accountingName: null,
      insuranceDeductionMode: "none",
      manualInsuranceDeductionAmount: 0,
      policySnapshot: null,
      profileSnapshot: null,
    },
    contract: null,
    levelApplication: {
      currentLevel: null,
      earnedRaiseCount: 0,
      raiseAmountPerStep: 500_000,
      accruedRaiseAmount: null,
      status: "not_applicable",
    },
    adjustments: [],
    automaticPenalties: [],
    automaticIncentives: [],
    partTimeExtraWork: [],
    unresolvedAttendanceCount: 0,
    attendanceMetrics: {
      lateCount: 0,
      lateMinutes: 0,
      earlyLeaveCount: 0,
      earlyLeaveMinutes: 0,
    },
    reviewCount: 0,
    blockingCount: 0,
    warningCodes: [],
    attendanceStanding: null,
    amounts: {
      contractSalary: null,
      fixedRaiseAmount: null,
      combinedSalary: null,
      contractMonthlyEquivalent: null,
      contractBaseSalary: null,
      accruedWorkAmount: 0,
      levelRaiseAmount: null,
      paidLeaveAmount: 0,
      overtimeAmount: 0,
      partTimeExtraWorkAmount: 0,
      taxableOvertimeAmount: 0,
      taxExemptOvertimeAmount: 0,
      taxableOtherAdditionAmount: 0,
      unearnedCompensationAmount: 0,
      latePenaltyAmount: 0,
      earlyLeavePenaltyAmount: 0,
      otherAdditionAmount: 0,
      otherDeductionAmount: 0,
      currentAmount: 2_850_000,
      workAppliedAmount: 0,
      netPayoutAmount: 2_850_000,
      employeeInsuranceDeductionAmount: 0,
      employeePitDeductionAmount: 0,
      companyPitAmount: 0,
      incentiveAmount: 120_000,
      manualIncentiveAmount: 120_000,
      automaticIncentiveAmount: 0,
      incentiveCount: 0,
      automaticPenaltyAmount: 0,
      manualPenaltyAmount: 35_000,
      penaltyAmount: 35_000,
      penaltyCount: 0,
      advanceAmount: 0,
      advanceCount: 0,
      insuranceBaseAmount: 0,
      preInsurancePayoutAmount: 2_850_000,
      employerInsuranceAmount: 0,
      ...values,
    },
  };
}

test("self payroll summary projects only the authenticated employee amounts", () => {
  const employees = [employee(11), employee(22, { netPayoutAmount: 9_999_999 })];
  assert.deepEqual(selectAttendancePayrollSummary(employees, 11), {
    perfectAttendanceCurrent: false,
    summary: {
      employeeInsuranceDeductionAmount: 0,
      incentiveAmount: 120_000,
      penaltyAmount: 35_000,
      advanceAmount: 0,
      taxStatus: "not_applicable",
      taxMode: "not_applicable",
      taxBurdenMode: "employee_deducted",
      calculatedPitAmount: 0,
      employeePitDeductionAmount: 0,
      companyPitAmount: 0,
    },
    incentives: [],
    penalties: [],
    advances: [],
  });
  assert.equal(selectAttendancePayrollSummary(employees, 33), null);
});

test("self payroll summary does not expose internal calculation status", () => {
  for (const status of ["requires_review", "unavailable"] as const) {
    const source = employee(11, {
      netPayoutAmount: 777,
      incentiveAmount: 22,
      penaltyAmount: 11,
    }, status);
    assert.deepEqual(selectAttendancePayrollSummary([source], 11), {
      perfectAttendanceCurrent: false,
      summary: {
        employeeInsuranceDeductionAmount: 0,
        incentiveAmount: 22,
        penaltyAmount: 11,
        advanceAmount: 0,
        taxStatus: "not_applicable",
        taxMode: "not_applicable",
        taxBurdenMode: "employee_deducted",
        calculatedPitAmount: 0,
        employeePitDeductionAmount: 0,
        companyPitAmount: 0,
      },
      incentives: [],
      penalties: [],
      advances: [],
    });
    assert.doesNotMatch(JSON.stringify(selectAttendancePayrollSummary([source], 11)), /calculationStatus/);
  }
});

test("self payroll summary reuses the employee monthly standing result", () => {
  const source = employee(11);
  source.attendanceStanding = {
    actualWorkDays: 26,
    lateCount: 0,
    earlyLeaveCount: 0,
    unauthorizedAbsenceCount: 0,
    blockingCount: 0,
    perfectAttendanceCurrent: true,
  };

  assert.equal(
    selectAttendancePayrollSummary([source], 11)?.perfectAttendanceCurrent,
    true,
  );

  source.attendanceStanding = null;
  assert.equal(
    selectAttendancePayrollSummary([source], 11)?.perfectAttendanceCurrent,
    false,
  );
});

test("self projection exposes only display DTOs and preserves incentive and combined penalty totals", () => {
  const source = employee(11);
  source.adjustments = [
    { id: 1, kind: "incentive", category: "sales", amount: 120_000, businessDate: "2026-08-03", reason: "Sales", note: "August", createdAt: "private" },
    { id: 2, kind: "penalty", category: "manual", amount: 20_000, businessDate: "2026-08-07", reason: "Manual", note: null, createdAt: "private" },
    { id: 3, kind: "advance", category: "advance", amount: 50_000, businessDate: "2026-08-09", reason: "Advance", note: "August advance", createdAt: "private" },
  ];
  source.automaticPenalties = [
    { sourceType: "automatic", category: "late", businessDate: "2026-08-02", minutes: 12, amount: 15_000, attendanceRecordId: 999, description: "Late" },
  ];
  const result = selectAttendancePayrollSummary([source, employee(22)], 11);
  assert.ok(result);
  assert.equal(result.incentives.reduce((sum, item) => sum + item.amount, 0), result.summary.incentiveAmount);
  assert.equal(result.penalties.reduce((sum, item) => sum + item.amount, 0), result.summary.penaltyAmount);
  assert.deepEqual(result.incentives[0], {
    sourceType: "manual", businessDate: "2026-08-03", category: "sales", reason: "Sales", note: "August", amount: 120_000,
  });
  assert.deepEqual(result.penalties.map((item) => item.sourceType), ["automatic", "manual"]);
  assert.deepEqual(result.advances, [{
    sourceType: "manual", businessDate: "2026-08-09", category: "advance", reason: "Advance", note: "August advance", amount: 50_000,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /attendanceRecordId|createdAt|"id"|999|private/);
});

test("self projection removes net payout and exposes only the employee insurance deduction", () => {
  const source = employee(11, {
    netPayoutAmount: -300_000,
    employeeInsuranceDeductionAmount: 300_000,
  });
  const result = selectAttendancePayrollSummary([source], 11);
  assert.equal(result?.summary.employeeInsuranceDeductionAmount, 300_000);
  assert.doesNotMatch(JSON.stringify(result), /netPayoutAmount|insuranceSnapshot|insuranceEnrolled|insuranceBaseAmount|employerInsuranceAmount/);
});

test("adjustment total is incentive minus penalty and advance", () => {
  assert.equal(getAttendanceAdjustmentTotal({ incentiveAmount: 0, penaltyAmount: 30_000, advanceAmount: 0 }), -30_000);
  assert.equal(getAttendanceAdjustmentTotal({ incentiveAmount: 100_000, penaltyAmount: 30_000, advanceAmount: 20_000 }), 50_000);
  assert.equal(getAttendanceAdjustmentTotal({ incentiveAmount: 0, penaltyAmount: 0, advanceAmount: 40_000 }), -40_000);
});

test("attendance payroll route is actor-only, validates month, and reuses the unified overview", () => {
  assert.match(route, /const auth = await requireAttendanceActor\(\)/);
  assert.match(route, /validPayrollMonth\(new URL\(request\.url\)\.searchParams\.get\("month"\)\)/);
  assert.match(route, /code: "INVALID_MONTH"[\s\S]*400/);
  assert.match(route, /loadPayrollOverview\(month, \{[\s\S]*userId: auth\.actor\.id,[\s\S]*\}\)/);
  assert.match(route, /selectAttendancePayrollSummary\([\s\S]*overview\.employees,[\s\S]*auth\.actor\.id/);
  assert.match(route, /perfectAttendanceCurrent: data\?\.perfectAttendanceCurrent \?\? false/);
  assert.match(route, /summary: data\?\.summary \?\? null/);
  assert.match(route, /incentives: data\?\.incentives \?\? \[\]/);
  assert.match(route, /penalties: data\?\.penalties \?\? \[\]/);
  assert.match(route, /advances: data\?\.advances \?\? \[\]/);
  assert.doesNotMatch(route, /searchParams\.get\("userId"\)|body\.userId|requirePayrollActor/);
  assert.doesNotMatch(route, /insuranceSnapshot/);
  assert.doesNotMatch(route + read("lib/payroll/attendance-self-summary.ts"), /netPayoutAmount/);
  assert.doesNotMatch(route, /attendanceJson\(\{ ok: true, month, employees/);
});
