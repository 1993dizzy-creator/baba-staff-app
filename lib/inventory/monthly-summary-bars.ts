export type MonthlySummaryDeductionAmounts = {
  sale: number;
  check: number;
  service: number;
  other: number;
};

export type MonthlySummaryBarMetrics = {
  purchaseBarWidth: number;
  purchaseShare: number;
  deductionRate: number;
  deductionVisualWidth: number;
  deductionSegmentWidths: MonthlySummaryDeductionAmounts;
};

const safeNonNegative = (value: unknown) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : 0;
};

export const getMonthlySummaryDeductionAmount = (
  deductions: MonthlySummaryDeductionAmounts
) => Object.values(deductions).reduce(
  (sum, amount) => sum + safeNonNegative(amount),
  0
);

/**
 * Shared visual contract for supplier and part summary cards. Purchase and
 * deduction bars use the same absolute amount scale, while purchase share and
 * deduction rate remain independent informational percentages.
 */
export function getMonthlySummaryBarMetrics({
  purchaseAmount,
  totalPurchaseAmount,
  scaleMax,
  deductions,
}: {
  purchaseAmount: number;
  totalPurchaseAmount: number;
  scaleMax: number;
  deductions: MonthlySummaryDeductionAmounts;
}): MonthlySummaryBarMetrics {
  const safePurchaseAmount = safeNonNegative(purchaseAmount);
  const safeTotalPurchaseAmount = safeNonNegative(totalPurchaseAmount);
  const safeDeductions: MonthlySummaryDeductionAmounts = {
    sale: safeNonNegative(deductions.sale),
    check: safeNonNegative(deductions.check),
    service: safeNonNegative(deductions.service),
    other: safeNonNegative(deductions.other),
  };
  const safeScaleMax = safeNonNegative(scaleMax);
  const totalDeductionAmount = getMonthlySummaryDeductionAmount(safeDeductions);
  const purchaseShare = safeTotalPurchaseAmount > 0
    ? (safePurchaseAmount / safeTotalPurchaseAmount) * 100
    : 0;
  const deductionRate = safePurchaseAmount > 0
    ? (totalDeductionAmount / safePurchaseAmount) * 100
    : 0;
  const amountWidth = (amount: number) => safeScaleMax > 0
    ? Math.min((amount / safeScaleMax) * 100, 100)
    : 0;

  return {
    purchaseBarWidth: amountWidth(safePurchaseAmount),
    purchaseShare,
    deductionRate,
    deductionVisualWidth: amountWidth(totalDeductionAmount),
    deductionSegmentWidths: {
      sale: amountWidth(safeDeductions.sale),
      check: amountWidth(safeDeductions.check),
      service: amountWidth(safeDeductions.service),
      other: amountWidth(safeDeductions.other),
    },
  };
}
