import type { PayrollOverviewEmployee } from "@/lib/payroll/overview";

export type AttendancePayrollSummary = {
  netPayoutAmount: number;
  employeeInsuranceDeductionAmount: number;
  incentiveAmount: number;
  penaltyAmount: number;
  calculationStatus: PayrollOverviewEmployee["calculationStatus"];
};

export type AttendancePayrollIncentive = {
  businessDate: string;
  category: string;
  reason: string;
  note: string | null;
  amount: number;
};

export type AttendancePayrollPenalty = {
  sourceType: "automatic" | "manual";
  businessDate: string;
  category: string;
  reason: string;
  note: string | null;
  minutes: number | null;
  amount: number;
};

export type AttendancePayrollData = {
  summary: AttendancePayrollSummary;
  incentives: AttendancePayrollIncentive[];
  penalties: AttendancePayrollPenalty[];
};

export function selectAttendancePayrollSummary(
  employees: PayrollOverviewEmployee[],
  actorId: number,
): AttendancePayrollData | null {
  const employee = employees.find((item) => item.userId === actorId);
  if (!employee) return null;

  const incentives = employee.adjustments
    .filter((item) => item.kind === "incentive")
    .map((item) => ({
      businessDate: item.businessDate,
      category: item.category,
      reason: item.reason,
      note: item.note,
      amount: item.amount,
    }))
    .sort((left, right) => left.businessDate.localeCompare(right.businessDate));
  const penalties = [
    ...employee.automaticPenalties.map((item) => ({
      sourceType: "automatic" as const,
      businessDate: item.businessDate,
      category: item.category,
      reason: item.description,
      note: null,
      minutes: item.minutes,
      amount: item.amount,
    })),
    ...employee.adjustments
      .filter((item) => item.kind === "penalty")
      .map((item) => ({
        sourceType: "manual" as const,
        businessDate: item.businessDate,
        category: item.category,
        reason: item.reason,
        note: item.note,
        minutes: null,
        amount: item.amount,
      })),
  ].sort((left, right) => left.businessDate.localeCompare(right.businessDate));

  return {
    summary: {
      netPayoutAmount: employee.amounts.netPayoutAmount,
      employeeInsuranceDeductionAmount:
        employee.amounts.employeeInsuranceDeductionAmount,
      incentiveAmount: employee.amounts.incentiveAmount,
      penaltyAmount: employee.amounts.penaltyAmount,
      calculationStatus: employee.calculationStatus,
    },
    incentives,
    penalties,
  };
}
