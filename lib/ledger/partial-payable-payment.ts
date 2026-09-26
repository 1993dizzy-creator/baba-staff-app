import {
  buildOldestFirstAllocations,
  sumPayableAmounts,
  type OutstandingPayable,
  type PayableAllocation,
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
} from "./payables.ts";

// Partial (arbitrary amount) payment for one party. Allocation is exactly
// buildOldestFirstAllocations(); this only validates the amount so the preview
// shown to the user is the allocation list sent to /api/admin/ledger/payables/pay.
// Sending explicit allocations matters: with allocations=null the RPC would pick
// its own oldest-first set, which also includes payment-verification payables.
export type PartialPaymentError = "nothing_outstanding" | "invalid_amount" | "exceeds_outstanding";
export type PartialPaymentPlan = {
  amount: number;
  totalOutstanding: number;
  allocations: PayableAllocation[];
  error: PartialPaymentError | null;
};

export function planPartialPayablePayment(payables: readonly OutstandingPayable[], amount: number): PartialPaymentPlan {
  const open = payables.filter((payable) => payable.outstandingAmount > 0);
  const totalOutstanding = sumPayableAmounts(open.map((payable) => payable.outstandingAmount));
  const fail = (error: PartialPaymentError): PartialPaymentPlan => ({ amount, totalOutstanding, allocations: [], error });
  if (!open.length) return fail("nothing_outstanding");
  // DB amounts are numeric(16,3).
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 1000) / 1000 !== amount) return fail("invalid_amount");
  if (amount > totalOutstanding) return fail("exceeds_outstanding");
  const { allocations, unallocatedAmount } = buildOldestFirstAllocations(open, amount);
  if (unallocatedAmount > 0) return fail("exceeds_outstanding");
  return { amount, totalOutstanding, allocations, error: null };
}
