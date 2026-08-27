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
