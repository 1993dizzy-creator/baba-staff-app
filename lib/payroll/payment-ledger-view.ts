// /admin/payroll/[runId] 지급장부 표시 전용. 기존 runs/[runId] 응답만 읽으며 급여를 재계산하거나
// 지급 데이터를 바꾸지 않는다. 차액은 저장된 difference_amount(실제 지급액 − 계산 실수령액)를 그대로 쓴다.

import { getPayrollApplicabilityBadges } from "./payroll-dashboard.ts";

export type PaymentLedgerFilter = "all" | "paid" | "unpaid" | "difference";
export const PAYMENT_LEDGER_FILTERS: readonly PaymentLedgerFilter[] = ["all", "paid", "unpaid", "difference"];

export type PaymentLedgerEmployee = {
  employee_name: string;
  payment_status: "unpaid" | "paid";
  calculated_net_amount: number | null;
  actual_paid_amount: number | null;
  difference_amount: number | null;
  difference_reason: string | null;
};

function storedNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 차액발생 = 지급완료이면서 저장된 차액이 0이 아닌 기록. 미지급은 포함하지 않는다. */
export function hasStoredPaymentDifference(employee: PaymentLedgerEmployee) {
  if (employee.payment_status !== "paid") return false;
  const difference = storedNumber(employee.difference_amount);
  return difference !== null && difference !== 0;
}

export function matchesPaymentLedgerFilter(employee: PaymentLedgerEmployee, filter: PaymentLedgerFilter) {
  if (filter === "paid") return employee.payment_status === "paid";
  if (filter === "unpaid") return employee.payment_status !== "paid";
  if (filter === "difference") return hasStoredPaymentDifference(employee);
  return true;
}

export function matchesPaymentLedgerQuery(employee: PaymentLedgerEmployee, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || employee.employee_name.toLocaleLowerCase().includes(needle);
}

export function countPaymentLedgerFilters(employees: readonly PaymentLedgerEmployee[]) {
  return Object.fromEntries(PAYMENT_LEDGER_FILTERS.map((filter) => [filter, employees.filter((employee) => matchesPaymentLedgerFilter(employee, filter)).length])) as Record<PaymentLedgerFilter, number>;
}

export type DifferenceReviewRow<E extends PaymentLedgerEmployee> = {
  employee: E;
  calculatedAmount: number | null;
  actualAmount: number | null;
  differenceAmount: number;
  /** null = 사유 미기록(과거 데이터) */
  reason: string | null;
};

/** 차액 검토 대상(저장된 차액 ≠ 0인 지급완료 기록). 합계는 배치에 저장된 difference_total을 따로 쓴다. */
export function buildDifferenceReview<E extends PaymentLedgerEmployee>(employees: readonly E[]): DifferenceReviewRow<E>[] {
  return employees.filter(hasStoredPaymentDifference).map((employee) => ({
    employee,
    calculatedAmount: storedNumber(employee.calculated_net_amount),
    actualAmount: storedNumber(employee.actual_paid_amount),
    differenceAmount: storedNumber(employee.difference_amount) as number,
    reason: employee.difference_reason?.trim() ? employee.difference_reason.trim() : null,
  }));
}

// 지급 당시 계산 스냅샷 요약: 구조가 확인되는 숫자 항목만 꺼낸다. 형식이 다르거나 값이 없으면
// 그 항목은 생략하고(추측 금지), 원본 JSON은 화면에서 그대로 보존한다.
export type SnapshotSummaryKey =
  | "payType" | "combinedSalary" | "recognizedWorkdays" | "recognizedMinutes" | "workAppliedAmount"
  | "incentiveAmount" | "penaltyAmount" | "preInsurancePayoutAmount" | "employeeInsuranceDeductionAmount"
  | "employeePitDeductionAmount" | "advanceAmount" | "netPayoutAmount";
export type SnapshotSummaryItem = { key: SnapshotSummaryKey; value: number | string };

