import { classifyPaymentBucket, PAID_POS_PAYMENT_STATUS, type PosPaymentRow } from "../sales/payment-summary.ts";
import { cardMoney } from "./card-settlements.ts";

// Read-only review candidates for a card fee difference. A close amount is a hint
// to look at a receipt, never proof of an error. Amounts compared are the
// receipt's card payment total, not the receipt total (split payments differ).
export const CARD_RECEIPT_CANDIDATE_LIMIT = 5;
export type CandidateReceipt = {
  id: number; ref_no: string | null; business_date: string; ref_date: string | null;
  payment_status: number | null; is_canceled: boolean | null; final_amount: number | string | null;
};
export type CandidatePayment = PosPaymentRow & { id: number };
export type CandidateLedgerDay = { business_date: string; amount: number | string };
export type CandidatePosStatus = "paid" | "canceled" | "refunded" | "unpaid";
export type CandidateLedgerStatus = "reflected" | "excluded" | "day_mismatch" | "ledger_missing";

function posStatus(receipt: CandidateReceipt): CandidatePosStatus {
  if (receipt.is_canceled === true || receipt.payment_status === 4) return "canceled";
  if (receipt.payment_status === 5) return "refunded";
  return receipt.payment_status === PAID_POS_PAYMENT_STATUS ? "paid" : "unpaid";
}
const counted = (receipt: CandidateReceipt | undefined) => Boolean(receipt) && posStatus(receipt!) === "paid";
const money = (value: number | string | null) => cardMoney(Number(value ?? 0));

export function rankCardReceiptCandidates(input: {
  target: number; receipts: readonly CandidateReceipt[]; payments: readonly CandidatePayment[];
  ledgerDays: readonly CandidateLedgerDay[]; limit?: number;
}) {
  const target = cardMoney(Math.abs(input.target));
  const receiptById = new Map(input.receipts.map(row => [row.id, row]));
  const cardPayments = input.payments.filter(row => row.receipt_id !== null && classifyPaymentBucket(row) === "card");
  // POS day card total uses the same eligibility as the daily ledger card row (paid, not cancelled).
  const posDay = new Map<string, number>();
  for (const row of cardPayments) if (counted(receiptById.get(Number(row.receipt_id)))) posDay.set(row.business_date, cardMoney((posDay.get(row.business_date) ?? 0) + money(row.amount)));
  const ledgerDay = new Map<string, number>();
  for (const row of input.ledgerDays) ledgerDay.set(row.business_date, cardMoney((ledgerDay.get(row.business_date) ?? 0) + money(row.amount)));
  const byReceipt = new Map<number, CandidatePayment[]>();
  for (const row of cardPayments) byReceipt.set(Number(row.receipt_id), [...byReceipt.get(Number(row.receipt_id)) ?? [], row]);
  const candidates = [...byReceipt].flatMap(([receiptId, payments]) => {
    const receipt = receiptById.get(receiptId);
    if (!receipt) return [];
    const cardAmount = cardMoney(payments.reduce((sum, row) => sum + money(row.amount), 0));
    const status = posStatus(receipt);
    const ledgerDayAmount = ledgerDay.get(receipt.business_date) ?? null;
    const posDayCardAmount = posDay.get(receipt.business_date) ?? 0;
    const ledgerStatus: CandidateLedgerStatus = status !== "paid" ? "excluded"
      : ledgerDayAmount === null ? "ledger_missing" : ledgerDayAmount !== posDayCardAmount ? "day_mismatch" : "reflected";
    return [{
      receiptId, refNo: receipt.ref_no, businessDate: receipt.business_date, refDate: receipt.ref_date,
      cardAmount, receiptFinalAmount: money(receipt.final_amount), distance: cardMoney(Math.abs(cardAmount - target)),
      cardNames: [...new Set(payments.map(row => row.card_name?.trim()).filter((name): name is string => Boolean(name)))],
      paymentMethods: [...new Set(payments.map(row => row.payment_name?.trim()).filter((name): name is string => Boolean(name)))],
      posStatus: status, ledgerStatus, ledgerDayAmount, posDayCardAmount,
    }];
  });
  return candidates
    .sort((a, b) => a.distance - b.distance || a.businessDate.localeCompare(b.businessDate) || a.receiptId - b.receiptId)
    .slice(0, input.limit ?? CARD_RECEIPT_CANDIDATE_LIMIT);
}
export type CardReceiptCandidate = ReturnType<typeof rankCardReceiptCandidates>[number];
