export type ReserveEntryAmount = {
  entry_type: string;
  amount: number | string;
};

export type AccountReservePlan = {
  id: number | string;
  name: string;
  is_active?: boolean;
  fund_account_id?: number | string | null;
  linked_recurring_plan?: { source_key_prefix?: string | null } | Array<{ source_key_prefix?: string | null }> | null;
  entries?: ReserveEntryAmount[] | null;
};

export function reserveCurrentAmount(entries: readonly ReserveEntryAmount[]) {
  return entries.reduce((sum, entry) => {
    const amount = Number(entry.amount);
    if (entry.entry_type === "allocate") return sum + amount;
    if (entry.entry_type === "release" || entry.entry_type === "consume") return sum - amount;
    return sum + amount;
  }, 0);
}

// Shortfall between a plan's target and what is actually reserved. Never negative:
// linking a fund account or raising the target does not create reserved money —
// only `allocate` entries do — so a freshly linked plan reads target as the shortfall.
export function reserveShortfall(targetAmount: number, currentAmount: number) {
  return Math.max(0, targetAmount - currentAmount);
}

export const RESERVE_FUND_ACCOUNT_TYPES = ["cash", "bank", "personal_custody"] as const;

export type ReserveFundAccountCandidate = {
  type: string;
  code: string;
  is_active?: boolean;
  is_business_fund?: boolean;
};

// Mirrors the DB rule enforced by ledger_reserve_plans_fund_account_guard and
// ledger_create_reserve_plan_v2 / _v1 entry validation: a reserve may only be
// parked in an active, business-owned liquid fund that is not the card-clearing bucket.
export function isReserveEligibleFundAccount(account: ReserveFundAccountCandidate) {
  return (
    (account.is_active ?? true) &&
    (account.is_business_fund ?? false) &&
    account.code !== "card_clearing" &&
    (RESERVE_FUND_ACCOUNT_TYPES as readonly string[]).includes(account.type)
  );
}

export function reservesByFundAccount(plans: readonly AccountReservePlan[]) {
  const byAccount = new Map<number, Array<{ id: number; name: string; currentAmount: number; linkedRecurringSourceKeyPrefix: string | null }>>();
  for (const plan of plans) {
    if (plan.fund_account_id == null) continue;
    const currentAmount = reserveCurrentAmount(plan.entries ?? []);
    if (plan.is_active === false && currentAmount === 0) continue;
    const accountId = Number(plan.fund_account_id);
    const list = byAccount.get(accountId) ?? [];
    const linkedPlan = Array.isArray(plan.linked_recurring_plan)
      ? plan.linked_recurring_plan[0]
      : plan.linked_recurring_plan;
    list.push({
      id: Number(plan.id),
      name: plan.name,
      currentAmount,
      linkedRecurringSourceKeyPrefix: linkedPlan?.source_key_prefix ?? null,
    });
    byAccount.set(accountId, list);
  }
  return byAccount;
}
