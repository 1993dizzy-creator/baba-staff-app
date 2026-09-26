export type DashboardCategory = {
  id: number | string;
  name: string;
  kind: "income" | "expense";
  parent_id: number | string | null;
};

export type DashboardProfitTransaction = {
  type: string;
  amount: number | string;
  economic_effect_sign?: number | string | null;
  category_id?: number | string | null;
};

export type DashboardIncomeDetailTransaction = {
  id: number | string;
  type: string;
  amount: number | string;
  economic_effect_sign?: number | string | null;
  recognition_month?: string | null;
  memo?: string | null;
  category?: { id?: number | string | null } | null;
};

export type DashboardAccount = {
  code?: string | null;
  type: string;
  is_business_fund: boolean;
  balance: number;
  openingBalance: number;
};

export type DashboardSummary = {
  income: number;
  expense: number;
  operatingProfit: number;
  receivedIncome: number;
  actualCashOutflow: number;
  otherIncome: number;
};

export type DashboardLedgerData = {
  month: string;
  fundsView: { mode: "live" | "provisional" | "closed_snapshot" };
  summary: DashboardSummary;
  accounts: DashboardAccount[];
  categories: DashboardCategory[];
  profitTransactions: DashboardProfitTransaction[];
  transactions?: DashboardIncomeDetailTransaction[];
  cashReport: {
    expenseBreakdown: ExpenseBreakdownRow[];
    investmentCashFlow: number;
    otherFundAdjustment: number;
    operatingIncomeMovement: number;
  };
};

export type BreakdownRow = {
  id: number;
  name: string;
  amount: number;
};

export type IncomeBreakdownRow = BreakdownRow & {
  details: BreakdownRow[];
};

export type ExpenseBreakdownRow = BreakdownRow & {
  details: BreakdownRow[];
};

export type BreakdownChange =
  | { kind: "percent"; percent: number }
  | { kind: "new" }
  | { kind: "none" };

const INCOME_TYPES = new Set(["sales", "income"]);
const EXPENSE_TYPES = new Set(["expense", "expense_recognition"]);

