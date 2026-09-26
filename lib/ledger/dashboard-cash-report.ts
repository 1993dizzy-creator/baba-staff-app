import {
  businessFundMovementNet,
  isTechnicalCashAdjustment,
  listActualCashOutflowItems,
  roundLedgerMoney,
  type CashOutflowTransaction,
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
} from "./cash-outflow.ts";

export type CashReportCategory = {
  id: number | string;
  name: string;
  kind: string;
  parent_id: number | string | null;
};

export type CashReportTransaction = CashOutflowTransaction & {
  id: number | string;
  category?: { id?: number | string | null } | null;
};

export type PayableAllocationCategory = {
  paymentTransactionId: number;
  allocatedAmount: number;
  expenseCategoryId: number | null;
};

export type CashBreakdownRow = {
  id: number;
  name: string;
  amount: number;
  details: Array<{ id: number; name: string; amount: number }>;
};

export type DashboardCashReport = {
  expenseBreakdown: CashBreakdownRow[];
  investmentCashFlow: number;
  otherFundAdjustment: number;
  operatingIncomeMovement: number;
};

const FALLBACK = {
  prepaid: { id: -101, name: "선급·기타지출" },
  adjustment: { id: -102, name: "이월·기타조정" },
  other: { id: -103, name: "기타 실제지출" },
};

// Every amount added to a top-level row is also added to exactly one detail,
// so a parent always equals the sum of its details. Without a child category
// the detail names the known cause instead of dropping the amount.
const DETAIL = {
  payroll: { id: -201, name: "급여 지급" },
  unallocatedPayable: { id: -202, name: "미배분 미지급금 지급" },
  prepaid: { id: -203, name: "선급비용 지급" },
  balanceAdjustment: { id: -204, name: "잔액 조정" },
  correction: { id: -205, name: "장부 정정" },
  directParent: { id: -206, name: "세부분류 없음" },
  uncategorized: { id: -207, name: "분류 미지정" },
};

