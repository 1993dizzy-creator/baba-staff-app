import type { TransactionRow } from "./entries";

export type PayrollPaymentGroupIssue = {
  originalTransactionId: number | null;
  reversalTransactionId: number | null;
  code: "missing_original" | "invalid_original" | "duplicate_reversal" | "amount_mismatch" |
    "group_mismatch" | "movement_mismatch" | "active_group_overlap";
};

const id = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const groupKey = (row: TransactionRow) => {
  const key = row.source_snapshot?.groupKey;
  return typeof key === "string" && key.trim() ? key : null;
};

// This is a display projection only. Never remove either side from the raw
// transactions used for balances, cash flows, profit, or the audit trail.
export function analyzePayrollPaymentGroups(transactions: readonly TransactionRow[]) {
  const byId = new Map(transactions.map(row => [id(row.id), row]));
  const reversals = new Map<number | null, TransactionRow[]>();
  const issues: PayrollPaymentGroupIssue[] = [];
  const reversedOriginalIds = new Set<number>();
  for (const row of transactions) {
    if (row.source_type !== "payroll_payment_group_reversal" || row.status !== "confirmed") continue;
    const originalId = id(row.correction_of_id);
    const linked = reversals.get(originalId) ?? [];
    linked.push(row);
    reversals.set(originalId, linked);
  }
  for (const [originalId, linked] of reversals) {
    const original = originalId == null ? undefined : byId.get(originalId);
    for (const reversal of linked) {
      let code: PayrollPaymentGroupIssue["code"] | null = null;
      if (!original) code = "missing_original";
      else if (original.source_type !== "payroll_payment_group" || original.type !== "payroll_payment" ||
        original.status !== "confirmed" || original.correction_of_id != null ||
        Number(original.economic_effect_sign) !== 1 || reversal.type !== "payroll_payment" ||
        Number(reversal.economic_effect_sign) !== -1) code = "invalid_original";
      else if (linked.length !== 1) code = "duplicate_reversal";
      else if (!Number.isFinite(Number(original.amount)) || Number(original.amount) <= 0 ||
        Number(original.amount) !== Number(reversal.amount)) code = "amount_mismatch";
      else if (!groupKey(original) || groupKey(original) !== groupKey(reversal) ||
        id(reversal.source_snapshot?.originalTransactionId) !== originalId ||
        original.business_date !== reversal.business_date) code = "group_mismatch";
      else {
        const outgoing = original.movements ?? [], incoming = reversal.movements ?? [];
        const accountId = id(original.source_snapshot?.fundAccountId);
        // The unchanged SQL projector creates exactly one movement per side.
        // Missing metadata or unexpected split movements require investigation.
        if (outgoing.length !== 1 || incoming.length !== 1 || accountId == null ||
          id(outgoing[0]?.fund_account?.id) !== accountId ||
          id(incoming[0]?.fund_account?.id) !== accountId ||
          Number(outgoing[0]?.amount) !== -Number(original.amount) ||
          Number(incoming[0]?.amount) !== Number(original.amount)) code = "movement_mismatch";
      }
      if (code) issues.push({ originalTransactionId: originalId, reversalTransactionId: id(reversal.id), code });
      else reversedOriginalIds.add(originalId!);
    }
  }
  // An unlinked/missing cancellation cannot be inferred from a newer ID or
  // version. Keep all ambiguous originals and make the overlap visible.
  const activeGroups = new Map<string, TransactionRow[]>();
  for (const row of transactions) {
    if (row.source_type !== "payroll_payment_group" || row.status !== "confirmed" ||
      reversedOriginalIds.has(id(row.id)!) || !groupKey(row)) continue;
    const key = groupKey(row)!;
    const active = activeGroups.get(key) ?? [];
    active.push(row);
    activeGroups.set(key, active);
  }
  for (const active of activeGroups.values()) {
    if (active.length < 2) continue;
    for (const row of active) issues.push({ originalTransactionId: id(row.id), reversalTransactionId: null, code: "active_group_overlap" });
  }
  return { reversedOriginalIds, issues };
}
