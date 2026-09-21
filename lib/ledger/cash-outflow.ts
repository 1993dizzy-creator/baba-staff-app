type CashMovement = {
  amount?: number | string;
  fund_account?: { id?: number | string } | null;
};

export type CashOutflowTransaction = {
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
  "owner_settlement_payment",
]);

const roundMoney = (amount: number) => Math.round(amount * 1000) / 1000;

export function computeActualCashOutflow(
  transactions: readonly CashOutflowTransaction[],
  businessFundAccountIds: ReadonlySet<number>,
  month: string,
) {
  const legacy = transactions.find((row) =>
    row.source_key === `legacy_sheet_expense_reconciliation:${month}` &&
    row.source_snapshot?.sheetCashOutflow != null,
  );
  const sheetCashOutflow = legacy?.source_snapshot?.sheetCashOutflow;
  if (
    (typeof sheetCashOutflow === "number" || (typeof sheetCashOutflow === "string" && sheetCashOutflow.trim() !== "")) &&
    Number.isFinite(Number(sheetCashOutflow)) && Number(sheetCashOutflow) >= 0
  ) return Number(sheetCashOutflow);

  const start = `${month}-01`;
  const endDate = new Date(`${start}T00:00:00Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.toISOString().slice(0, 10);

  const businessFundNet = transactions.reduce((total, row) => {
    if (row.business_date < start || row.business_date >= end || (row.status != null && row.status !== "confirmed")) return total;
    if (!CASH_PAYMENT_TYPES.has(row.type) || row.source_type === "ledger_correction") return total;
    if (/technical_adjustment/.test(row.source_type)) return total;
    if (/월말\s*잔액\s*맞춤|상세\s*전환\s*상쇄|기술적\s*보정/.test(row.memo ?? "")) return total;

    const transactionNet = roundMoney((row.movements ?? []).reduce((sum, movement) =>
      businessFundAccountIds.has(Number(movement.fund_account?.id))
        ? sum + Number(movement.amount ?? 0)
        : sum,
    0));
    return total + transactionNet;
  }, 0);
  return Math.max(0, roundMoney(-businessFundNet));
}
