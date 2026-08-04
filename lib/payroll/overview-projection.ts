import { calculatePayrollInsuranceTotals } from "./insurance";
import { getPayrollHeaderAmount } from "./payroll-page-display";
import type { PayrollOverviewEmployee } from "./overview";

export type PayrollOverviewProjectedSummary = ReturnType<typeof calculatePayrollInsuranceTotals> & {
  includedEmployeeCount: number;
  unavailableEmployeeCount: number;
  partial: boolean;
};

export function buildPayrollOverviewProjectedSummary(
  employees: readonly PayrollOverviewEmployee[],
  directorInsuranceAmount: number,
): PayrollOverviewProjectedSummary | null {
  const included = employees.flatMap((employee) => {
    const contractMonthlyAmount = getPayrollHeaderAmount(employee);
    if (contractMonthlyAmount === null) return [];
    return [{
      preInsurancePayoutAmount: Math.max(0,
        contractMonthlyAmount
        + employee.amounts.incentiveAmount
        + employee.amounts.overtimeAmount
        + employee.amounts.otherAdditionAmount
        - employee.amounts.automaticPenaltyAmount
        - employee.amounts.manualPenaltyAmount
        - employee.amounts.otherDeductionAmount,
      ),
      employeeInsuranceDeductionAmount: employee.amounts.employeeInsuranceDeductionAmount,
      employerInsuranceAmount: employee.amounts.employerInsuranceAmount,
    }];
  });
  if (included.length === 0) return null;
  const totals = calculatePayrollInsuranceTotals({
    preInsurancePayoutAmounts: included.map((item) => item.preInsurancePayoutAmount),
    employeeDeductionAmounts: included.map((item) => item.employeeInsuranceDeductionAmount),
    employerAmounts: included.map((item) => item.employerInsuranceAmount),
    directorAmount: directorInsuranceAmount,
  });
  const unavailableEmployeeCount = employees.length - included.length;
  return { ...totals, includedEmployeeCount: included.length, unavailableEmployeeCount, partial: unavailableEmployeeCount > 0 };
}
