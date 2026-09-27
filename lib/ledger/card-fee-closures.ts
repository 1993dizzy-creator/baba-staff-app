import { calculateCardGross, calculateMonthlySettlementDifference, cardMoney, type CardAllocationLine, type CardReconciliation, type CardSale } from "./card-settlements";

export type CardFeeClosure = {
  id: number; fee_month: string; fee_amount: number | string; status: string; expense_transaction_id: number | null;
  confirmed_at: string; confirmed_by: number; cancelled_at: string | null; cancel_reason: string | null; memo: string | null;
};
export type CardFeeBlocker = "current_month" | "future_month" | "month_closed" | "no_card_sales" | "legacy_unallocated_deposits" | "earlier_month_unconfirmed";

const monthOf = (date: string) => date.slice(0, 7);
const nextMonthStart = (month: string) => {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
};

// Preview of ledger_confirm_card_fee_month_v1 for one sale month. The RPC recomputes the fee
// under lock; this only explains the state. `lines` must include deposit lines and active
// month-end fee lines (loadCardAllocationLines) so outstanding matches the RPC.
export function buildCardFeeMonthState(input: {
  month: string; currentMonth: string; closedMonths: ReadonlySet<string>;
  sales: readonly CardSale[]; lines: readonly CardAllocationLine[]; reconciliations: readonly CardReconciliation[];
  closures: readonly CardFeeClosure[];
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
  const earlierMonth = gross.sales
    .filter(sale => sale.business_date < start && sale.outstandingGrossAmount > 0)
    .map(sale => monthOf(sale.business_date))
    .filter(saleMonth => !closedMonths.has(saleMonth) && !confirmedMonths.has(saleMonth))
    .sort()[0] ?? null;
  const blocker: CardFeeBlocker | null = month > currentMonth ? "future_month"
    : month === currentMonth ? "current_month"
      : monthClosed ? "month_closed"
        // Same order as ledger_confirm_card_fee_month_v1.
        : legacy.length ? "legacy_unallocated_deposits"
          : earlierMonth ? "earlier_month_unconfirmed"
            : monthCardGross <= 0 ? "no_card_sales"
              : null;
  const closureFee = closure ? cardMoney(Number(closure.fee_amount)) : 0;
  return {
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
    canCancel: Boolean(closure) && !monthClosed,
  };
}