const AMOUNT_KEYS = ["combinedSalary", "workAppliedAmount", "incentiveAmount", "penaltyAmount", "preInsurancePayoutAmount", "employeeInsuranceDeductionAmount", "employeePitDeductionAmount", "advanceAmount", "netPayoutAmount"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function summarizePaymentSnapshot(snapshot: unknown): SnapshotSummaryItem[] {
  if (!isRecord(snapshot) || !isRecord(snapshot.employee)) return [];
  const employee = snapshot.employee;
  const items: SnapshotSummaryItem[] = [];
  if (isRecord(employee.contract) && typeof employee.contract.payType === "string") items.push({ key: "payType", value: employee.contract.payType });
  const amounts = isRecord(employee.amounts) ? employee.amounts : null;
  if (amounts && isSafeNumber(amounts.combinedSalary)) items.push({ key: "combinedSalary", value: amounts.combinedSalary });
  if (isSafeNumber(employee.recognizedWorkdays)) items.push({ key: "recognizedWorkdays", value: employee.recognizedWorkdays });
  if (isSafeNumber(employee.recognizedMinutes)) items.push({ key: "recognizedMinutes", value: employee.recognizedMinutes });
  if (amounts) for (const key of AMOUNT_KEYS) if (key !== "combinedSalary" && isSafeNumber(amounts[key])) items.push({ key, value: amounts[key] as number });
  return items;
}

export type PaymentApplicabilityBadge = { key: string; label: string; description: string };

// 지급장부 직원 상태 배지(💯 개근 · 🍚 식대 · 🛡️ 보험 · TNCN).
// 급여관리 카드와 같은 공통 규칙(getPayrollApplicabilityBadges)을 쓰되, 판단 근거는 지급 당시 calculation_snapshot만 쓴다.
// 현재 직원 설정은 절대 쓰지 않으며, 스냅샷으로 확인할 수 없는 항목은 배지를 표시하지 않는다.
// - 개근: 스냅샷의 자동 인센티브 중 해당 급여월 attendance_bonus가 실제 반영된 경우만(지급 월은 종료 월로 취급).
// - 보험: employee.insuranceEnrolled(boolean)가 있으면 그 값. 없으면 지급 당시 확정 보험 금액(직원 공제·회사 부담)이 0보다 클 때만.
// - TNCN: employee.tax의 taxMode/status가 있으면 공통 규칙. 없으면 확정 TNCN 금액(직원 공제·회사 부담)이 0보다 클 때만
//   (세금 모드는 not_applicable/resident_progressive 두 가지뿐이라 양수 세액은 resident_progressive 적용 결과다).
// - 식대: 기존 급여월 기준 eligibility 조회 결과(mealAllowanceEligible)를 그대로 쓴다.
export function getPaymentApplicabilityBadges(input: { snapshot: unknown; month: string; mealAllowanceEligible: boolean; lang: "ko" | "vi" }): PaymentApplicabilityBadge[] {
  const snapshot = isRecord(input.snapshot) ? input.snapshot : null;
  const employee = snapshot && isRecord(snapshot.employee) ? snapshot.employee : null;
  const amounts = employee && isRecord(employee.amounts) ? employee.amounts : null;
  const tax = employee && isRecord(employee.tax) ? employee.tax : null;
  const positive = (value: unknown) => isSafeNumber(value) && value > 0;

  const insuranceEnrolled = typeof employee?.insuranceEnrolled === "boolean"
    ? employee.insuranceEnrolled
    : positive(amounts?.employeeInsuranceDeductionAmount) || positive(amounts?.employerInsuranceAmount) ? true : undefined;

  const taxConfirmed = tax && typeof tax.taxMode === "string" && typeof tax.status === "string"
    ? { taxMode: tax.taxMode, status: tax.status }
    : positive(tax?.employeePitDeductionAmount) || positive(tax?.companyPitAmount) ? { taxMode: "resident_progressive", status: "calculated" } : null;

  const incentivesSource = Array.isArray(employee?.automaticIncentives) ? employee.automaticIncentives : Array.isArray(snapshot?.automaticIncentivesSnapshot) ? snapshot.automaticIncentivesSnapshot : [];
  const automaticIncentives = incentivesSource
    .filter(isRecord)
    .filter(item => typeof item.category === "string" && isRecord(item.sourceSnapshot))
    .map(item => ({ category: item.category as string, sourceSnapshot: item.sourceSnapshot as Record<string, unknown> }));

  return getPayrollApplicabilityBadges({
    employee: { insuranceEnrolled, tax: taxConfirmed, attendanceStanding: null, automaticIncentives },
    month: input.month,
    monthClosed: true,
    attendanceBonusEligible: false,
    mealAllowanceEligible: input.mealAllowanceEligible,
    lang: input.lang,
  });
}
