// @ts-expect-error Node's isolated test runner requires the extension.
import { cardMoney, sumCardMoney, type CardDepositAutoAllocationRow } from "./card-settlements.ts";

export const CARD_FEE_TARGET_RATE = 0.0215;
export const CARD_FEE_AUTO_CLOSE_MIN_RATE = 0.018;
export const CARD_FEE_AUTO_CLOSE_MAX_RATE = 0.025;

export type AutoCardFeeMonth = { month: string; gross: number; outstanding: number; reviewRequired?: boolean };

// Same planning contract as the RPC, before any deposit/fee write. A fee already
// in range is preserved; an overshoot reserves target, not all remaining gross.
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
    let payment = Math.min(remaining,outstanding), fee=0;
    if (feeMonth) {
      const rate=outstanding/feeMonth.gross, after=(outstanding-payment)/feeMonth.gross;
      if (feeMonth.reviewRequired || feeMonth.gross<=0 || rate<CARD_FEE_AUTO_CLOSE_MIN_RATE) return result("review_required");
      if (rate<=CARD_FEE_AUTO_CLOSE_MAX_RATE) { fee=outstanding; payment=0; }
      else if (after<=CARD_FEE_AUTO_CLOSE_MAX_RATE) {
        fee=after>=CARD_FEE_AUTO_CLOSE_MIN_RATE ? cardMoney(outstanding-payment) : cardMoney(feeMonth.gross*CARD_FEE_TARGET_RATE);
        payment=cardMoney(outstanding-fee);
      }
      if (fee>0) fees.push({month,amount:fee});
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
