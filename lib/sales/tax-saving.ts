export type SalesReceiptTaxOverrideMode = "apply" | "exclude_all" | null;

export function calculateModifiedReceiptTaxSaving(params: {
  taxOverrideMode: SalesReceiptTaxOverrideMode;
  originalTaxAmount: number;
  adjustedTaxAmount: number;
  appliedTaxAmount: number;
}) {
  const { taxOverrideMode, originalTaxAmount, adjustedTaxAmount, appliedTaxAmount } = params;

  if (taxOverrideMode === "exclude_all") {
    return Math.max(0, originalTaxAmount - appliedTaxAmount);
  }

  return Math.max(0, adjustedTaxAmount - originalTaxAmount);
}
