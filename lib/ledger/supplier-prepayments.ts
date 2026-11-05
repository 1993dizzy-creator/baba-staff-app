// Supplier prepayments (선결제): a confirmed payable_payment flagged
// source_snapshot.prepayment=true with an outflow and no (or partial) allocations.
// Its unallocated amount is the unused prepayment balance.

export type UnusedPrepayment = {
  id: number;
  partyId: number;
  businessDate: string;
  amount: number;
  unusedAmount: number;
  memo: string | null;
};

export type PrepaymentAllocation = { prepaymentTransactionId: number; payableId: number; allocatedAmount: number };

const units = (value: number | string) => Math.round(Number(value) * 1000);
const fromUnits = (value: number) => value / 1000;

export function isSupplierPrepayment(row: { type?: string | null; status?: string | null; source_snapshot?: Record<string, unknown> | null }) {
  return row.type === "payable_payment" && row.status === "confirmed" && row.source_snapshot?.prepayment === true;
}

export function unusedPrepaymentAmount(amount: number | string, allocations: readonly { allocated_amount: number | string }[] | null | undefined) {
  return fromUnits(Math.max(0, units(amount) - (allocations ?? []).reduce((sum, row) => sum + units(row.allocated_amount), 0)));
}

export function totalUnusedPrepayment(prepayments: readonly Pick<UnusedPrepayment, "unusedAmount">[]) {
  return fromUnits(prepayments.reduce((sum, row) => sum + units(row.unusedAmount), 0));
}

// Splits the requested payable amounts over the party's prepayments, oldest first.
// Never creates an amount beyond the unused balance: the caller pays the rest normally.
export function planPrepaymentApplication(prepayments: readonly UnusedPrepayment[], targets: readonly { payableId: number; allocatedAmount: number }[]):
  { allocations: PrepaymentAllocation[]; amount: number } | { error: "insufficient" | "empty"; available: number } {
  const available = prepayments.map(row => ({ id: row.id, left: units(row.unusedAmount), date: row.businessDate }))
    .filter(row => row.left > 0).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const totalAvailable = available.reduce((sum, row) => sum + row.left, 0);
  const requested = targets.reduce((sum, row) => sum + units(row.allocatedAmount), 0);
  if (requested <= 0 || targets.some(row => units(row.allocatedAmount) <= 0)) return { error: "empty", available: fromUnits(totalAvailable) };
  if (requested > totalAvailable) return { error: "insufficient", available: fromUnits(totalAvailable) };
  const allocations: PrepaymentAllocation[] = [];
  let index = 0;
  for (const target of targets) {
    let need = units(target.allocatedAmount);
    while (need > 0) {
      const source = available[index];
      const take = Math.min(need, source.left);
      const existing = allocations.find(row => row.prepaymentTransactionId === source.id && row.payableId === target.payableId);
      if (existing) existing.allocatedAmount = fromUnits(units(existing.allocatedAmount) + take);
      else allocations.push({ prepaymentTransactionId: source.id, payableId: target.payableId, allocatedAmount: fromUnits(take) });
      source.left -= take; need -= take;
      if (source.left === 0) index++;
    }
  }
  return { allocations, amount: fromUnits(requested) };
}

// A prepayment application takes effect on greatest(prepayment date, receipt date):
// the prepayment's own month is never changed retroactively by a later link.
export function prepaymentApplicationDate(prepaymentBusinessDate: string, receiptBusinessDate: string | null | undefined) {
  return receiptBusinessDate && receiptBusinessDate > prepaymentBusinessDate ? receiptBusinessDate : prepaymentBusinessDate;
}

// Unused balance as of a month end (businessDateExclusive = first day of the next month).
// Applications dated on/after that day are still unused for that month.
export function unusedPrepaymentAmountAsOf(
  amount: number | string, prepaymentBusinessDate: string,
  allocations: readonly { allocated_amount: number | string; receiptBusinessDate?: string | null }[] | null | undefined,
  businessDateExclusive: string,
) {
  if (prepaymentBusinessDate >= businessDateExclusive) return 0;
  return unusedPrepaymentAmount(amount, (allocations ?? []).filter(row => prepaymentApplicationDate(prepaymentBusinessDate, row.receiptBusinessDate) < businessDateExclusive));
}
