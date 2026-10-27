// Recurring expenses (e.g. store rent): monthly accrual recognitions booked by the
// deployed RPCs ledger_create_recurring_plan_version_v1 / ledger_sync_recurring_expenses_v2.
//
// - A recognition is an expense_recognition with source key recurring:<planId>:<YYYY-MM>
//   and no fund movement. Cash (e.g. a rent prepayment) and reserve allocations are
//   separate records and are never created or changed here.
// - The database decides closed months: sync v2 creates nothing in a closed month and
//   the ledger month guard rejects any closed-month insert. The API only reports it.
// - A close preflight blocks with RECURRING_NOT_SYNCED while an active plan has no
//   recognition (confirmed or cancelled) for that month.

export type RecurringPlanRow = {
  id: number | string;
  name: string;
  category_id: number | string;
  amount: number | string;
  recognition_day: number | string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  source_key_prefix: string;
  memo?: string | null;
};

export type RecurringRecognitionRow = {
  id: number | string;
  source_key: string | null;
  status: string;
  amount: number | string;
  recognition_month: string | null;
};

export type ClosureRow = { month: string; status: string };

export type RecurringMonthItem = {
  planId: number;
  planName: string;
  amount: number;
  transactionId: number | null;
  status: "recognized" | "cancelled" | "missing";
};

export type RecurringMonthStatus = {
  month: string;
  closure: "open" | "closed" | "reopened";
  items: RecurringMonthItem[];
  missingCount: number;
};

export type CreatePlanInput = {
  name: string;
  categoryId: number;
  amount: number;
  recognitionDay: number;
  effectiveFrom: string;
  sourceKeyPrefix: string;
  memo: string | null;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PREFIX = /^[a-z0-9_-]{1,40}$/;
export const MAX_STATUS_MONTHS = 24;

export const validRecurringMonth = (value: unknown): value is string => typeof value === "string" && MONTH.test(value);

export function recurringSourceKey(planId: number | string, month: string) {
  return `recurring:${Number(planId)}:${month}`;
}

export function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

// Inclusive month list, capped to the most recent MAX_STATUS_MONTHS months.
export function monthRange(from: string, through: string) {
  if (!validRecurringMonth(from) || !validRecurringMonth(through) || from > through) return [];
  const months: string[] = [];
  for (let month = through; month >= from && months.length < MAX_STATUS_MONTHS; month = shiftMonth(month, -1)) months.push(month);
  return months.reverse();
}

// Same window as the sync RPC and the preflight: active, effective_from <= month <= effective_to.
export function planAppliesTo(plan: RecurringPlanRow, month: string) {
  const start = `${month}-01`;
  return plan.is_active && plan.effective_from <= start && (plan.effective_to == null || plan.effective_to >= start);
}

export function buildRecurringMonthStatuses(
  plans: readonly RecurringPlanRow[],
  recognitions: readonly RecurringRecognitionRow[],
  closures: readonly ClosureRow[],
  months: readonly string[],
): RecurringMonthStatus[] {
  const bySourceKey = new Map(recognitions.filter(row => row.source_key).map(row => [row.source_key!, row]));
  const closureByMonth = new Map(closures.map(row => [row.month.slice(0, 7), row.status]));
  return months.map(month => {
    const items = plans.filter(plan => planAppliesTo(plan, month)).map((plan): RecurringMonthItem => {
      const recognition = bySourceKey.get(recurringSourceKey(plan.id, month));
      return {
        planId: Number(plan.id),
        planName: plan.name,
        amount: Number(recognition?.amount ?? plan.amount),
        transactionId: recognition ? Number(recognition.id) : null,
        status: !recognition ? "missing" : recognition.status === "cancelled" ? "cancelled" : "recognized",
      };
    });
    const closure = closureByMonth.get(month);
    return {
      month,
      closure: closure === "closed" || closure === "reopened" ? closure : "open",
      items,
      missingCount: items.filter(item => item.status === "missing").length,
    };
  });
}

export function parseCreatePlanBody(body: Record<string, unknown> | null): { ok: true; value: CreatePlanInput } | { ok: false; code: string } {
  if (!body) return { ok: false, code: "INVALID_BODY" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const categoryId = Number(body.categoryId);
  const amount = Number(body.amount);
  const recognitionDay = Number(body.recognitionDay);
  const prefix = typeof body.sourceKeyPrefix === "string" ? body.sourceKeyPrefix.trim() : "";
  if (!name || name.length > 120) return { ok: false, code: "INVALID_NAME" };
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) return { ok: false, code: "INVALID_CATEGORY" };
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 1000) !== amount * 1000) return { ok: false, code: "INVALID_AMOUNT" };
  if (!Number.isInteger(recognitionDay) || recognitionDay < 1 || recognitionDay > 31) return { ok: false, code: "INVALID_RECOGNITION_DAY" };
  if (!validRecurringMonth(body.effectiveFrom)) return { ok: false, code: "INVALID_EFFECTIVE_FROM" };
  if (!PREFIX.test(prefix)) return { ok: false, code: "INVALID_SOURCE_KEY_PREFIX" };
  const memo = typeof body.memo === "string" && body.memo.trim() ? body.memo.trim() : null;
  return { ok: true, value: { name, categoryId, amount, recognitionDay, effectiveFrom: body.effectiveFrom, sourceKeyPrefix: prefix, memo } };
}

// A second active plan in the same category (other than a new version of the same
// prefix) would recognize the same cost twice, e.g. two 50M rents in one month.
export function conflictingCategoryPlan(plans: readonly RecurringPlanRow[], input: Pick<CreatePlanInput, "categoryId" | "sourceKeyPrefix" | "effectiveFrom">) {
  const start = `${input.effectiveFrom}-01`;
  return plans.find(plan => plan.is_active
    && Number(plan.category_id) === input.categoryId
    && plan.source_key_prefix !== input.sourceKeyPrefix
    && (plan.effective_to == null || plan.effective_to >= start)) ?? null;
}
