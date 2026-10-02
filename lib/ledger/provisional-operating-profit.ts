// Provisional operating profit.
//
// Adds only costs that already happened but are not yet ledger expenses. No future
// sales, no fixed-cost guesses, no COGS.
//
// Payroll (any month): the ledger books Payroll company cost once, as the
// `payroll_completed_batch` expense_recognition, when the payment batch completes
// (around the 10th of the next month, often after the month is closed). Until then
// the month carries the predicted cost from the Payroll engine (see
// lib/ledger/payroll-cost.ts — meal allowance excluded, advances never reduce it).
// Only `payroll.adjustment` (cost − already recognized) is added, so predicted and
// finalized are never both counted. `payroll_payment` rows have no recognition
// month and never reach operating profit.
//
// Card fees: a fee is booked (`card_settlement_difference`) only when a
// reconciliation is matched. Gross that is not yet matched (unallocated or
// partial) has no fee yet, so only that gross gets an estimate.

import type { LedgerPayrollCost } from "./payroll-cost";

export type ProvisionalLedgerSummary = { cardFeePending?: boolean; income: number; expense: number; operatingProfit: number };

export type CardSettlementSource = {
  monthlyCardGross?: unknown;
  monthlySettledGross?: unknown;
  monthlySettlementDifference?: unknown;
  actualDifferenceRate?: unknown;
};

export type ProvisionalOperatingProfitInput = {
  isCurrentMonth: boolean;
  summary: ProvisionalLedgerSummary;
  // Month payroll cost (finalized / predicted / not_tracked / unavailable).
  // null: not supplied — needs-check for the current month, ignored for past months.
  payroll: LedgerPayrollCost | null;
  // The payroll cost request is still in flight.
  payrollLoading?: boolean;
  currentCard: CardSettlementSource | null;
  previousCard: CardSettlementSource | null;
};

export type CardFeeRateSource = "current" | "previous" | "unavailable";
export type ProvisionalWarning =
  | "PAYROLL_UNAVAILABLE"
  | "PAYROLL_LOADING"
  | "CARD_SETTLEMENTS_UNAVAILABLE"
  | "PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE"
  | "CARD_FEE_RATE_UNAVAILABLE"
  | "CARD_FEE_PENDING";

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

export type PayrollDisplay = { status: LedgerPayrollCost["status"] | "loading"; amount: number | null };

// The payroll part of P&L: how much to add and how to label it.
function payrollPart(input: ProvisionalOperatingProfitInput) {
  if (input.payrollLoading) return { display: { status: "loading" as const, amount: null }, adjustment: null as number | null, pending: true };
  const payroll = input.payroll;
  if (!payroll) return { display: null, adjustment: input.isCurrentMonth ? null : 0, pending: input.isCurrentMonth };
  const adjustment = payroll.status === "unavailable" ? null : finite(payroll.adjustment) ?? 0;
  // A finalized month normally has adjustment 0 (its recognition is already ledger expense).
  const pending = payroll.status === "predicted" || payroll.status === "unavailable" || (adjustment ?? 0) > 0;
  return { display: { status: payroll.status, amount: payroll.amount }, adjustment, pending };
}

export function buildProvisionalOperatingProfit(input: ProvisionalOperatingProfitInput) {
  const { summary } = input;
  const base = {
    payroll: null as PayrollDisplay | null,
    recognizedRevenue: summary.income,
    recognizedExpense: summary.expense,
    payrollAdjustment: 0,
    estimatedCardFee: 0,
    cardFeeRate: null as number | null,
    cardFeeRateSource: null as CardFeeRateSource | null,
    unsettledCardGross: 0,
  };
  const payroll = payrollPart(input);
  const payrollWarnings: ProvisionalWarning[] = payroll.adjustment === null ? [input.payrollLoading ? "PAYROLL_LOADING" : "PAYROLL_UNAVAILABLE"] : [];
  if (!input.isCurrentMonth) {
    const warnings = [...payrollWarnings, ...(summary.cardFeePending ? ["CARD_FEE_PENDING" as const] : [])];
    if (!payroll.pending) {
      return { ...base, payroll: payroll.display, mode: summary.cardFeePending ? "provisional" as const : "final" as const, needsCheck: false, provisionalExpense: summary.expense, operatingProfit: summary.operatingProfit as number | null, warnings };
    }
    // A past month whose payroll is not finalized yet: ledger + predicted payroll.
    const needsCheck = payroll.adjustment === null;
    const payrollAdjustment = payroll.adjustment ?? 0;
    const provisionalExpense = summary.expense + payrollAdjustment;
    return {
      ...base, payroll: payroll.display, mode: "provisional" as const, needsCheck, payrollAdjustment,
      provisionalExpense: needsCheck ? null : provisionalExpense,
      operatingProfit: needsCheck ? null : summary.income - provisionalExpense,
      warnings,
    };
  }

  const warnings: ProvisionalWarning[] = [...payrollWarnings];

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

  const needsCheck = payroll.adjustment === null || !cardFeeResolved;
  const payrollAdjustment = payroll.adjustment ?? 0;
  const provisionalExpense = summary.expense + payrollAdjustment + estimatedCardFee;
  return {
    ...base,
    payroll: payroll.display,
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
