export type FundAccountViewMode = "live" | "provisional" | "closed_snapshot";

export type FundAccountReservePlan = {
  id: number | string;
  name: string;
  is_active?: boolean;
  fund_account_id?: number | string | null;
  currentAmount?: number | string;
  linked_recurring_plan?: { source_key_prefix?: string | null } | Array<{ source_key_prefix?: string | null }> | null;
  entries?: Array<{ entry_type: string; amount: number | string }> | null;
};

type GroupedReserve = {
  id: number;
  name: string;
  currentAmount: number;
  linkedRecurringSourceKeyPrefix: string | null;
};

type FundAccount = {
  id: number | string;
  code: string;
  [key: string]: unknown;
};

type FundMovement = {
  fund_account_id: number | string;
  amount: number | string;
};

type MonthCloseSummary = {
  funds?: { accounts?: unknown } | null;
  reserve?: { plans?: unknown } | null;
};

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

export function fundAccountViewMode(
  month: string,
  currentBusinessDate: string,
  hasClosedSnapshot: boolean,
): FundAccountViewMode {
  if (month === currentBusinessDate.slice(0, 7)) return "live";
  return hasClosedSnapshot ? "closed_snapshot" : "provisional";
}

export function buildFundAccountView<T extends FundAccount>({
  accounts,
  openingMovements,
  movements,
  reservePlans,
  groupReserves,
  mode,
  closeSummary,
}: {
  accounts: readonly T[];
  openingMovements: readonly FundMovement[];
  movements: readonly FundMovement[];
  reservePlans: readonly FundAccountReservePlan[];
  groupReserves: (plans: readonly FundAccountReservePlan[]) => Map<number, GroupedReserve[]>;
  mode: FundAccountViewMode;
  closeSummary?: MonthCloseSummary | null;
}) {
  const openingByAccount = new Map<number, number>();
  for (const row of openingMovements) {
    const accountId = Number(row.fund_account_id);
    openingByAccount.set(accountId, (openingByAccount.get(accountId) ?? 0) + Number(row.amount));
  }

  const movementBalances = new Map<number, number>();
  for (const row of movements) {
    const accountId = Number(row.fund_account_id);
    movementBalances.set(accountId, (movementBalances.get(accountId) ?? 0) + Number(row.amount));
  }

  const snapshotAccounts = records(closeSummary?.funds?.accounts);
  const snapshotBalanceById = new Map(snapshotAccounts.map((account) => [Number(account.id), Number(account.balance ?? 0)]));
  const snapshotBalanceByCode = new Map(snapshotAccounts.map((account) => [String(account.code ?? ""), Number(account.balance ?? 0)]));
  const effectiveReservePlans = mode === "closed_snapshot"
    ? records(closeSummary?.reserve?.plans).map((plan) => ({
        id: Number(plan.id),
        name: String(plan.name ?? ""),
        is_active: plan.is_active !== false,
        fund_account_id: plan.fund_account_id == null ? null : Number(plan.fund_account_id),
        currentAmount: Number(plan.currentAmount ?? 0),
        linked_recurring_plan: plan.linked_recurring_plan as FundAccountReservePlan["linked_recurring_plan"],
      }))
    : reservePlans;
  const accountReserves = groupReserves(effectiveReservePlans);

  return accounts.map((account) => {
    const accountId = Number(account.id);
    const balance = mode === "closed_snapshot"
      ? snapshotBalanceById.get(accountId) ?? snapshotBalanceByCode.get(account.code) ?? 0
      : movementBalances.get(accountId) ?? 0;
    const reserves = accountReserves.get(accountId) ?? [];
    const reserveTotal = reserves.reduce((sum, reserve) => sum + reserve.currentAmount, 0);

    return {
      ...account,
      balance,
      openingBalance: openingByAccount.get(accountId) ?? 0,
      reserves,
      reserveTotal,
      availableBalance: balance - reserveTotal,
    };
  });
}
