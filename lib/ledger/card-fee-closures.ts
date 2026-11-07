import type { AutoCardFeeMonth } from "./card-fee-policy";
import { calculateCardGross, calculateMonthlySettlementDifference, cardMoney, type CardAllocationLine, type CardReconciliation, type CardSale } from "./card-settlements";

export type CardFeeClosure = {
  id: number; fee_month: string; fee_amount: number | string; status: string; expense_transaction_id: number | null;
  finalization_business_date?: string | null; confirmed_at: string; confirmed_by: number; cancelled_at: string | null; cancel_reason: string | null; memo: string | null;
};
export type CardFeeBlocker = "current_month" | "future_month" | "no_card_sales" | "legacy_unallocated_deposits" | "earlier_month_unconfirmed" | "provisional_fee" | "nothing_to_settle" | "no_settlement_deposit";

const monthOf = (date: string) => date.slice(0, 7);
const nextMonthStart = (month: string) => {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
};

// Preview of ledger_complete_card_month_v1 (card payment settlement) for one sale month: the fee is
// the month's actual remainder after its last deposit. The RPC recomputes under lock; this only
// explains the state. Closed months can be settled too (post-close finalization). `lines` must include deposit lines and active
// month-end fee lines (loadCardAllocationLines) so outstanding matches the RPC.
export function buildCardFeeMonthState(input: {
  month: string; currentMonth: string; closedMonths: ReadonlySet<string>;
  sales: readonly CardSale[]; lines: readonly CardAllocationLine[]; reconciliations: readonly CardReconciliation[];
  closures: readonly CardFeeClosure[];
  // Provisional manual card-fee expense per sale month (YYYY-MM); mirrors ledger_card_fee_private.provisional_fee.
  provisionalFees?: Readonly<Record<string, number>>;
}) {
  const { month, currentMonth, closedMonths, sales, lines, reconciliations, closures } = input;
  const start = `${month}-01`, end = nextMonthStart(month);
  const gross = calculateCardGross(sales, lines, start, end);
  const monthCardGross = gross.monthlyCardGross;
  const currentOutstanding = gross.monthlyUnreconciledGross;
  // Historical matched differences attributed to this sale month; never recomputed here.
  const historicalConfirmedFee = calculateMonthlySettlementDifference(sales, lines, reconciliations, start, end);
  const closure = closures.find(row => row.status === "confirmed" && row.fee_month.slice(0, 7) === month) ?? null;
  const confirmedMonths = new Set(closures.filter(row => row.status === "confirmed").map(row => monthOf(row.fee_month)));
  const monthClosed = closedMonths.has(month);
  const legacy = reconciliations.filter(row => (row.status === "unmatched" || row.status === "partial") && row.deposit_date >= start);
  const provisional = (m: string) => input.provisionalFees?.[m] ?? 0;
  const earlierOutstanding = new Map<string, number>();
  for (const sale of gross.sales) if (sale.business_date < start && sale.outstandingGrossAmount > 0) earlierOutstanding.set(monthOf(sale.business_date), cardMoney((earlierOutstanding.get(monthOf(sale.business_date)) ?? 0) + sale.outstandingGrossAmount));
  // Same rule on both settlement paths: any older unsettled month beyond its provisional fee.
  const earlierMonth = [...earlierOutstanding]
    .filter(([saleMonth, outstanding]) => !confirmedMonths.has(saleMonth) && outstanding - provisional(saleMonth) > 0)
    .map(([saleMonth]) => saleMonth).sort()[0] ?? null;
  // An actual automatic deposit after month end must have paid this month's sales.
  const monthSaleIds = new Set(sales.filter(sale => sale.business_date >= start && sale.business_date < end).map(sale => Number(sale.id)));
  const hasSettlementDeposit = lines.some(line => line.reconciliation?.status === "auto_allocated" && (line.reconciliation.deposit_date ?? "") >= end && monthSaleIds.has(Number(line.pos_card_transaction_id)));
  const blocker: CardFeeBlocker | null = month > currentMonth ? "future_month"
    : month === currentMonth ? "current_month"
        // Same order as ledger_complete_card_month_v1.
        : provisional(month) !== 0 ? "provisional_fee"
          : legacy.length ? "legacy_unallocated_deposits"
            : earlierMonth ? "earlier_month_unconfirmed"
              : monthCardGross <= 0 ? "no_card_sales"
                : currentOutstanding <= 0 ? "nothing_to_settle"
                  : !hasSettlementDeposit ? "no_settlement_deposit"
                    : null;
  const closureFee = closure ? cardMoney(Number(closure.fee_amount)) : 0;
  // Every unsettled sale month (deposit preview): legacy review applies to any month a deposit would pay,
  // a provisional fee only to a prior closed month.
  const autoFeeMonths: AutoCardFeeMonth[] = [...new Set(sales.map(sale => monthOf(sale.business_date)))].filter(m => !confirmedMonths.has(m)).sort().map(m => ({
    month: m, closed: closedMonths.has(m), reviewRequired: reconciliations.some(r => (r.status === "unmatched" || r.status === "partial") && r.deposit_date >= `${m}-01`), gross: sales.filter(s => monthOf(s.business_date) === m).reduce((n,s) => n+Number(s.amount),0),
    outstanding: gross.sales.filter(s => monthOf(s.business_date) === m).reduce((n,s) => n+s.outstandingGrossAmount,0),
    ...(input.provisionalFees?.[m] ? { provisionalFee: input.provisionalFees[m] } : {}),
  })).filter(row => row.gross > 0 && row.outstanding > 0);
  const remainingRate = monthCardGross > 0 ? currentOutstanding / monthCardGross : null;
  // No rate window any more: an unsettled month simply waits for its settlement step.
  const autoStatus = closure ? "confirmed" : month >= currentMonth ? "current_month"
    : legacy.length ? "review_required" : !monthClosed ? "awaiting_month_close" : "settlement_pending";
  return {
    autoFeeMonths, remainingRate, autoStatus,
    confirmedRate: closure && monthCardGross > 0 ? cardMoney(Number(closure.fee_amount)) / monthCardGross : null,
    month,
    hasCardSales: monthCardGross > 0,
    monthCardGross,
    historicalConfirmedFee,
    currentOutstanding,
    projectedTotalFee: cardMoney(historicalConfirmedFee + currentOutstanding),
    closure,
    monthEndFee: closureFee,
    finalConfirmedFee: closure ? cardMoney(historicalConfirmedFee + closureFee) : null,
    monthClosed,
    legacyPending: { count: legacy.length, amount: cardMoney(legacy.reduce((sum, row) => sum + Number(row.deposit_amount), 0)) },
    earlierUnconfirmedMonth: earlierMonth,
    blockerReason: closure ? null : blocker,
    canConfirm: !closure && blocker === null,
    canCancel: Boolean(closure) && (!monthClosed || Boolean(closure?.finalization_business_date)),
  };
}
