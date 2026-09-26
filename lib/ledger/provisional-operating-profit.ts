// Current-month provisional operating profit.
//
// Adds only costs that already happened this month but are not yet ledger
// expenses. No future sales, no fixed-cost guesses, no COGS.
//
// Payroll: the ledger books Payroll company cost once, as the
// `payroll_completed_batch` expense_recognition, only when the payment batch
// is completed (amount = batch.actual_company_cost_total, meal excluded).
// Meal allowance is booked daily through attendance meal candidates, so it is
// removed from the Payroll total before comparing. `payroll_payment` rows have
// no recognition month and never reach operating profit.
//
// Card fees: a fee is booked (`card_settlement_difference`) only when a
// reconciliation is matched. Gross that is not yet matched (unallocated or
// partial) has no fee yet, so only that gross gets an estimate.

export type ProvisionalLedgerSummary = { income: number; expense: number; operatingProfit: number };

export type PayrollOverviewSource = {
  summary?: { totalCompanyCostAmount?: unknown; mealAllowanceAmount?: unknown } | null;
  paymentBatch?: { status?: unknown; actual_company_cost_total?: unknown } | null;
};

export type CardSettlementSource = {
  monthlyCardGross?: unknown;
  monthlySettledGross?: unknown;
  monthlySettlementDifference?: unknown;
  actualDifferenceRate?: unknown;
};

export type ProvisionalOperatingProfitInput = {
  isCurrentMonth: boolean;
  summary: ProvisionalLedgerSummary;
  // null means the source failed to load.
  payroll: PayrollOverviewSource | null;
  currentCard: CardSettlementSource | null;
  previousCard: CardSettlementSource | null;
};

export type CardFeeRateSource = "current" | "previous" | "unavailable";
export type ProvisionalWarning =
  | "PAYROLL_UNAVAILABLE"
  | "CARD_SETTLEMENTS_UNAVAILABLE"
  | "PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE"
  | "CARD_FEE_RATE_UNAVAILABLE";

// Guard against clearly broken observed rates; not a fee assumption.
export const MAX_PLAUSIBLE_CARD_FEE_RATE = 0.1;

const finite = (value: unknown) => {
  const number = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(number) ? number : null;
};

const plausibleRate = (rate: number | null) =>
  rate !== null && Number.isFinite(rate) && rate >= 0 && rate <= MAX_PLAUSIBLE_CARD_FEE_RATE ? rate : null;

export function currentCardFeeRate(card: CardSettlementSource) {
  const settledGross = finite(card.monthlySettledGross);
  const difference = finite(card.monthlySettlementDifference);
  if (settledGross === null || difference === null || settledGross <= 0) return null;
  return plausibleRate(difference / settledGross);
}

export function previousCardFeeRate(card: CardSettlementSource) {
  return plausibleRate(finite(card.actualDifferenceRate));
}

export function unrecognizedPayrollCost(payroll: PayrollOverviewSource) {
  const accruedTotal = finite(payroll.summary?.totalCompanyCostAmount);
  const mealAllowance = finite(payroll.summary?.mealAllowanceAmount);
  if (accruedTotal === null || mealAllowance === null) return null;
  const accruedExcludingMeal = accruedTotal - mealAllowance;
  const recognized = payroll.paymentBatch?.status === "completed"
    ? finite(payroll.paymentBatch.actual_company_cost_total) ?? 0
    : 0;
  return { accruedExcludingMeal, mealAllowance, recognized, adjustment: Math.max(0, accruedExcludingMeal - recognized) };
}

export function buildProvisionalOperatingProfit(input: ProvisionalOperatingProfitInput) {
  const { summary } = input;
  const base = {
    recognizedRevenue: summary.income,
    recognizedExpense: summary.expense,
    payrollAdjustment: 0,
    estimatedCardFee: 0,
    cardFeeRate: null as number | null,
    cardFeeRateSource: null as CardFeeRateSource | null,
    unsettledCardGross: 0,
  };
  if (!input.isCurrentMonth) {
    return { ...base, mode: "final" as const, needsCheck: false, provisionalExpense: summary.expense, operatingProfit: summary.operatingProfit as number | null, warnings: [] as ProvisionalWarning[] };
  }

  const warnings: ProvisionalWarning[] = [];
  const payroll = input.payroll ? unrecognizedPayrollCost(input.payroll) : null;
  if (!payroll) warnings.push("PAYROLL_UNAVAILABLE");

  const cardGross = input.currentCard ? finite(input.currentCard.monthlyCardGross) : null;
  const settledGross = input.currentCard ? finite(input.currentCard.monthlySettledGross) : null;
  const cardAvailable = cardGross !== null && settledGross !== null;
  if (!cardAvailable) warnings.push("CARD_SETTLEMENTS_UNAVAILABLE");
  const unsettledCardGross = cardAvailable ? Math.max(0, cardGross - settledGross) : 0;

  let cardFeeRate: number | null = null;
  let cardFeeRateSource: CardFeeRateSource | null = null;
  let cardFeeResolved = cardAvailable;
  if (cardAvailable) {
    cardFeeRate = currentCardFeeRate(input.currentCard!);
    cardFeeRateSource = cardFeeRate === null ? null : "current";
    if (cardFeeRate === null && unsettledCardGross > 0) {
      if (!input.previousCard) {
        warnings.push("PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE");
        cardFeeResolved = false;
      } else {
        cardFeeRate = previousCardFeeRate(input.previousCard);
        cardFeeRateSource = cardFeeRate === null ? "unavailable" : "previous";
        if (cardFeeRate === null) warnings.push("CARD_FEE_RATE_UNAVAILABLE");
      }
    }
  }
  const estimatedCardFee = cardFeeRate === null ? 0 : Math.round(unsettledCardGross * cardFeeRate);

  const needsCheck = !payroll || !cardFeeResolved;
  const payrollAdjustment = payroll?.adjustment ?? 0;
  const provisionalExpense = summary.expense + payrollAdjustment + estimatedCardFee;
  return {
    ...base,
    mode: "provisional" as const,
    needsCheck,
    payrollAdjustment,
    estimatedCardFee,
    cardFeeRate,
    cardFeeRateSource,
    unsettledCardGross,
    // Never show an operating profit that silently treats a missing cost as 0.
    provisionalExpense: needsCheck ? null : provisionalExpense,
    operatingProfit: needsCheck ? null : summary.income - provisionalExpense,
    warnings,
  };
}

export type ProvisionalOperatingProfit = ReturnType<typeof buildProvisionalOperatingProfit>;
