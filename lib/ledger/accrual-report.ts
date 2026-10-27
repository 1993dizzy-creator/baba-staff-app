// Accrual (발생주의) view of a ledger month for the dashboard's operating-profit sheet.
//
// Display only: it regroups the same recognized rows that already make up
// summary.expense / summary.income and never changes a ledger or close amount.
//
// - Operating expenses roll up by top-level category, with child details.
//   Inactive categories (e.g. the retired 보험·복리후생) are included, so a month's
//   breakdown always adds up to its recognized expense.
// - Legacy sheet aggregate corrections (the 2026-08 monthly total #1055 and the
//   offsets that moved its parts into itemized rows) are technical, not operating
//   costs. They are listed separately so a negative "기타 비용" is never shown as
//   an operating category.
// - Revenue corrections are listed with the business dates they belong to when
//   the correction records them (source_snapshot.details).
// - Rent prepayments and reserve allocations are cash/fund movements, not costs.
// - For a closed month, the close snapshot is compared with the current ledger on
//   the month-close basis (sales only; card difference attributed to sale month).

export type AccrualCategory = {
  id: number | string;
  name: string;
  kind: string;
  parent_id: number | string | null;
};

export type AccrualProfitRow = {
  type: string;
  amount: number | string;
  economic_effect_sign?: number | string | null;
  category_id?: number | string | null;
};

export type AccrualCorrectionRow = AccrualProfitRow & {
  id: number | string;
  business_date: string;
  source_type: string;
  source_key?: string | null;
  correction_of_id?: number | string | null;
  memo?: string | null;
  source_snapshot?: Record<string, unknown> | null;
};

export type AccrualReserveEntry = { entry_type: string; amount: number | string };

export type AccrualPrepaidRow = {
  type: string;
  movements?: Array<{ amount?: number | string; fund_account?: { id?: number | string } | null }>;
};

export type AccrualCloseSnapshot = {
  revenue?: { total?: number | string };
  expense?: { total?: number | string; cardAttributionAdjustment?: number | string };
  operatingResult?: { operatingProfit?: number | string };
} | null | undefined;

export type AccrualAmountRow = { id: number; name: string; amount: number };
export type AccrualExpenseRow = AccrualAmountRow & { details: AccrualAmountRow[] };
export type AccrualTechnicalItem = { id: number; date: string; name: string; amount: number; correctionOfId: number | null };
export type AccrualRevenueAdjustment = {
  id: number;
  recordedDate: string;
  name: string;
  amount: number;
  items: Array<{ date: string | null; note: string; amount: number }>;
};
export type AccrualCloseComparison = {
  revision: number | null;
  snapshotOperatingProfit: number;
  revenueChange: number;
  expenseChange: number;
  ledgerChange: number;
  cardAttribution: number;
  otherIncome: number;
  dashboardOperatingProfit: number;
  drift: boolean;
};

export type AccrualReport = {
  expenses: AccrualExpenseRow[];
  operatingExpense: number;
  technical: { total: number; items: AccrualTechnicalItem[] };
  totalExpense: number;
  revenueAdjustments: AccrualRevenueAdjustment[];
  nonExpense: { prepaidPayments: number; reserveAllocated: number; reserveReleased: number };
  close: AccrualCloseComparison | null;
};

const UNCATEGORIZED = { id: -301, name: "분류 미지정" };
const DIRECT = { id: -302, name: "세부분류 없음" };
const EXPENSE_TYPES = new Set(["expense", "expense_recognition"]);
const MONEY_EPSILON = 0.0005;

const num = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
// Ledger money keeps at most 3 decimals; rounding avoids float residue in sums.
const money = (value: number) => Math.round(value * 1000) / 1000;
const signed = (row: AccrualProfitRow) => num(row.amount) * num(row.economic_effect_sign ?? 1);

// Source keys written by the 2026-08 sheet reconciliation and its offsets:
// legacy_sheet_expense_reconciliation:*, legacy_sheet_expense_detail_offset:*,
// legacy-sheet-expense-detail-offset:*.
export function isTechnicalExpenseCorrection(row: Pick<AccrualCorrectionRow, "type" | "source_type" | "source_key">) {
  return EXPENSE_TYPES.has(row.type)
    && row.source_type === "ledger_correction"
    && /^legacy[_-]sheet[_-]expense[_-]/.test(row.source_key ?? "");
}

