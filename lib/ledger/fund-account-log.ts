import { shortLedgerAccountName } from "./entry-display-account.ts";

// Read-only per-account log for the current-balance KPI cards. Rows are the
// account's own confirmed ledger_movements; nothing here recalculates or
// changes the account balance shown on the card.

export type FundAccountLogRow = {
  movementId: number;
  transactionId: number;
  type: string;
  businessDate: string;
  occurredAt: string;
  // Signed from this account's point of view: + deposit, − withdrawal.
  amount: number;
  memo: string | null;
  partyName: string | null;
  categoryName: string | null;
  // Other fund accounts on the opposite side of the same transaction.
  counterAccounts: string[];
};

type Relation<T> = T | readonly T[] | null | undefined;
const one = <T,>(value: Relation<T>): T | null => (Array.isArray(value) ? (value[0] ?? null) : (value as T | null | undefined) ?? null);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

export type FundAccountMovementSourceRow = {
  id: number | string;
  fund_account_id: number | string;
  amount: number | string;
  transaction?: Relation<{
    id?: number | string;
    type?: unknown;
    business_date?: unknown;
    occurred_at?: unknown;
    memo?: unknown;
    party?: Relation<{ name?: unknown }>;
    category?: Relation<{ name?: unknown }>;
    movements?: ReadonlyArray<{ id?: number | string; fund_account_id?: number | string; amount?: number | string; fund_account?: Relation<{ display_name?: unknown }> }> | null;
  }>;
};

export function fundAccountLogRowsFromMovements(rows: readonly FundAccountMovementSourceRow[], accountId: number): FundAccountLogRow[] {
  const seen = new Set<number>();
  const result: FundAccountLogRow[] = [];
  for (const row of rows) {
    const movementId = Number(row.id);
    const transaction = one(row.transaction);
    // Only this account's movements, each exactly once.
    if (Number(row.fund_account_id) !== accountId || !transaction || seen.has(movementId)) continue;
    seen.add(movementId);
    const amount = Number(row.amount);
    const counterAccounts = [...new Set((transaction.movements ?? [])
      .filter((other) => Number(other.fund_account_id) !== accountId && Math.sign(Number(other.amount)) === -Math.sign(amount))
      .map((other) => text(one(other.fund_account)?.display_name))
      .filter((name): name is string => Boolean(name)))];
    result.push({
      movementId,
      transactionId: Number(transaction.id),
      type: String(transaction.type ?? ""),
      businessDate: String(transaction.business_date ?? ""),
      occurredAt: String(transaction.occurred_at ?? ""),
      amount,
      memo: text(transaction.memo),
      partyName: text(one(transaction.party)?.name),
      categoryName: text(one(transaction.category)?.name),
      counterAccounts,
    });
  }
  return result;
}

const compareChronological = (a: FundAccountLogRow, b: FundAccountLogRow) =>
  a.businessDate.localeCompare(b.businessDate) ||
  (Date.parse(a.occurredAt) || 0) - (Date.parse(b.occurredAt) || 0) ||
  a.transactionId - b.transactionId ||
  a.movementId - b.movementId;

// Money is shown in whole ₫; sums of fractional movements may differ in float noise.
const SAME_AMOUNT = 0.5;

export function buildFundAccountLog(rows: readonly FundAccountLogRow[], openingBalance: number, cardBalance: number) {
  const chronological = [...new Map(rows.map((row) => [row.movementId, row])).values()].sort(compareChronological);
  let running = openingBalance, inflow = 0, outflow = 0;
  const withBalance = chronological.map((row) => {
    running += row.amount;
    if (row.amount > 0) inflow += row.amount;
    else outflow += row.amount;
    return { ...row, balanceAfter: running };
  });
  // The running balance is shown only when the log reconciles exactly with the
  // balance on the card (opening + these movements = card balance).
  const balanceReliable = Math.abs(running - cardBalance) < SAME_AMOUNT;
  return {
    rows: withBalance.reverse().map((row) => ({ ...row, balanceAfter: balanceReliable ? row.balanceAfter : null })),
    inflow,
    outflow,
    net: inflow + outflow,
    balanceReliable,
  };
}

const TYPE_LABELS: Record<string, [string, string]> = {
  sales: ["매출", "Doanh thu"],
  income: ["수입", "Thu nhập"],
  expense: ["지출", "Chi phí"],
  transfer: ["계좌 이체", "Chuyển khoản"],
  payable_payment: ["미지급 결제", "Thanh toán công nợ"],
  payroll_payment: ["급여 지급", "Trả lương"],
  balance_adjustment: ["시재 조정", "Điều chỉnh số dư"],
  card_settlement_deposit: ["카드 정산 입금", "Tiền thẻ về"],
  owner_settlement_payment: ["오너 정산", "Quyết toán chủ"],
  investment: ["투자", "Góp vốn"],
  prepaid_expense_payment: ["선급 비용 지급", "Trả trước chi phí"],
  historical_cash_event: ["과거 자금 · 분류 대기", "Dòng tiền lịch sử · chờ phân loại"],
};

export function fundAccountLogTypeLabel(type: string, lang: "ko" | "vi") {
  const label = TYPE_LABELS[type];
  return label ? label[lang === "vi" ? 1 : 0] : type;
}

// Fallback when the transaction is not an entry of the loaded month list.
export function fundAccountLogFallbackTitle(row: FundAccountLogRow, lang: "ko" | "vi") {
  const memo = row.memo?.split(/\r?\n/)[0]?.trim() || null;
  return row.partyName ?? row.categoryName ?? memo ?? fundAccountLogTypeLabel(row.type, lang);
}

// Transfer direction from this account's side: "→ Cho" when money leaves, "← 현금" when it arrives.
export function fundAccountLogRoute(row: FundAccountLogRow, lang: "ko" | "vi") {
  if (!row.counterAccounts.length || row.amount === 0) return null;
  const names = row.counterAccounts.map((name) => shortLedgerAccountName(name, lang)).join(", ");
  return row.amount < 0 ? `→ ${names}` : `← ${names}`;
}
