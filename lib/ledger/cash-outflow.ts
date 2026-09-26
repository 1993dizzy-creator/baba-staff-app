type CashMovement = {
  amount?: number | string;
  fund_account?: { id?: number | string } | null;
};

export type CashOutflowTransaction = {
  id?: number | string;
  type: string;
  status?: string;
  business_date: string;
  source_type: string;
  source_key?: string | null;
  source_snapshot?: Record<string, unknown> | null;
  memo?: string | null;
  movements?: readonly CashMovement[];
};

const CASH_PAYMENT_TYPES = new Set([
  "expense",
  "payable_payment",
  "payroll_payment",
  "prepaid_expense_payment",
]);

const OPERATING_BALANCE_ADJUSTMENT_PREFIXES = [
  "historical-payable-bridge:",
  "sheet-balance-adjustment:",
];

export const roundLedgerMoney = (amount: number) => Math.round(amount * 1000) / 1000;

export function isTechnicalCashAdjustment(row: CashOutflowTransaction) {
  if (/technical_adjustment/.test(row.source_type)) return true;
  if (/월말\s*잔액\s*맞춤|상세\s*전환\s*상쇄|기술적\s*보정/.test(row.memo ?? "")) return true;
  if (row.type === "balance_adjustment" || row.source_type === "ledger_correction") {
    if (row.source_type === "ledger_correction" &&
      /technical|reversal|rebook/i.test(
        `${row.source_snapshot?.adjustmentType ?? ""} ${row.source_snapshot?.originalSourceType ?? ""}`
      )) return true;
    return /technical_adjustment|reversal|rebook/.test(row.source_key ?? "") ||
      /reversal|rebook|기술적|상쇄/i.test(row.memo ?? "");
  }
  return false;
}

function isOperatingBalanceAdjustment(row: CashOutflowTransaction, businessFundNet: number) {
  return row.type === "balance_adjustment" && businessFundNet < 0 &&
    !row.source_key?.startsWith("owner-capital-recovery:") &&
    OPERATING_BALANCE_ADJUSTMENT_PREFIXES.some((prefix) => row.source_key?.startsWith(prefix));
}

function isOperatingCorrection(row: CashOutflowTransaction, businessFundNet: number) {
  if (row.source_type !== "ledger_correction" || row.type !== "expense" || businessFundNet >= 0) return false;
  if (row.source_snapshot?.adjustmentType === "employee_meal") return true;
  const economicDelta = Number(row.source_snapshot?.economicDelta);
  return Number.isFinite(economicDelta) && economicDelta > 0 &&
    Array.isArray(row.source_snapshot?.movementAdjustments);
}

export function computeActualCashOutflow(
  transactions: readonly CashOutflowTransaction[],
  businessFundAccountIds: ReadonlySet<number>,
  month: string,
) {
  return Math.max(0, roundLedgerMoney(listActualCashOutflowItems(
    transactions,
    businessFundAccountIds,
    month,
  ).reduce((sum, item) => sum + item.amount, 0)));
}

export type ActualCashOutflowItem = {
  transaction: CashOutflowTransaction;
  amount: number;
};

export function businessFundMovementNet(
  row: CashOutflowTransaction,
  businessFundAccountIds: ReadonlySet<number>,
) {
  return roundLedgerMoney((row.movements ?? []).reduce((sum, movement) =>
    businessFundAccountIds.has(Number(movement.fund_account?.id))
      ? sum + Number(movement.amount ?? 0)
      : sum,
  0));
}

export function listActualCashOutflowItems(
  transactions: readonly CashOutflowTransaction[],
  businessFundAccountIds: ReadonlySet<number>,
  month: string,
): ActualCashOutflowItem[] {
  const legacy = transactions.find((row) =>
    row.source_key === `legacy_sheet_expense_reconciliation:${month}` &&
    row.source_snapshot?.sheetCashOutflow != null,
  );
  const sheetCashOutflow = legacy?.source_snapshot?.sheetCashOutflow;
  if (
    (typeof sheetCashOutflow === "number" || (typeof sheetCashOutflow === "string" && sheetCashOutflow.trim() !== "")) &&
    Number.isFinite(Number(sheetCashOutflow)) && Number(sheetCashOutflow) >= 0
  ) return [{ transaction: legacy!, amount: Number(sheetCashOutflow) }];

  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);

  return transactions.flatMap((row): ActualCashOutflowItem[] => {
    if (row.business_date < start || row.business_date >= end || (row.status != null && row.status !== "confirmed")) return [];
    if (isTechnicalCashAdjustment(row)) return [];

    const transactionNet = businessFundMovementNet(row, businessFundAccountIds);
    let included = false;
    if (row.type === "balance_adjustment") {
      included = isOperatingBalanceAdjustment(row, transactionNet);
    } else if (row.source_type === "ledger_correction") {
      included = isOperatingCorrection(row, transactionNet);
    } else {
      included = CASH_PAYMENT_TYPES.has(row.type);
    }
    return included && transactionNet !== 0
      ? [{ transaction: row, amount: roundLedgerMoney(-transactionNet) }]
      : [];
  });
}