function categoryPath(categoryId: number, byId: ReadonlyMap<number, AccrualCategory>) {
  const path: AccrualCategory[] = [];
  const visited = new Set<number>();
  let current = byId.get(categoryId);
  while (current && !visited.has(Number(current.id))) {
    path.push(current);
    visited.add(Number(current.id));
    current = current.parent_id == null ? undefined : byId.get(Number(current.parent_id));
  }
  return path;
}

// "정정금액 · 8월 시트 지출 교차검증 보정" → "8월 시트 지출 교차검증 보정"
export function correctionName(memo: string | null | undefined, fallback: string) {
  const parts = String(memo ?? "").split(/\s*·\s*/).map(part => part.trim()).filter(Boolean);
  const meaningful = parts.filter(part => part !== "정정금액");
  return meaningful.join(" · ") || fallback;
}

export function buildAccrualExpenseRows(
  categories: readonly AccrualCategory[],
  profitRows: readonly AccrualProfitRow[],
  technicalRows: readonly AccrualProfitRow[],
) {
  const byId = new Map(categories.map(category => [Number(category.id), category]));
  const amountByCategory = new Map<number | null, number>();
  const addAmount = (categoryId: number | string | null | undefined, amount: number) => {
    const key = categoryId == null ? null : Number(categoryId);
    amountByCategory.set(key, (amountByCategory.get(key) ?? 0) + amount);
  };
  for (const row of profitRows) if (EXPENSE_TYPES.has(row.type)) addAmount(row.category_id, signed(row));
  for (const row of technicalRows) addAmount(row.category_id, -signed(row));

  const tops = new Map<number, AccrualExpenseRow & { detailMap: Map<number, AccrualAmountRow> }>();
  for (const [categoryId, rawAmount] of amountByCategory) {
    const amount = money(rawAmount);
    if (Math.abs(amount) < MONEY_EPSILON) continue;
    const path = categoryId == null ? [] : categoryPath(categoryId, byId);
    const valid = path.length > 0 && path[0].kind === "expense" ? path : [];
    const top = valid.at(-1);
    const topKey = top ? Number(top.id) : UNCATEGORIZED.id;
    const row = tops.get(topKey) ?? { id: topKey, name: top?.name ?? UNCATEGORIZED.name, amount: 0, details: [], detailMap: new Map() };
    row.amount = money(row.amount + amount);
    const child = valid.length > 1 ? valid.at(-2)! : null;
    if (top) {
      const detail = child ? { id: Number(child.id), name: child.name } : DIRECT;
      const item = row.detailMap.get(detail.id) ?? { ...detail, amount: 0 };
      item.amount = money(item.amount + amount);
      row.detailMap.set(detail.id, item);
    }
    tops.set(topKey, row);
  }
  return [...tops.values()]
    .map(({ detailMap, ...row }) => ({
      ...row,
      details: [...detailMap.values()]
        .filter(detail => Math.abs(detail.amount) >= MONEY_EPSILON)
        .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
    }))
    .filter(row => Math.abs(row.amount) >= MONEY_EPSILON)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

function detailDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function buildRevenueAdjustments(rows: readonly AccrualCorrectionRow[]): AccrualRevenueAdjustment[] {
  return rows
    .filter(row => row.type === "sales" && row.source_type === "ledger_correction")
    .map(row => {
      const amount = money(signed(row));
      const recorded = row.source_snapshot?.details;
      const details = Array.isArray(recorded) ? recorded as Array<Record<string, unknown>> : [];
      const items = details
        .filter(detail => Number.isFinite(Number(detail?.delta)))
        .map(detail => ({ date: detailDate(detail.date), note: typeof detail.note === "string" ? detail.note : "", amount: money(num(detail.delta)) }));
      const itemized = money(items.reduce((sum, item) => sum + item.amount, 0));
      // Without recorded dates the whole correction belongs to its own business date;
      // a recorded breakdown that does not add up keeps the remainder visible.
      if (!items.length) items.push({ date: row.business_date, note: "", amount });
      else if (Math.abs(itemized - amount) >= MONEY_EPSILON) items.push({ date: null, note: "잔여 차이", amount: money(amount - itemized) });
      return { id: Number(row.id), recordedDate: row.business_date, name: correctionName(row.memo, "매출 정정"), amount, items };
    })
    .sort((a, b) => a.recordedDate.localeCompare(b.recordedDate) || a.id - b.id);
}

export function buildCloseComparison(
  snapshot: AccrualCloseSnapshot,
  revision: number | null,
  summary: { income: number; otherIncome: number; expense: number; operatingProfit: number },
): AccrualCloseComparison | null {
  if (!snapshot?.operatingResult || !snapshot.revenue || !snapshot.expense) return null;
  const cardAttribution = num(snapshot.expense.cardAttributionAdjustment);
  const salesIncome = num(summary.income) - num(summary.otherIncome);
  const revenueChange = money(salesIncome - num(snapshot.revenue.total));
  // The close total includes the sale-month card attribution, which no ledger row carries.
  const expenseChange = money(num(summary.expense) - (num(snapshot.expense.total) - cardAttribution));
  const ledgerChange = money(revenueChange - expenseChange);
  return {
    revision,
    snapshotOperatingProfit: num(snapshot.operatingResult.operatingProfit),
    revenueChange,
    expenseChange,
    ledgerChange,
    cardAttribution: money(cardAttribution),
    otherIncome: money(num(summary.otherIncome)),
    dashboardOperatingProfit: num(summary.operatingProfit),
    drift: Math.abs(ledgerChange) >= 0.5,
  };
}

export function buildAccrualReport(input: {
  categories: readonly AccrualCategory[];
  profitRows: readonly AccrualProfitRow[];
  corrections: readonly AccrualCorrectionRow[];
  prepaidRows: readonly AccrualPrepaidRow[];
  businessFundAccountIds: ReadonlySet<number>;
  reserveEntries: readonly AccrualReserveEntry[];
  summary: { income: number; otherIncome: number; expense: number; operatingProfit: number };
  closeSnapshot?: AccrualCloseSnapshot;
  closeRevision?: number | null;
}): AccrualReport {
  const technicalRows = input.corrections.filter(isTechnicalExpenseCorrection);
  const expenses = buildAccrualExpenseRows(input.categories, input.profitRows, technicalRows);
  const items = technicalRows
    .map(row => ({
      id: Number(row.id),
      date: row.business_date,
      name: correctionName(row.memo, "장부 정정"),
      amount: money(signed(row)),
      correctionOfId: row.correction_of_id == null ? null : Number(row.correction_of_id),
    }))
    .sort((a, b) => a.id - b.id);
  const technicalTotal = money(items.reduce((sum, item) => sum + item.amount, 0));
  const operatingExpense = money(expenses.reduce((sum, row) => sum + row.amount, 0));
  let prepaidPayments = 0;
  for (const row of input.prepaidRows) {
    if (row.type !== "prepaid_expense_payment") continue;
    for (const movement of row.movements ?? []) {
      if (input.businessFundAccountIds.has(Number(movement.fund_account?.id))) prepaidPayments -= num(movement.amount);
    }
  }
  let reserveAllocated = 0;
  let reserveReleased = 0;
  for (const entry of input.reserveEntries) {
    if (entry.entry_type === "allocate") reserveAllocated += num(entry.amount);
    else if (entry.entry_type === "release" || entry.entry_type === "consume") reserveReleased += num(entry.amount);
  }
  return {
    expenses,
    operatingExpense,
    technical: { total: technicalTotal, items },
    totalExpense: money(operatingExpense + technicalTotal),
    revenueAdjustments: buildRevenueAdjustments(input.corrections),
    nonExpense: { prepaidPayments: money(prepaidPayments), reserveAllocated: money(reserveAllocated), reserveReleased: money(reserveReleased) },
    close: buildCloseComparison(input.closeSnapshot, input.closeRevision ?? null, input.summary),
  };
}
