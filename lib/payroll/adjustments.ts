export type PayrollAdjustmentKind = "incentive" | "penalty" | "advance";

export type PayrollAdjustmentAmount = {
  kind: PayrollAdjustmentKind;
  amount: number;
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

export function calculatePayrollPayoutAmounts(input: {
  automaticPreInsuranceAmount: number;
  manualIncentiveAmount: number;
  manualPenaltyAmount: number;
  employeeInsuranceDeductionAmount: number;
  advanceAmount: number;
}) {
  const preInsurancePayoutAmount =
    input.automaticPreInsuranceAmount
    + input.manualIncentiveAmount
    - input.manualPenaltyAmount;
  const netPayoutAmount =
    preInsurancePayoutAmount
    - input.employeeInsuranceDeductionAmount
    - input.advanceAmount;

  return { preInsurancePayoutAmount, netPayoutAmount };
}