function monthEnd(month: string) {
  const value = new Date(`${month}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 10);
}

function categoryPath(categoryId: number, byId: ReadonlyMap<number, CashReportCategory>) {
  const path: CashReportCategory[] = [];
  const visited = new Set<number>();
  let current = byId.get(categoryId);
  while (current && !visited.has(Number(current.id))) {
    path.push(current);
    visited.add(Number(current.id));
    current = current.parent_id == null ? undefined : byId.get(Number(current.parent_id));
  }
  return path;
}

function snapshotCategoryId(snapshot: Record<string, unknown> | null | undefined) {
  for (const key of ["categoryId", "category_id", "expenseCategoryId", "originalCategoryId"]) {
    const value = Number(snapshot?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function payrollCategory(categories: readonly CashReportCategory[]) {
  return categories.find((category) =>
    category.kind === "expense" && category.parent_id == null && /인건비|급여/.test(category.name),
  );
}

export function buildActualCashExpenseBreakdown(
  transactions: readonly CashReportTransaction[],
  categories: readonly CashReportCategory[],
  allocations: readonly PayableAllocationCategory[],
  businessFundAccountIds: ReadonlySet<number>,
  month: string,
) {
  const byId = new Map(categories.map((category) => [Number(category.id), category]));
  const allocationsByPayment = new Map<number, PayableAllocationCategory[]>();
  for (const allocation of allocations) {
    const rows = allocationsByPayment.get(allocation.paymentTransactionId) ?? [];
    rows.push(allocation);
    allocationsByPayment.set(allocation.paymentTransactionId, rows);
  }
  const rows = new Map<number, CashBreakdownRow & { detailMap: Map<number, { id: number; name: string; amount: number }> }>();
  const add = (categoryId: number | null, amount: number, fallback: { id: number; name: string }, causeDetail?: { id: number; name: string }) => {
    if (Math.abs(amount) < 0.0005) return;
    const path = categoryId == null ? [] : categoryPath(categoryId, byId);
    const validPath = path.length > 0 && path[0].kind === "expense" ? path : [];
    const top = validPath.at(-1);
    const id = top ? Number(top.id) : fallback.id;
    const row = rows.get(id) ?? { id, name: top?.name ?? fallback.name, amount: 0, details: [], detailMap: new Map() };
    row.amount = roundLedgerMoney(row.amount + amount);
    const child = validPath.length > 1 ? validPath.at(-2)! : null;
    const detail = child
      ? { id: Number(child.id), name: child.name }
      : causeDetail ?? (top ? DETAIL.directParent : DETAIL.uncategorized);
    const item = row.detailMap.get(detail.id) ?? { ...detail, amount: 0 };
    item.amount = roundLedgerMoney(item.amount + amount);
    row.detailMap.set(detail.id, item);
    rows.set(id, row);
  };

  const payroll = payrollCategory(categories);
  for (const item of listActualCashOutflowItems(transactions, businessFundAccountIds, month)) {
    const transaction = item.transaction as CashReportTransaction;
    if (transaction.type === "payable_payment") {
      const paymentAllocations = allocationsByPayment.get(Number(transaction.id)) ?? [];
      let allocated = 0;
      for (const allocation of paymentAllocations) {
        add(allocation.expenseCategoryId, allocation.allocatedAmount, FALLBACK.other);
        allocated += allocation.allocatedAmount;
      }
      add(null, roundLedgerMoney(item.amount - allocated), FALLBACK.other, DETAIL.unallocatedPayable);
      continue;
    }
    if (transaction.type === "payroll_payment") {
      add(payroll ? Number(payroll.id) : null, item.amount, { id: -104, name: "인건비" }, DETAIL.payroll);
      continue;
    }
    const directCategoryId = Number(transaction.category?.id);
    const safeCategoryId = Number.isFinite(directCategoryId) && directCategoryId > 0
      ? directCategoryId
      : snapshotCategoryId(transaction.source_snapshot);
    if (transaction.type === "prepaid_expense_payment") {
      add(safeCategoryId, item.amount, FALLBACK.prepaid, DETAIL.prepaid);
    } else if (transaction.type === "balance_adjustment" || transaction.source_type === "ledger_correction") {
      add(safeCategoryId, item.amount, FALLBACK.adjustment, transaction.type === "balance_adjustment" ? DETAIL.balanceAdjustment : DETAIL.correction);
    } else {
      add(safeCategoryId, item.amount, FALLBACK.other);
    }
  }

  return [...rows.values()]
    .map(({ detailMap, ...row }) => ({
      ...row,
      details: [...detailMap.values()].filter((detail) => Math.abs(detail.amount) >= 0.0005).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
    }))
    .filter((row) => Math.abs(row.amount) >= 0.0005)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

export function computeDashboardFundFlows(
  transactions: readonly CashReportTransaction[],
  businessFundAccountIds: ReadonlySet<number>,
  month: string,
) {
  const start = `${month}-01`;
  const end = monthEnd(month);
  const outflowIds = new Set(listActualCashOutflowItems(transactions, businessFundAccountIds, month)
    .map((item) => Number(item.transaction.id)));
  let investmentCashFlow = 0;
  let otherFundAdjustment = 0;
  let operatingIncomeMovement = 0;
  for (const transaction of transactions) {
    if (transaction.business_date < start || transaction.business_date >= end ||
      (transaction.status != null && transaction.status !== "confirmed") || isTechnicalCashAdjustment(transaction)) continue;
    const net = businessFundMovementNet(transaction, businessFundAccountIds);
    if (net === 0 || outflowIds.has(Number(transaction.id))) continue;
    if (transaction.source_type === "owner_investment" || transaction.type === "investment" ||
      transaction.source_key?.startsWith("owner-capital-recovery:")) {
      investmentCashFlow += net;
    } else if (["sales", "income", "card_settlement_deposit"].includes(transaction.type)) {
      operatingIncomeMovement += net;
    } else if (transaction.type !== "transfer" && transaction.type !== "opening") {
      otherFundAdjustment += net;
    }
  }
  return {
    investmentCashFlow: roundLedgerMoney(investmentCashFlow),
    otherFundAdjustment: roundLedgerMoney(otherFundAdjustment),
    operatingIncomeMovement: roundLedgerMoney(operatingIncomeMovement),
  };
}

export function buildDashboardCashReport(
  transactions: readonly CashReportTransaction[],
  categories: readonly CashReportCategory[],
  allocations: readonly PayableAllocationCategory[],
  businessFundAccountIds: ReadonlySet<number>,
  month: string,
  balanceAccountIds: ReadonlySet<number> = businessFundAccountIds,
): DashboardCashReport {
  return {
    expenseBreakdown: buildActualCashExpenseBreakdown(transactions, categories, allocations, businessFundAccountIds, month),
    ...computeDashboardFundFlows(transactions, balanceAccountIds, month),
  };
}
