import type { LedgerEntry, LedgerEntryItem } from "./entries";

// Display-only totals for an inventory purchase row's detail (현재 상태).
// original: booked purchase amount; paid: actual cash paid (immediate rows were
// paid in full when booked); remaining: still owed; adjustment: the non-cash
// small difference settled without money. Never feeds any ledger calculation.
export function inventoryPurchaseStatusSummary(entry: Pick<LedgerEntry, "items">) {
  const sum = (pick: (item: LedgerEntryItem) => number) => entry.items.reduce((total, item) => total + pick(item), 0);
  const original = sum(item => item.purchaseSettlement?.originalAmount ?? item.amount);
  const effective = sum(item => item.purchaseSettlement?.effectiveAmount ?? item.amount);
  const paid = sum(item => item.purchaseSettlement?.cashPaidAmount ?? item.amount);
  const remaining = sum(item => item.purchaseSettlement?.remainingAmount ?? 0);
  const payable = entry.items.some(item => item.purchaseSettlement != null);
  const state: "paid" | "partial" | "unpaid" = remaining <= 0 ? "paid" : paid > 0 ? "partial" : "unpaid";
  // Still owed on a 결제 미확인 payable: recorded from 미납금 현황 › 기타, not a party.
  const verificationPending = entry.items.some(item => item.paymentVerificationPending === true && (item.purchaseSettlement?.remainingAmount ?? 0) > 0);
  return { payable, original, effective, paid, remaining, adjustment: original - effective, state, verificationPending };
}
