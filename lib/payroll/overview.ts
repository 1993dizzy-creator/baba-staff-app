import "server-only";

import { getEmployeeLevelInfo } from "@/lib/employee-level/server";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";
import type {
  PayrollRunEmployeeInput,
  PayrollRunItemInput,
  PayrollSnapshotUserRow,
} from "@/lib/payroll/monthly-run";
import type { PayrollContract } from "@/lib/payroll/types";
import type { PayrollOverviewPeriod } from "@/lib/payroll/overview-period";
import { calculateCombinedSalary } from "@/lib/payroll/compensation";
import { calculatePayrollInsuranceTotals } from "@/lib/payroll/insurance";

export type PayrollMonthlyAdjustment = { id:number;kind:"incentive"|"penalty";category:string;amount:number;businessDate:string;reason:string;note:string|null;createdAt:string };

export type PayrollOverviewEmployee = {
  userId: number;
  name: string;
  username: string;
  birthDate: string | null;
  part: string | null;
  position: string | null;
  levelInfo: EmployeeLevelInfo;
  calculationStatus: "calculable" | "requires_review" | "unavailable";
  recognizedWorkdays: number;
  contract: PayrollContract | null;
  levelApplication: {
    currentLevel: number | null;
    earnedRaiseCount: number | null;
    raiseAmountPerStep: number | null;
    accruedRaiseAmount: number | null;
    status: "applied" | "not_applicable" | "requires_review";
  };
  amounts: {
    contractSalary: number | null;
    fixedRaiseAmount: number | null;
    combinedSalary: number | null;
    contractBaseSalary: number | null;
    accruedWorkAmount: number;
    levelRaiseAmount: number | null;
    paidLeaveAmount: number;
    overtimeAmount: number;
    latePenaltyAmount: number;
    earlyLeavePenaltyAmount: number;
    otherAdditionAmount: number;
    otherDeductionAmount: number;
    currentAmount: number | null;
    workAppliedAmount: number | null;
    incentiveAmount: number;
    incentiveCount: number;
    automaticPenaltyAmount: number;
    manualPenaltyAmount: number;
    penaltyAmount: number;
    penaltyCount: number;
    insuranceBaseAmount: number;
    preInsurancePayoutAmount: number;
    employeeInsuranceDeductionAmount: number;
    netPayoutAmount: number;
    employerInsuranceAmount: number;
  };
  adjustments: PayrollMonthlyAdjustment[];
  automaticPenalties: Array<{sourceType:"automatic";category:"late"|"early_leave"|"unauthorized_absence";businessDate:string;minutes:number;amount:number;attendanceRecordId:number|null;description:string}>;
  unresolvedAttendanceCount: number;
  attendanceMetrics: {
    lateCount: number;
    lateMinutes: number;
    earlyLeaveCount: number;
    earlyLeaveMinutes: number;
  };
  reviewCount: number;
  blockingCount: number;
  warningCodes: string[];
};

function sum(items: PayrollRunItemInput[], category: string, direction?: "addition" | "deduction") {
  return items
    .filter((entry) => entry.category === category && (!direction || entry.direction === direction))
    .reduce((total, entry) => total + Number(entry.amount || 0), 0);
}

