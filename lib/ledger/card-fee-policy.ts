import { cardMoney, sumCardMoney, type CardDepositAutoAllocationRow } from "./card-settlements.ts";

// provisionalFee: confirmed manual card-fee expense already taken from card clearing for this sale month.
export type AutoCardFeeMonth = { month: string; gross: number; outstanding: number; reviewRequired?: boolean; provisionalFee?: number };

// Same planning contract as ledger_create_card_deposit_auto_allocate_v1: the deposit pays only real
// principal, oldest sale first. No card fee is planned here; a fee is booked only by the explicit
// month settlement after the month's last deposit. `fees` stays (always empty) for callers.
export function planCardDepositWithFees(
  sales: readonly { id: number; business_date: string; outstandingGrossAmount: number | string }[],
  amount: number, depositDate: string, feeMonths: readonly AutoCardFeeMonth[],
) {
  const rows: CardDepositAutoAllocationRow[] = [];
  const fees: { month: string; amount: number }[] = [];
  const eligible = sales.filter(sale => sale.business_date <= depositDate && Number(sale.outstandingGrossAmount) > 0)
    .sort((a,b) => a.business_date.localeCompare(b.business_date) || a.id-b.id);
  const availableOutstanding = sumCardMoney(eligible.map(sale => sale.outstandingGrossAmount));
  let remaining = amount;
  const result = (error: "invalid_amount" | "nothing_outstanding" | "exceeds_outstanding" | "review_required" | null) => ({
    error, depositAmount: amount, availableOutstanding, rows: error ? [] : rows, fees: error ? [] : fees,
    totalAllocated: error ? 0 : sumCardMoney(rows.map(row => row.allocatedAmount)),
  });
  if (!Number.isFinite(amount) || amount<=0 || cardMoney(amount)!==amount) return result("invalid_amount");
  if (!eligible.length) return result("nothing_outstanding");
  for (const month of [...new Set(eligible.map(sale => sale.business_date.slice(0,7)))]) {
    if (remaining<=0) break;
    const monthSales = eligible.filter(sale => sale.business_date.startsWith(month));
    const outstanding = sumCardMoney(monthSales.map(sale => sale.outstandingGrossAmount));
    const feeMonth = feeMonths.find(row => row.month===month && month<depositDate.slice(0,7));
    let payment = Math.min(remaining,outstanding);
    const provisional = feeMonth?.provisionalFee ?? 0;
    if (provisional !== 0) {
      // Already expensed and out of card clearing: never repaid (RPC provisional_fee guard).
      if (!feeMonth || feeMonth.reviewRequired || provisional < 0 || provisional > outstanding) return result("review_required");
      payment = Math.min(remaining, cardMoney(outstanding - provisional));
    }
    remaining=cardMoney(remaining-payment);
    for (const sale of monthSales) {
      if (payment<=0) break;
      const before=Number(sale.outstandingGrossAmount), allocated=cardMoney(Math.min(payment,before));
      rows.push({transactionId:sale.id,businessDate:sale.business_date,outstandingBefore:before,allocatedAmount:allocated,outstandingAfter:cardMoney(before-allocated)});
      payment=cardMoney(payment-allocated);
    }
  }
  return result(remaining>0 ? "exceeds_outstanding" : null);
}
