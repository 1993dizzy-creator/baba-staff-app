// Pure helpers for the rent management screen. Display only: nothing here books a
// transaction. Monthly rent expense stays the recurring plan's expense_recognition rows.

export type RentContract = {
  id: number;
  name: string;
  lessor_name: string | null;
  period_start: string;
  period_end: string;
  annual_amount: number | string;
  monthly_expense_amount: number | string | null;
  status: "planned" | "active" | "ended";
  terms_status: "provisional" | "confirmed";
  payment_method: "lump_sum" | "installments" | "other" | null;
  payment_due_date: string | null;
  payment_terms_note: string | null;
  recurring_plan_id: number | null;
  reserve_plan_id: number | null;
  memo: string | null;
};

export type RentPayment = {
  id: number;
  contract_id: number;
  source: "ledger" | "pre_ledger";
  payment_transaction_id: number | null;
  pre_ledger_reference: string | null;
  paid_on: string;
  amount: number | string;
  fund_account_id: number | null;
  memo: string | null;
};

export type RentRecognition = { id: number; recognition_month: string; amount: number | string; economic_effect_sign?: number | string | null };

// recognized  — the month's rent expense is in the ledger (P&L)
// pre_ledger  — the month is before the app ledger opened (July 2026): shown as
//               "원장 이관 전 사용분"; no ledger row is created for it here. A later
//               full July migration that books it turns the month into "recognized".
// missing     — a ledger month (up to now) without a recognition yet (sync pending)
// upcoming    — a future month
export type RentUsageStatus = "recognized" | "pre_ledger" | "missing" | "upcoming";

export function monthsBetween(start: string, end: string) {
  const months: string[] = [];
  let [year, month] = start.slice(0, 7).split("-").map(Number);
  const last = end.slice(0, 7);
  for (let guard = 0; guard < 240; guard += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > last) break;
    months.push(key);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

export function buildRentUsageSchedule(input: {
  contract: Pick<RentContract, "period_start" | "period_end" | "monthly_expense_amount">;
  recognitions: readonly RentRecognition[];
  ledgerStartMonth: string | null;
  currentMonth: string;
}) {
  const planned = input.contract.monthly_expense_amount == null ? null : Number(input.contract.monthly_expense_amount);
  return monthsBetween(input.contract.period_start, input.contract.period_end).map(month => {
    const rows = input.recognitions.filter(row => row.recognition_month.slice(0, 7) === month);
    const recognized = rows.reduce((sum, row) => sum + Number(row.amount) * Number(row.economic_effect_sign ?? 1), 0);
    const status: RentUsageStatus = rows.length && recognized !== 0
      ? "recognized"
      : input.ledgerStartMonth !== null && month < input.ledgerStartMonth
        ? "pre_ledger"
        : month <= input.currentMonth ? "missing" : "upcoming";
    return {
      month,
      status,
      amount: status === "recognized" ? recognized : planned,
      transactionIds: rows.map(row => Number(row.id)),
    };
  });
}

export function rentPaymentSummary(contract: Pick<RentContract, "annual_amount">, payments: readonly Pick<RentPayment, "source" | "amount">[]) {
  const sum = (rows: readonly Pick<RentPayment, "amount">[]) => rows.reduce((total, row) => total + Number(row.amount), 0);
  const paid = sum(payments);
  return {
    contractAmount: Number(contract.annual_amount),
    paid,
    ledgerPaid: sum(payments.filter(row => row.source === "ledger")),
    preLedgerPaid: sum(payments.filter(row => row.source === "pre_ledger")),
    remaining: Math.max(0, Number(contract.annual_amount) - paid),
  };
}

// Reserve progress toward the next contract, warning only (never changes the monthly
// amount). Months left = recurring allocations still to come before the target month:
// the current month counts only while its allocation is not yet resolved.
export function rentReserveOutlook(input: { targetAmount: number; currentAmount: number; monthlyAmount: number | null; targetDate: string | null; currentMonth: string; currentMonthDone: boolean }) {
  const monthsLeft = input.targetDate
    ? Math.max(0, monthsBetween(`${input.currentMonth}-01`, input.targetDate).length - 1 - (input.currentMonthDone ? 1 : 0))
    : null;
  const projected = monthsLeft === null || input.monthlyAmount === null ? null : input.currentAmount + monthsLeft * input.monthlyAmount;
  return {
    shortfallNow: Math.max(0, input.targetAmount - input.currentAmount),
    monthsLeft,
    projected,
    projectedShortfall: projected === null ? null : Math.max(0, input.targetAmount - projected),
  };
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const optionalText = (value: unknown, max: number) =>
  value == null || value === "" ? null : typeof value === "string" && value.trim().length <= max ? value.trim() || null : undefined;
const optionalId = (value: unknown) =>
  value == null || value === "" ? null : Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const money = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && Math.round(value * 1000) === value * 1000 ? value : undefined;

// Body of a contract save → the ledger_save_rent_contract_v1 payload, or null when invalid.
// Unconfirmed terms stay null/provisional: nothing is filled in on the user's behalf.
export function parseRentContractPayload(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const periodStart = typeof value.periodStart === "string" && DATE.test(value.periodStart) ? value.periodStart : null;
  const periodEnd = typeof value.periodEnd === "string" && DATE.test(value.periodEnd) ? value.periodEnd : null;
  const paymentDueDate = value.paymentDueDate == null || value.paymentDueDate === ""
    ? null : typeof value.paymentDueDate === "string" && DATE.test(value.paymentDueDate) ? value.paymentDueDate : undefined;
  const name = optionalText(value.name, 120);
  const annualAmount = money(value.annualAmount);
  const monthlyExpenseAmount = value.monthlyExpenseAmount == null || value.monthlyExpenseAmount === "" ? null : money(value.monthlyExpenseAmount);
  const status = ["planned", "active", "ended"].includes(String(value.status)) ? String(value.status) : null;
  const termsStatus = value.termsStatus == null ? "provisional" : ["provisional", "confirmed"].includes(String(value.termsStatus)) ? String(value.termsStatus) : null;
  const paymentMethod = value.paymentMethod == null || value.paymentMethod === ""
    ? null : ["lump_sum", "installments", "other"].includes(String(value.paymentMethod)) ? String(value.paymentMethod) : undefined;
  const fields = {
    name, lessorName: optionalText(value.lessorName, 120), periodStart, periodEnd, annualAmount, monthlyExpenseAmount,
    status, termsStatus, paymentMethod, paymentDueDate, paymentTermsNote: optionalText(value.paymentTermsNote, 500),
    recurringPlanId: optionalId(value.recurringPlanId), reservePlanId: optionalId(value.reservePlanId), memo: optionalText(value.memo, 500),
  };
  if (!name || !periodStart || !periodEnd || periodEnd < periodStart || !status || !termsStatus) return null;
  if (Object.values(fields).some(field => field === undefined)) return null;
  return fields;
}
