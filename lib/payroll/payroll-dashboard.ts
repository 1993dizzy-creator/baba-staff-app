// Presentation-only projections for /admin/payroll. They read the overview
// payload as-is and never recalculate payroll, payment, or ledger amounts.

export type PayrollDashboardFilter = "all" | "review" | "unpaid" | "paid";

export const PAYROLL_DASHBOARD_FILTERS: readonly PayrollDashboardFilter[] = ["all", "review", "unpaid", "paid"];

type DashboardEmployee = {
  userId: number;
  name: string;
  contract: unknown | null;
  calculationStatus: "calculable" | "requires_review" | "unavailable";
  amounts: {
    combinedSalary: number | null;
    contractMonthlyEquivalent: number | null;
    currentAmount: number | null;
    netPayoutAmount: number;
  };
  payment?: { payment_status: "unpaid" | "paid"; actual_paid_amount: number | null } | null;
};

export const isPayrollEmployeePaid = (employee: DashboardEmployee) =>
  employee.payment?.payment_status === "paid";

export const isPayrollEmployeeReviewRequired = (employee: DashboardEmployee) =>
  employee.calculationStatus !== "calculable";

// The calculated net payout is shown only for a calculable employee in a
// started month; otherwise the card shows a "needs review" state instead.
export function getPayrollCalculatedNetAmount(employee: DashboardEmployee, future = false) {
  if (future || employee.calculationStatus !== "calculable" || employee.amounts.currentAmount === null) return null;
  return employee.amounts.netPayoutAmount;
}

export function getPayrollActualPaidAmount(employee: DashboardEmployee) {
  return isPayrollEmployeePaid(employee) ? employee.payment?.actual_paid_amount ?? null : null;
}

// Read the selected month's overview only. These badges describe applicability,
// never a new calculation or a promise of a bonus/payment.
export function getPayrollApplicabilityBadges(input: {
  employee: {
    insuranceEnrolled?: boolean;
    tax?: { status: string; taxMode: string | null } | null;
    attendanceStanding?: { perfectAttendanceCurrent: boolean } | null;
    automaticIncentives?: readonly { category: string; sourceSnapshot: Record<string, unknown> }[];
  };
  month: string;
  monthClosed: boolean;
  attendanceBonusEligible: boolean;
  mealAllowanceEligible: boolean;
  lang: "ko" | "vi";
}) {
  const { employee, month, monthClosed, lang } = input;
  const vi = lang === "vi";
  const badges: { key: string; label: string; description: string }[] = [];
  const attendanceApplied = employee.automaticIncentives?.some(item =>
    item.category === "attendance_bonus" && item.sourceSnapshot.payrollMonth === month,
  ) === true;
  // Preserve the existing eligibility + perfect-attendance indicator for an
  // open month. For a closed month, only the actual automatic bonus is applied.
  const attendanceMaintained = !monthClosed && input.attendanceBonusEligible
    && employee.attendanceStanding?.perfectAttendanceCurrent === true;
  if (attendanceApplied || attendanceMaintained) badges.push({
    key: "attendance", label: vi ? "Chuyên cần" : "개근",
    description: attendanceApplied
      ? (vi ? "Đã áp dụng thưởng chuyên cần" : "개근 보너스 반영")
      : (vi ? "Đủ tư cách thưởng chuyên cần · đang duy trì chấm công, chưa xác nhận chi trả" : "개근 보너스 대상 · 현재 근태 유지 중, 지급 미확정"),
  });
  if (input.mealAllowanceEligible) badges.push({ key: "meal", label: vi ? "Ăn ca" : "식대", description: vi ? "Đối tượng trợ cấp ăn" : "식대 대상" });
  if (employee.insuranceEnrolled === true) badges.push({ key: "insurance", label: vi ? "Bảo hiểm" : "보험", description: vi ? "Đã tham gia bảo hiểm" : "보험 가입 대상" });
  // Zero tax is still applicable. A missing/reviewing profile or policy is not
  // a confirmed applicable state, even when its mode is resident_progressive.
  if (employee.tax?.taxMode === "resident_progressive" && employee.tax.status === "calculated") {
    badges.push({ key: "tax", label: "TNCN", description: vi ? "Đối tượng tính thuế TNCN" : "TNCN 적용 대상" });
  }
  return badges.map(badge => ({ ...badge, description: `${month} · ${badge.description}` }));
}

export function buildPayrollDashboardSummary(employees: readonly DashboardEmployee[]) {
  const paid = employees.filter(isPayrollEmployeePaid).length;
  const review = employees.filter(isPayrollEmployeeReviewRequired).length;
  return {
    target: employees.length,
    calculable: employees.length - review,
    review,
    paid,
    unpaid: employees.length - paid,
  };
}

export function matchesPayrollDashboardFilter(employee: DashboardEmployee, filter: PayrollDashboardFilter) {
  if (filter === "review") return isPayrollEmployeeReviewRequired(employee);
  if (filter === "unpaid") return !isPayrollEmployeePaid(employee);
  if (filter === "paid") return isPayrollEmployeePaid(employee);
  return true;
}

export function countPayrollDashboardFilters(employees: readonly DashboardEmployee[]) {
  return Object.fromEntries(
    PAYROLL_DASHBOARD_FILTERS.map((filter) => [filter, employees.filter((employee) => matchesPayrollDashboardFilter(employee, filter)).length]),
  ) as Record<PayrollDashboardFilter, number>;
}

// Department totals use one unit per row: monthly-equivalent contract pay
// (hourly rates are never added to monthly salaries) and calculated net pay.
// Employees whose amount cannot be resolved are listed instead of summed.
// `contractMonthlyAmount` is the card header resolver (getPayrollHeaderAmount)
// so the department total and each card headline always share one source.
export function buildPayrollPartTotals<T extends DashboardEmployee>(
  employees: readonly T[],
  contractMonthlyAmount: (employee: T, future: boolean) => number | null,
  future = false,
) {
  let contractMonthlyTotal = 0;
  let netTotal = 0;
  let paidTotal = 0;
  let paidCount = 0;
  const contractExcluded: string[] = [];
  const netExcluded: string[] = [];
  for (const employee of employees) {
    const contractAmount = contractMonthlyAmount(employee, future);
    if (contractAmount === null) contractExcluded.push(employee.name);
    else contractMonthlyTotal += contractAmount;
    const netAmount = getPayrollCalculatedNetAmount(employee, future);
    if (netAmount === null) netExcluded.push(employee.name);
    else netTotal += netAmount;
    const paidAmount = getPayrollActualPaidAmount(employee);
    if (paidAmount !== null) {
      paidTotal += paidAmount;
      paidCount += 1;
    }
  }
  return { contractMonthlyTotal, contractExcluded, netTotal, netExcluded, paidTotal, paidCount };
}