function activeContract(contracts: PayrollContract[], date: string) {
  const matches = contracts.filter((contract) =>
    contract.effectiveFrom <= date && (!contract.effectiveTo || contract.effectiveTo > date)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function buildPayrollOverviewEmployee(input: {
  employee: PayrollRunEmployeeInput;
  user: PayrollSnapshotUserRow;
  contracts: PayrollContract[];
  carriedItems?: PayrollRunItemInput[];
  period: PayrollOverviewPeriod;
  adjustments?: PayrollMonthlyAdjustment[];
}): PayrollOverviewEmployee {
  const { employee, user, period } = input;
  const contract = activeContract(input.contracts, period.asOfDate);
  const levelInfo = getEmployeeLevelInfo(user, period.levelAsOfDate);
  const compensation = contract ? calculateCombinedSalary(contract, levelInfo) : null;
  const levelStatus = !levelInfo.eligible
    ? "not_applicable" as const
    : compensation?.combinedSalary === null
      ? "requires_review" as const
      : "applied" as const;
  const items = [...employee.items, ...(input.carriedItems ?? [])];
  const accruedWorkAmount = sum(items, "base_work", "addition");
  const paidLeaveAmount = sum(items, "paid_leave", "addition");
  const overtimeAmount = sum(items, "overtime", "addition");
  const latePenaltyAmount = sum(items, "late_deduction", "deduction");
  const earlyLeavePenaltyAmount = sum(items, "early_leave_deduction", "deduction");
  const unauthorizedAbsencePenaltyAmount=sum(items,"unauthorized_absence_deduction","deduction");
  const automaticPenalties=items.filter(entry=>entry.direction==="deduction"&&["late_deduction","early_leave_deduction","unauthorized_absence_deduction"].includes(entry.category)).map(entry=>({sourceType:"automatic" as const,category:entry.category==="late_deduction"?"late" as const:entry.category==="early_leave_deduction"?"early_leave" as const:"unauthorized_absence" as const,businessDate:entry.businessDate??"",minutes:Number(entry.sourceSnapshot.lateMinutes??entry.sourceSnapshot.minutes??0),amount:entry.amount,attendanceRecordId:entry.sourceSnapshot.attendanceRecordId===null||entry.sourceSnapshot.attendanceRecordId===undefined?null:Number(entry.sourceSnapshot.attendanceRecordId),description:entry.description}));
  const adjustments=input.adjustments??[];const incentives=adjustments.filter(entry=>entry.kind==="incentive");const manualPenalties=adjustments.filter(entry=>entry.kind==="penalty");const incentiveAmount=incentives.reduce((total,entry)=>total+entry.amount,0);const manualPenaltyAmount=manualPenalties.reduce((total,entry)=>total+entry.amount,0);const automaticPenaltyAmount=latePenaltyAmount+earlyLeavePenaltyAmount+unauthorizedAbsencePenaltyAmount;const penaltyAmount=automaticPenaltyAmount+manualPenaltyAmount;const workAppliedAmount=accruedWorkAmount+paidLeaveAmount;
  const knownCategories = new Set(["base_work", "paid_leave", "overtime", "late_deduction", "early_leave_deduction", "unauthorized_absence_deduction", "insurance_employee_deduction"]);
  const otherAdditionAmount = items.filter((entry) => entry.direction === "addition" && !knownCategories.has(entry.category)).reduce((total, entry) => total + entry.amount, 0);
  const otherDeductionAmount = items.filter((entry) => entry.direction === "deduction" && !knownCategories.has(entry.category)).reduce((total, entry) => total + entry.amount, 0);
  const blockingCount = employee.reviews.filter((review) => review.reviewLevel === "blocking").length;
  const warningCodes = [...new Set(employee.reviews.map((review) => review.warningCode))];
  const automaticPreInsuranceAmount=items.filter(entry=>entry.category!=="insurance_employee_deduction").reduce((total,entry)=>total+(entry.direction==="addition"?entry.amount:-entry.amount),0);
  const preInsurancePayoutAmount=automaticPreInsuranceAmount+incentiveAmount-manualPenaltyAmount;const employeeInsuranceDeductionAmount=employee.insuranceSnapshot.employeeDeductionAmount;const netPayoutAmount=preInsurancePayoutAmount-employeeInsuranceDeductionAmount;
  const unavailable = period.future || !contract || compensation?.combinedSalary===null;
  const requiresReview = !unavailable && (employee.reviews.length > 0 || levelStatus === "requires_review");
  const days = ((employee.attendanceSnapshot.days ?? []) as Array<{ facts?: { lateMinutes?: number; earlyLeaveMinutes?: number } }>);
  const unresolvedAttendanceCount=new Set(employee.reviews.filter(review=>review.businessDate&&["MISSING_CHECK_IN","MISSING_CHECK_OUT","INVALID_TIME_RANGE"].includes(review.warningCode)).map(review=>review.businessDate)).size;

  return {
    userId: user.id,
    name: user.name || user.full_name || user.username,
    username: user.username,
    birthDate: user.birth_date,
    part: user.part,
    position: user.position,
    levelInfo,
    calculationStatus: unavailable ? "unavailable" : requiresReview ? "requires_review" : "calculable",
    recognizedWorkdays: employee.recognizedWorkdays,
    contract,
    adjustments,
    automaticPenalties,
    unresolvedAttendanceCount,
    levelApplication: {
      currentLevel: levelInfo.level,
      earnedRaiseCount: levelInfo.eligible ? levelInfo.earnedRaiseCount : null,
      raiseAmountPerStep: levelInfo.eligible ? levelInfo.raiseAmountPerStep : null,
      accruedRaiseAmount: compensation?.levelRaiseAmount ?? null,
      status: levelStatus,
    },
    amounts: {
      contractSalary: contract?.baseSalary ?? null,
      fixedRaiseAmount: contract?.fixedRaiseAmount ?? null,
      combinedSalary: compensation?.combinedSalary ?? null,
      contractBaseSalary: contract?.baseSalary ?? null,
      accruedWorkAmount,
      levelRaiseAmount: compensation?.levelRaiseAmount ?? null,
      paidLeaveAmount,
      overtimeAmount,
      latePenaltyAmount,
      earlyLeavePenaltyAmount,
      otherAdditionAmount,
      otherDeductionAmount,
      currentAmount: unavailable ? null : netPayoutAmount,
      workAppliedAmount: unavailable ? null : workAppliedAmount,
      incentiveAmount,incentiveCount:incentives.length,automaticPenaltyAmount,manualPenaltyAmount,penaltyAmount,penaltyCount:manualPenalties.length+items.filter(entry=>entry.direction==="deduction"&&["late_deduction","early_leave_deduction","unauthorized_absence_deduction"].includes(entry.category)).length,
      insuranceBaseAmount:employee.insuranceSnapshot.insuranceBaseAmount,preInsurancePayoutAmount,employeeInsuranceDeductionAmount,netPayoutAmount,employerInsuranceAmount:employee.insuranceSnapshot.employerAmount,
    },
    attendanceMetrics: {
      lateCount: days.filter((day) => Number(day.facts?.lateMinutes || 0) > 0).length,
      lateMinutes: employee.lateMinutes,
      earlyLeaveCount: days.filter((day) => Number(day.facts?.earlyLeaveMinutes || 0) > 0).length,
      earlyLeaveMinutes: employee.earlyLeaveMinutes,
    },
    reviewCount: employee.reviews.length,
    blockingCount,
    warningCodes,
  };
}

export function buildPayrollOverviewSummary(employees:PayrollOverviewEmployee[],directorInsuranceAmount:number){return calculatePayrollInsuranceTotals({preInsurancePayoutAmounts:employees.map(employee=>employee.amounts.preInsurancePayoutAmount),employeeDeductionAmounts:employees.map(employee=>employee.amounts.employeeInsuranceDeductionAmount),employerAmounts:employees.map(employee=>employee.amounts.employerInsuranceAmount),directorAmount:directorInsuranceAmount});}
