// Payroll company cost for a ledger month's P&L (display layer only).
//
// finalized: the month's payroll batch is completed → its actual_company_cost_total,
//            booked as the payroll_completed_batch expense_recognition.
// predicted: no completed batch yet → the Payroll engine's current company cost
//            (loadPayrollOverview().summary.totalCompanyCostAmount: pre-insurance
//            payout + employer/director insurance + company PIT; meal allowance is
//            not part of it and advances never reduce it). Never a ledger row.
// not_tracked: the month is before payroll batches started.
// unavailable: the estimate could not be calculated — never treated as 0.
//
// The P&L adds only `adjustment` on top of what the ledger already recognized, so
// predicted and finalized can never both be counted.

export type PayrollCostStatus = "finalized" | "predicted" | "not_tracked" | "unavailable";

export type LedgerPayrollCost = {
  month: string;
  status: PayrollCostStatus;
  // Payroll cost the month's P&L should carry (null when unavailable).
  amount: number | null;
  // Already in ledger expense: confirmed payroll_completed_batch recognitions.
  recognizedAmount: number;
  // Extra expense to add on top of the ledger (null when unavailable).
  adjustment: number | null;
  batchStatus: string | null;
  reviewCount?: number;
  reason?: "PAYROLL_ESTIMATE_FAILED" | "PAYROLL_CALCULATION_UNAVAILABLE";
};

export type PayrollBatchSource = { status: string | null; actualCompanyCostTotal: number | string | null } | null;
export type PayrollEstimateSource =
  | { ok: true; companyCost: number; unavailableCount: number; reviewCount: number }
  | { ok: false };

const finiteNumber = (value: unknown) => {
  const number = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(number) ? number : null;
};

// Payroll months start at the first batch (same precondition the old close blocker used).
export function payrollTrackedForMonth(month: string, firstPayrollMonth: string | null) {
  return firstPayrollMonth === null || month >= firstPayrollMonth;
}

export function needsPayrollEstimate(batch: PayrollBatchSource, month: string, firstPayrollMonth: string | null) {
  return batch?.status !== "completed" && payrollTrackedForMonth(month, firstPayrollMonth);
}

export function resolveLedgerPayrollCost(input: {
  month: string;
  batch: PayrollBatchSource;
  firstPayrollMonth: string | null;
  recognizedAmount: number;
  estimate: PayrollEstimateSource | null;
}): LedgerPayrollCost {
  const { month, batch, recognizedAmount } = input;
  const batchStatus = batch?.status ?? null;
  if (batch?.status === "completed") {
    const amount = finiteNumber(batch.actualCompanyCostTotal) ?? recognizedAmount;
    return { month, status: "finalized", amount, recognizedAmount, adjustment: Math.max(0, amount - recognizedAmount), batchStatus };
  }
  if (!payrollTrackedForMonth(month, input.firstPayrollMonth)) {
    return { month, status: "not_tracked", amount: recognizedAmount, recognizedAmount, adjustment: 0, batchStatus };
  }
  const estimate = input.estimate;
  if (!estimate || !estimate.ok) {
    return { month, status: "unavailable", amount: null, recognizedAmount, adjustment: null, batchStatus, reason: "PAYROLL_ESTIMATE_FAILED" };
  }
  if (estimate.unavailableCount > 0) {
    return { month, status: "unavailable", amount: null, recognizedAmount, adjustment: null, batchStatus, reviewCount: estimate.reviewCount, reason: "PAYROLL_CALCULATION_UNAVAILABLE" };
  }
  return {
    month, status: "predicted", amount: estimate.companyCost, recognizedAmount,
    // A batch in progress (paying) adds nothing yet: the whole predicted cost stays,
    // and paid salaries are cash movements, not expense.
    adjustment: Math.max(0, estimate.companyCost - recognizedAmount), batchStatus, reviewCount: estimate.reviewCount,
  };
}