const numberValue = (value: number | string | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const transactionAmount = (transaction: DashboardProfitTransaction) =>
  numberValue(transaction.amount) * numberValue(transaction.economic_effect_sign ?? 1);

export function shiftLedgerMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

export function previousLedgerMonth(month: string) {
  return shiftLedgerMonth(month, -1);
}

export function percentageChange(current: number, previous: number) {
  if (previous === 0) return null;
  const result = ((current - previous) / Math.abs(previous)) * 100;
  return Number.isFinite(result) ? result : null;
}

export function cashDifferenceChange(current: number, previous: number) {
  if (previous < 0 && current > 0) return { percent: null, transition: "deficit_to_surplus" as const };
  if (previous > 0 && current < 0) return { percent: null, transition: "surplus_to_deficit" as const };
  if (previous === 0 || current === 0 || Math.sign(current) !== Math.sign(previous)) {
    return { percent: null, transition: null };
  }
  return { percent: percentageChange(current, previous), transition: null };
}

function categoryIndex(categories: readonly DashboardCategory[]) {
  return new Map(categories.map((category) => [Number(category.id), category]));
}

function categoryPath(
  categoryId: number,
  categories: ReadonlyMap<number, DashboardCategory>,
) {
  const path: DashboardCategory[] = [];
  const visited = new Set<number>();
  let current = categories.get(categoryId);
  while (current && !visited.has(Number(current.id))) {
    path.push(current);
    visited.add(Number(current.id));
    current = current.parent_id == null ? undefined : categories.get(Number(current.parent_id));
  }
  return path;
}

export function buildIncomeBreakdown(
  categories: readonly DashboardCategory[],
  transactions: readonly DashboardProfitTransaction[],
  detailTransactions: readonly DashboardIncomeDetailTransaction[] = [],
  month?: string,
) {
  const byId = categoryIndex(categories);
  // Rows roll up to the top-level income category (e.g. 예금이자 → 영업수입),
  // like the expense breakdown; child-category transactions stay as details.
  const topLevel = (categoryId: number) => {
    const path = categoryPath(categoryId, byId);
    return path.length ? path[path.length - 1] : undefined;
  };
  const amounts = new Map<number, BreakdownRow>();
  for (const transaction of transactions) {
    if (!INCOME_TYPES.has(transaction.type) || transaction.category_id == null) continue;
    const category = byId.get(Number(transaction.category_id));
    const top = topLevel(Number(transaction.category_id));
    if (!category || category.kind !== "income" || !top) continue;
    const id = Number(top.id);
    const row = amounts.get(id) ?? { id, name: top.name, amount: 0 };
    row.amount += transactionAmount(transaction);
    amounts.set(id, row);
  }
  const detailsByCategory = new Map<number, BreakdownRow[]>();
  for (const transaction of detailTransactions) {
    const categoryId = Number(transaction.category?.id);
    const category = byId.get(categoryId);
    const top = topLevel(categoryId);
    if (
      transaction.type !== "income" ||
      !category ||
      !top ||
      category.kind !== "income" ||
      (month && transaction.recognition_month?.slice(0, 7) !== month)
    ) continue;
    const memoName = incomeDetailName(transaction.memo, category.name);
    const detail: BreakdownRow = {
      id: Number(transaction.id),
      // Keep the source category visible for child-category details.
      name: category.id === top.id || memoName === category.name ? memoName : `${category.name} · ${memoName}`,
      amount: transactionAmount(transaction),
    };
    detailsByCategory.set(Number(top.id), [...(detailsByCategory.get(Number(top.id)) ?? []), detail]);
  }
  return [...amounts.values()]
    .map((row): IncomeBreakdownRow => {
      const details = detailsByCategory.get(row.id) ?? [];
      const detailTotal = details.reduce((sum, detail) => sum + detail.amount, 0);
      return {
        ...row,
        details: details.length > 1 && Math.abs(detailTotal - row.amount) < 0.001
          ? details.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
          : [],
      };
    })
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

export function incomeDetailName(memo: string | null | undefined, fallback: string) {
  const parts = String(memo ?? "")
    .split(/\s*[·•]\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/(\d{1,2}월\s*시트|현금\s*수입|계정\s*수입|monthly\s*sheet|cash\s*income|account\s*income)/i.test(part));
  return parts[0] ?? fallback;
}

export function buildExpenseBreakdown(
  categories: readonly DashboardCategory[],
  transactions: readonly DashboardProfitTransaction[],
) {
  const byId = categoryIndex(categories);
  const topRows = new Map<number, ExpenseBreakdownRow & { detailMap: Map<number, BreakdownRow> }>();
  for (const transaction of transactions) {
    if (!EXPENSE_TYPES.has(transaction.type) || transaction.category_id == null) continue;
    const path = categoryPath(Number(transaction.category_id), byId);
    if (path.length === 0 || path[0].kind !== "expense") continue;
    const top = path.at(-1)!;
    const topId = Number(top.id);
    const row = topRows.get(topId) ?? {
      id: topId,
      name: top.name,
      amount: 0,
      details: [],
      detailMap: new Map<number, BreakdownRow>(),
    };
    const amount = transactionAmount(transaction);
    row.amount += amount;
    const detail = path.length > 1 ? path.at(-2)! : null;
    if (detail) {
      const detailId = Number(detail.id);
      const detailRow = row.detailMap.get(detailId) ?? {
        id: detailId,
        name: detail.name,
        amount: 0,
      };
      detailRow.amount += amount;
      row.detailMap.set(detailId, detailRow);
    }
    topRows.set(topId, row);
  }
  return [...topRows.values()]
    .map(({ detailMap, ...row }) => ({
      ...row,
      details: [...detailMap.values()].sort(
        (a, b) => b.amount - a.amount || a.name.localeCompare(b.name),
      ),
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

// Month-over-month change for a breakdown row. A previous amount of 0 has no
// meaningful %, so a new positive amount is flagged as "new" instead.
export function breakdownChange(currentAmount: number, previousAmount: number): BreakdownChange {
  if (previousAmount === 0) return currentAmount > 0 ? { kind: "new" } : { kind: "none" };
  const percent = percentageChange(currentAmount, previousAmount);
  return percent === null || percent === 0 ? { kind: "none" } : { kind: "percent", percent };
}

export function withMonthChange<T extends BreakdownRow>(current: readonly T[], previous: readonly BreakdownRow[]) {
  const previousById = new Map(previous.map((row) => [row.id, row.amount]));
  return current.map((row) => ({ ...row, change: breakdownChange(row.amount, previousById.get(row.id) ?? 0) }));
}

export function sumBusinessFundBalances(
  accounts: readonly DashboardAccount[],
  field: "balance" | "openingBalance",
) {
  return accounts
    .filter(
      (account) =>
        account.is_business_fund &&
        account.type !== "card_clearing" &&
        account.code !== "card_clearing",
    )
    .reduce((sum, account) => sum + numberValue(account[field]), 0);
}

function buildReceivedIncomeRows(data: DashboardLedgerData): IncomeBreakdownRow[] {
  const otherIncomeRows = buildIncomeBreakdown(
    data.categories,
    data.profitTransactions.filter((transaction) => transaction.type === "income"),
    data.transactions ?? [],
    data.month,
  );
  const actualSalesReceipts = numberValue(data.summary.receivedIncome) - numberValue(data.summary.otherIncome);
  return [
    { id: -1, name: "실제 매출입금", amount: actualSalesReceipts, details: [] },
    ...otherIncomeRows,
  ].filter((row) => Math.abs(row.amount) >= 0.0005)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

export function buildDashboardReport(
  current: DashboardLedgerData,
  previous: DashboardLedgerData,
) {
  const income = withMonthChange(buildReceivedIncomeRows(current), buildReceivedIncomeRows(previous));
  const expenses = withMonthChange(current.cashReport.expenseBreakdown, previous.cashReport.expenseBreakdown);
  const cashDifference = current.summary.receivedIncome - current.summary.actualCashOutflow;
  const previousCashDifference = previous.summary.receivedIncome - previous.summary.actualCashOutflow;
  return {
    kpis: {
      income: current.summary.receivedIncome,
      expense: current.summary.actualCashOutflow,
      cashDifference,
      operatingProfit: current.summary.operatingProfit,
      incomeChange: percentageChange(current.summary.receivedIncome, previous.summary.receivedIncome),
      expenseChange: percentageChange(current.summary.actualCashOutflow, previous.summary.actualCashOutflow),
      cashDifferenceChange: cashDifferenceChange(cashDifference, previousCashDifference),
      operatingProfitChange: cashDifferenceChange(current.summary.operatingProfit, previous.summary.operatingProfit),
    },
    profitAndLoss: {
      income: current.summary.income,
      expense: current.summary.expense,
      operatingProfit: current.summary.operatingProfit,
    },
    income,
    expenses,
    cashFlow: {
      openingBalance: sumBusinessFundBalances(current.accounts, "openingBalance"),
      receivedIncome: current.summary.receivedIncome,
      investmentCashFlow: numberValue(current.cashReport.investmentCashFlow),
      otherFundAdjustment: numberValue(current.cashReport.otherFundAdjustment),
      actualCashOutflow: current.summary.actualCashOutflow,
      closingBalance: sumBusinessFundBalances(current.accounts, "balance"),
      reconciliationDifference: numberValue(sumBusinessFundBalances(current.accounts, "balance")) -
        (numberValue(sumBusinessFundBalances(current.accounts, "openingBalance")) +
          current.summary.receivedIncome - current.summary.actualCashOutflow +
          numberValue(current.cashReport.investmentCashFlow) + numberValue(current.cashReport.otherFundAdjustment)),
    },
  };
}
