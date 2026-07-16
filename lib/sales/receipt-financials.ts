export type SalesReceiptTaxMode = "apply" | "exclude_all";
export const MAX_VND_RECEIPT_AMOUNT = 999_999_999_999;

export type SalesReceiptFinancialLine = {
  finalAmount: number;
  taxRate: number | null;
};

export function calculateReceiptFinancials(params: {
  lines: SalesReceiptFinancialLine[];
  taxMode: SalesReceiptTaxMode;
  originalTaxAmount: number;
  finalAmountOverride?: number | null;
}) {
  const totalAmount = params.lines.reduce(
    (sum, line) => sum + Math.round(line.finalAmount),
    0
  );
  const calculatedVatAmount =
    params.taxMode === "exclude_all"
      ? 0
      : params.lines.reduce((sum, line) => {
          const rate = Number(line.taxRate ?? 0);
          return sum + (rate > 0 ? Math.round((line.finalAmount * rate) / 100) : 0);
        }, 0);
  const calculatedFinalAmount = totalAmount + calculatedVatAmount;
  const requestedOverride = params.finalAmountOverride;
  const finalAmountOverride =
    requestedOverride === null || requestedOverride === undefined
      ? null
      : Math.round(requestedOverride) === calculatedFinalAmount
        ? null
        : Math.round(requestedOverride);
  const finalAmount = finalAmountOverride ?? calculatedFinalAmount;
  const appliedVatAmount =
    params.taxMode === "exclude_all" ? 0 : Math.round(params.originalTaxAmount);

  return {
    totalAmount,
    calculatedVatAmount,
    calculatedFinalAmount,
    finalAmountOverride,
    finalAmount,
    appliedVatAmount,
    manualAdjustmentAmount: finalAmount - calculatedFinalAmount,
  };
}

export function parseVndInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    number > MAX_VND_RECEIPT_AMOUNT
  ) return undefined;
  return number;
}
