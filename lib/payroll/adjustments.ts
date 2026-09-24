export type PayrollAdjustmentKind = "incentive" | "penalty" | "advance";

export type PayrollAdjustmentAmount = {
  kind: PayrollAdjustmentKind;
  amount: number;
  sourceType?: string;
};

export function calculateManualAdjustmentTotals(
  adjustments: readonly PayrollAdjustmentAmount[],
) {
  let manualIncentiveAmount = 0;
  let manualPenaltyAmount = 0;
  let advanceAmount = 0;
  let incentiveCount = 0;
  let penaltyCount = 0;
  let advanceCount = 0;

  for (const adjustment of adjustments) {
    /*
     * payroll_monthly_adjustments originally contained manual rows only, so
     * every incentive was historically counted as manual here. BABA's Quyen
     * C5/J7/J8 3% agreement is persisted in the same ledger for auditability,
     * but source_type=sales_menu_incentive is an automatic POS-derived row.
     * Keep this source boundary explicit: it must contribute to total salary
     * elsewhere, while never appearing as a manual incentive/cancellation.
     * If automatic policies multiply, replace this narrow classification with
     * a general typed source registry rather than adding UI-configured policy
     * behavior to this helper.
     */
    if (adjustment.sourceType && adjustment.sourceType !== "manual") continue;
    if (adjustment.kind === "incentive") {
      manualIncentiveAmount += adjustment.amount;
      incentiveCount++;
    } else if (adjustment.kind === "penalty") {
      manualPenaltyAmount += adjustment.amount;
      penaltyCount++;
    } else {
      advanceAmount += adjustment.amount;
      advanceCount++;
    }
  }

  return {
    manualIncentiveAmount,
    manualPenaltyAmount,
    advanceAmount,
    incentiveCount,
    penaltyCount,
    advanceCount,
  };
}

export function calculateSalesMenuIncentiveTotals(
  adjustments: readonly PayrollAdjustmentAmount[],
) {
  const rows = adjustments.filter(
    (adjustment) =>
      adjustment.sourceType === "sales_menu_incentive"
      && adjustment.kind === "incentive",
  );
  return {
    salesMenuIncentiveAmount: rows.reduce((total, row) => total + row.amount, 0),
    salesMenuIncentiveCount: rows.length,
  };
}

export function calculatePayrollPayoutAmounts(input: {
  automaticPreInsuranceAmount: number;
  manualIncentiveAmount: number;
  manualPenaltyAmount: number;
  employeeInsuranceDeductionAmount: number;
  employeePitDeductionAmount?: number;
  advanceAmount: number;
}) {
  const preInsurancePayoutAmount =
    input.automaticPreInsuranceAmount
    + input.manualIncentiveAmount
    - input.manualPenaltyAmount;
  const netPayoutAmount =
    preInsurancePayoutAmount
    - input.employeeInsuranceDeductionAmount
    - (input.employeePitDeductionAmount ?? 0)
    - input.advanceAmount;

  return { preInsurancePayoutAmount, netPayoutAmount };
}
