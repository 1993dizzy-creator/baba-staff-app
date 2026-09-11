import type { CalculationBasis, PayType } from "./types";

export function calculateHolidayWorkPremiumAmount(input: {
  payType: PayType;
  calculationBasis: CalculationBasis;
  baseWorkAmount: number;
  effectiveMultiplier: number | null;
}) {
  if (!Number.isSafeInteger(input.baseWorkAmount) || input.baseWorkAmount < 0) {
    throw new RangeError("INVALID_HOLIDAY_PREMIUM_BASE_AMOUNT");
  }
  if (input.calculationBasis === "fixed_monthly" || input.effectiveMultiplier === null) return 0;
  if (!Number.isFinite(input.effectiveMultiplier) || input.effectiveMultiplier <= 1) return 0;
  const amount = Math.round(input.baseWorkAmount * (input.effectiveMultiplier - 1));
  if (!Number.isSafeInteger(amount)) throw new RangeError("HOLIDAY_PREMIUM_AMOUNT_OVERFLOW");
  return amount;
}
