// @ts-expect-error Node's local strip-types test runner requires the extension.
import { isPayrollEligible, type PayrollEligibilityUser } from "../payroll/eligibility.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { getPartKey, type PartValue } from "../common/parts.ts";

// Input contract for POST /api/admin/ledger/payroll-advances. The employee is
// always a real users.id; no category or party is accepted because an advance
// is a payroll_payment, not a P&L expense.
export type PayrollAdvanceInput = {
  // Client-generated UUID; the idempotency key of one advance request.
  requestId: string;
  userId: number;
  amount: number;
  occurredAt: string;
  fromAccountId: number;
  memo: string | null;
};

const ALLOWED_KEYS = new Set(["requestId", "userId", "amount", "occurredAt", "fromAccountId", "memo"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function positiveId(value: unknown) {
  const result = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function parsePayrollAdvanceInput(body: unknown): PayrollAdvanceInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !ALLOWED_KEYS.has(key))) return null;
  const requestId = typeof record.requestId === "string" && UUID.test(record.requestId) ? record.requestId.toLowerCase() : null;
  const userId = positiveId(record.userId);
  const fromAccountId = positiveId(record.fromAccountId);
  const amount = typeof record.amount === "number" ? record.amount : NaN;
  const occurredAt = typeof record.occurredAt === "string" && OCCURRED_AT.test(record.occurredAt) && !Number.isNaN(Date.parse(record.occurredAt))
    ? record.occurredAt : null;
  if (record.memo !== undefined && record.memo !== null && typeof record.memo !== "string") return null;
  const memo = typeof record.memo === "string" ? record.memo.trim().slice(0, 500) || null : null;
  if (!requestId || !userId || !fromAccountId || !occurredAt || !Number.isSafeInteger(amount) || amount < 1) return null;
  return { requestId, userId, amount, occurredAt, fromAccountId, memo };
}

// Source keys written by ledger_create_payroll_advance_payment_v1. Historical
// rows keep their original payroll-advance-payment:<date>:user:<id> keys.
export function ledgerPayrollAdvanceTransactionSourceKey(businessDate: string, userId: number, requestId: string) {
  return `payroll-advance-payment:${businessDate}:user:${userId}:${requestId}`;
}

export function ledgerPayrollAdvanceAdjustmentSourceKey(requestId: string) {
  return `ledger-payroll-advance:${requestId}`;
}

export function isLedgerPayrollAdvanceSourceKey(sourceKey: string | null | undefined) {
  return typeof sourceKey === "string" && sourceKey.startsWith("ledger-payroll-advance:");
}

export function payrollAdvanceErrorStatus(status: string) {
  if (status === "forbidden") return 403;
  if (status === "request_conflict" || status === "payroll_locked" || status === "month_closed") return 409;
  if (status === "employee_not_found") return 404;
  return 400;
}

export type PayrollAdvanceEmployeeRow = PayrollEligibilityUser & {
  id: number;
  name: string | null;
  full_name: string | null;
  username: string;
  is_active: boolean;
  attendance_tracking_enabled: boolean;
  part: string | null;
};

export function payrollAdvanceEmployees(rows: readonly PayrollAdvanceEmployeeRow[]) {
  return rows
    .filter(row => row.is_active && row.attendance_tracking_enabled === true && isPayrollEligible(row))
    .map(row => ({ userId: Number(row.id), name: (row.name?.trim() || row.full_name?.trim() || row.username), part: row.part }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type PayrollAdvanceEmployee = ReturnType<typeof payrollAdvanceEmployees>[number];

const ADVANCE_PART_ORDER: readonly PartValue[] = ["kitchen", "hall", "bar", "cleaning", "owner", "etc"];

export function groupPayrollAdvanceEmployees(employees: readonly PayrollAdvanceEmployee[]) {
  return ADVANCE_PART_ORDER.map(part => ({
    part,
    employees: employees.filter(employee => getPartKey(employee.part) === part)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter(group => group.employees.length > 0);
}

// A ledger-created advance transaction key ends with its request UUID; the
// historical payroll-advance-payment:<date>:user:<id> keys do not, and so are
// not cancellable from the ledger.
const LEDGER_ADVANCE_TRANSACTION_KEY = /^payroll-advance-payment:\d{4}-\d{2}-\d{2}:user:\d+:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function ledgerPayrollAdvanceRequestId(row: { type: string; source_type: string; source_key?: string | null }) {
  if (row.type !== "payroll_payment" || row.source_type !== "manual") return null;
  return LEDGER_ADVANCE_TRANSACTION_KEY.exec(row.source_key ?? "")?.[1] ?? null;
}

export const PAYROLL_ADVANCE_REVERSAL_SOURCE_TYPE = "payroll_advance_payment_reversal";

export function parsePayrollAdvanceCancelInput(transactionId: string, body: unknown) {
  const id = /^\d+$/.test(transactionId) ? Number(transactionId) : NaN;
  if (!Number.isSafeInteger(id) || id < 1 || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "reason") || typeof record.reason !== "string" || !record.reason.trim()) return null;
  return { transactionId: id, reason: record.reason.trim().slice(0, 500) };
}

export function payrollAdvanceCancelErrorStatus(status: string) {
  if (status === "forbidden") return 403;
  if (status === "not_found") return 404;
  if (status === "month_closed" || status === "payroll_locked" || status === "invalid_state") return 409;
  return 400;
}
