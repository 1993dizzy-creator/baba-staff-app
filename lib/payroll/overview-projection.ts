import { calculatePayrollInsuranceTotals } from "./insurance";
import { getPayrollHeaderAmount } from "./payroll-page-display";
import type { PayrollOverviewEmployee } from "./overview";
import { calculateAccountingTaxableCompensationAmount, calculateEmployeePit } from "./tax";

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
    if (contractMonthlyAmount === null || employee.tax.status === "requires_review") return [];
    const preInsurancePayoutAmount = Math.max(0,
        contractMonthlyAmount
        + employee.amounts.incentiveAmount
        + employee.amounts.overtimeAmount
        + employee.amounts.otherAdditionAmount
        - employee.amounts.automaticPenaltyAmount
        - employee.amounts.manualPenaltyAmount
        - employee.amounts.otherDeductionAmount,
      );
    const taxableCompensationAmount = calculateAccountingTaxableCompensationAmount({
      preInsurancePayoutAmount,
      taxExemptCompensationAmount: employee.amounts.taxExemptCompensationAmount,
      companyPaidInsuranceTaxableAmount: employee.amounts.companyPaidInsuranceTaxableAmount,
    });
    const tax = calculateEmployeePit({
      taxableCompensationAmount,
      employeeInsuranceDeductionAmount: employee.amounts.employeeInsuranceDeductionAmount,
      policy: employee.tax.policySnapshot,
      profile: employee.tax.profileSnapshot,
    });
    return [{
      preInsurancePayoutAmount,
      employeeInsuranceDeductionAmount: employee.amounts.employeeInsuranceDeductionAmount,
      employeePitDeductionAmount: tax.employeePitDeductionAmount,
      companyPitAmount: tax.companyPitAmount,
      advanceAmount: employee.amounts.advanceAmount,
      employerInsuranceAmount: employee.amounts.employerInsuranceAmount,
    }];
  });
  if (included.length === 0) return null;
  const totals = calculatePayrollInsuranceTotals({
    preInsurancePayoutAmounts: included.map((item) => item.preInsurancePayoutAmount),
    employeeDeductionAmounts: included.map((item) => item.employeeInsuranceDeductionAmount),
    employeePitDeductionAmounts: included.map((item) => item.employeePitDeductionAmount),
    companyPitAmounts: included.map((item) => item.companyPitAmount),
    advanceAmounts: included.map((item) => item.advanceAmount),
    employerAmounts: included.map((item) => item.employerInsuranceAmount),
    directorAmount: directorInsuranceAmount,
  });
  const unavailableEmployeeCount = employees.length - included.length;
  return { ...totals, includedEmployeeCount: included.length, unavailableEmployeeCount, partial: unavailableEmployeeCount > 0 };
}
