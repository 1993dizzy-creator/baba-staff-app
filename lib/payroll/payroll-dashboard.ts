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
