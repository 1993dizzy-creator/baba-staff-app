import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  getAttendanceAdjustmentTotal,
  selectAttendancePayrollSummary,
} from "../lib/payroll/attendance-self-summary.ts";
import type { PayrollOverviewEmployee } from "../lib/payroll/overview.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/payroll-summary/route.ts");

function employee(
  userId: number,
  values: Partial<PayrollOverviewEmployee["amounts"]> = {},
  calculationStatus: PayrollOverviewEmployee["calculationStatus"] = "calculable",
) {
  return {
    userId,
    calculationStatus,
    adjustments: [],
    automaticPenalties: [],
    amounts: {
      netPayoutAmount: 2_850_000,
      employeeInsuranceDeductionAmount: 0,
      incentiveAmount: 120_000,
      penaltyAmount: 35_000,
      ...values,
    },
  } as PayrollOverviewEmployee;
}

test("self payroll summary projects only the authenticated employee amounts", () => {
  const employees = [employee(11), employee(22, { netPayoutAmount: 9_999_999 })];
  assert.deepEqual(selectAttendancePayrollSummary(employees, 11), {
    summary: {
      employeeInsuranceDeductionAmount: 0,
      incentiveAmount: 120_000,
      penaltyAmount: 35_000,
    },
    incentives: [],
    penalties: [],
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
      summary: {
        employeeInsuranceDeductionAmount: 0,
        incentiveAmount: 22,
        penaltyAmount: 11,
      },
      incentives: [],
      penalties: [],
    });
    assert.doesNotMatch(JSON.stringify(selectAttendancePayrollSummary([source], 11)), /calculationStatus/);
  }
});

test("self projection exposes only display DTOs and preserves incentive and combined penalty totals", () => {
  const source = employee(11);
  source.adjustments = [
    { id: 1, kind: "incentive", category: "sales", amount: 120_000, businessDate: "2026-08-03", reason: "Sales", note: "August", createdAt: "private" },
    { id: 2, kind: "penalty", category: "manual", amount: 20_000, businessDate: "2026-08-07", reason: "Manual", note: null, createdAt: "private" },
  ];
  source.automaticPenalties = [
    { sourceType: "automatic", category: "late", businessDate: "2026-08-02", minutes: 12, amount: 15_000, attendanceRecordId: 999, description: "Late" },
  ];
  const result = selectAttendancePayrollSummary([source, employee(22)], 11);
  assert.ok(result);
  assert.equal(result.incentives.reduce((sum, item) => sum + item.amount, 0), result.summary.incentiveAmount);
  assert.equal(result.penalties.reduce((sum, item) => sum + item.amount, 0), result.summary.penaltyAmount);
  assert.deepEqual(result.incentives[0], {
    businessDate: "2026-08-03", category: "sales", reason: "Sales", note: "August", amount: 120_000,
  });
  assert.deepEqual(result.penalties.map((item) => item.sourceType), ["automatic", "manual"]);
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

test("adjustment total is incentive minus the positive penalty amount", () => {
  assert.equal(getAttendanceAdjustmentTotal({ incentiveAmount: 0, penaltyAmount: 30_000 }), -30_000);
  assert.equal(getAttendanceAdjustmentTotal({ incentiveAmount: 100_000, penaltyAmount: 30_000 }), 70_000);
  assert.equal(getAttendanceAdjustmentTotal({ incentiveAmount: 0, penaltyAmount: 0 }), 0);
});

test("attendance payroll route is actor-only, validates month, and reuses the unified overview", () => {
  assert.match(route, /const auth = await requireAttendanceActor\(\)/);
  assert.match(route, /validPayrollMonth\(new URL\(request\.url\)\.searchParams\.get\("month"\)\)/);
  assert.match(route, /code: "INVALID_MONTH"[\s\S]*400/);
  assert.match(route, /loadPayrollOverview\(month\)/);
  assert.match(route, /selectAttendancePayrollSummary\([\s\S]*overview\.employees,[\s\S]*auth\.actor\.id/);
  assert.match(route, /summary: data\?\.summary \?\? null/);
  assert.match(route, /incentives: data\?\.incentives \?\? \[\]/);
  assert.match(route, /penalties: data\?\.penalties \?\? \[\]/);
  assert.doesNotMatch(route, /searchParams\.get\("userId"\)|body\.userId|requirePayrollActor/);
  assert.doesNotMatch(route, /insuranceSnapshot/);
  assert.doesNotMatch(route + read("lib/payroll/attendance-self-summary.ts"), /netPayoutAmount/);
  assert.doesNotMatch(route, /attendanceJson\(\{ ok: true, month, employees/);
});
