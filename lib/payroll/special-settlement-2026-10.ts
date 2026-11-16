// 2026-10 payroll special settlement — pure plan validation and preview.
//
// October 2026 salaries were paid outside the APP from the accountant's corrected
// payroll (T10-BABA 정정본). This module validates the PRIVATE settlement plan
// (server-only env, never committed) and compares it with the APP calculation.
// It contains no personal amounts. The DB function payroll_settle_2026_10_v1
// re-validates every rule below; this layer only makes problems visible early.
import { stablePayrollSourceHash } from "./source-export/stable-hash.ts";

export const SPECIAL_SETTLEMENT_MONTH = "2026-10";
export const SPECIAL_SETTLEMENT_MIN_PAYMENT_DATE = "2026-11-01";
export const SPECIAL_SETTLEMENT_MAX_RESIDUAL = 1000;
// October 2026 roster size; the DB function enforces the same constant.
export const SPECIAL_SETTLEMENT_EMPLOYEE_COUNT = 17;

export type SettlementAllocationKind = "salary" | "penalty_refund";
export type SettlementAllocation = { paymentDate: string; fundAccountId: number; amount: number; kind: SettlementAllocationKind; note: string | null };
export type SettlementPlanEmployee = { userId: number; label: string | null; actualPaidAmount: number; allocations: SettlementAllocation[]; note: string | null };
export type SettlementResidual = { paymentDate: string; fundAccountId: number; amount: number; reason: string };
export type SettlementGroup = { paymentDate: string; fundAccountId: number; amount: number };
export type SettlementPlan = {
  version: 1; payrollMonth: typeof SPECIAL_SETTLEMENT_MONTH; sourceTitle: string;
  employees: SettlementPlanEmployee[]; residuals: SettlementResidual[]; expectedGroups: SettlementGroup[]; expectedTotal: number;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
export const groupKeyOf = (group: { paymentDate: string; fundAccountId: number }) => `${group.paymentDate}:${group.fundAccountId}`;

export function parseSettlementPlan(raw: unknown): { ok: true; plan: SettlementPlan; planHash: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["PLAN_NOT_OBJECT"] };
  if (raw.version !== 1) errors.push("PLAN_VERSION");
  if (raw.payrollMonth !== SPECIAL_SETTLEMENT_MONTH) errors.push("PLAN_MONTH");
  const sourceTitle = text(raw.sourceTitle);
  if (!sourceTitle) errors.push("PLAN_SOURCE_TITLE");
  if (!Array.isArray(raw.employees) || raw.employees.length === 0) errors.push("PLAN_EMPLOYEES");
  if (!Array.isArray(raw.residuals)) errors.push("PLAN_RESIDUALS");
  if (!Array.isArray(raw.expectedGroups) || raw.expectedGroups.length === 0) errors.push("PLAN_EXPECTED_GROUPS");
  if (!positiveInt(raw.expectedTotal)) errors.push("PLAN_EXPECTED_TOTAL");
  if (errors.length) return { ok: false, errors };

  const employees: SettlementPlanEmployee[] = [];
  const seenUsers = new Set<number>();
  for (const [index, item] of (raw.employees as unknown[]).entries()) {
    const at = `employees[${index}]`;
    if (!isObject(item) || !positiveInt(item.userId) || !positiveInt(item.actualPaidAmount) || !Array.isArray(item.allocations) || item.allocations.length === 0) {
      errors.push(`${at}:SHAPE`); continue;
    }
    if (seenUsers.has(item.userId)) errors.push(`${at}:DUPLICATE_USER`);
    seenUsers.add(item.userId);
    const allocations: SettlementAllocation[] = [];
    const seenGroups = new Set<string>();
    for (const [allocationIndex, allocation] of (item.allocations as unknown[]).entries()) {
      const where = `${at}.allocations[${allocationIndex}]`;
      if (!isObject(allocation) || !validDate(allocation.paymentDate) || !positiveInt(allocation.fundAccountId) || !positiveInt(allocation.amount)
        || (allocation.kind !== "salary" && allocation.kind !== "penalty_refund")) { errors.push(`${where}:SHAPE`); continue; }
      if (allocation.paymentDate < SPECIAL_SETTLEMENT_MIN_PAYMENT_DATE) errors.push(`${where}:DATE_BEFORE_MONTH_END`);
      const parsed: SettlementAllocation = { paymentDate: allocation.paymentDate, fundAccountId: allocation.fundAccountId, amount: allocation.amount, kind: allocation.kind, note: text(allocation.note) };
      if (seenGroups.has(groupKeyOf(parsed))) errors.push(`${where}:DUPLICATE_GROUP`);
      seenGroups.add(groupKeyOf(parsed));
      allocations.push(parsed);
    }
    if (allocations.filter(allocation => allocation.kind === "salary").length !== 1) errors.push(`${at}:SALARY_ALLOCATION_COUNT`);
    if (allocations.reduce((sum, allocation) => sum + allocation.amount, 0) !== item.actualPaidAmount) errors.push(`${at}:ALLOCATION_SUM`);
    employees.push({ userId: item.userId, label: text(item.label), actualPaidAmount: item.actualPaidAmount, allocations, note: text(item.note) });
  }

  const residuals: SettlementResidual[] = [];
  for (const [index, item] of (raw.residuals as unknown[]).entries()) {
    const at = `residuals[${index}]`;
    if (!isObject(item) || !validDate(item.paymentDate) || !positiveInt(item.fundAccountId) || typeof item.amount !== "number"
      || !Number.isSafeInteger(item.amount) || item.amount === 0 || Math.abs(item.amount) > SPECIAL_SETTLEMENT_MAX_RESIDUAL || !text(item.reason)) {
      errors.push(`${at}:SHAPE`); continue;
    }
    residuals.push({ paymentDate: item.paymentDate, fundAccountId: item.fundAccountId, amount: item.amount, reason: text(item.reason)! });
  }
  if (new Set(residuals.map(groupKeyOf)).size !== residuals.length) errors.push("residuals:DUPLICATE_GROUP");

  const expectedGroups: SettlementGroup[] = [];
  for (const [index, item] of (raw.expectedGroups as unknown[]).entries()) {
    if (!isObject(item) || !validDate(item.paymentDate) || !positiveInt(item.fundAccountId) || !positiveInt(item.amount)) { errors.push(`expectedGroups[${index}]:SHAPE`); continue; }
    expectedGroups.push({ paymentDate: item.paymentDate, fundAccountId: item.fundAccountId, amount: item.amount });
  }
  if (new Set(expectedGroups.map(groupKeyOf)).size !== expectedGroups.length) errors.push("expectedGroups:DUPLICATE_GROUP");
  if (errors.length) return { ok: false, errors };

  // Cash groups must reconcile exactly: allocations + residual = declared outflow.
  const computed = computeGroupTotals(employees, residuals);
  const declared = new Map(expectedGroups.map(group => [groupKeyOf(group), group.amount]));
  for (const [key, amount] of computed) {
    if (!declared.has(key)) errors.push(`group ${key}:UNDECLARED`);
    else if (declared.get(key) !== amount) errors.push(`group ${key}:TOTAL_MISMATCH`);
  }
  for (const key of declared.keys()) if (!computed.has(key)) errors.push(`group ${key}:UNUSED`);
  const expectedSum = expectedGroups.reduce((sum, group) => sum + group.amount, 0);
  if (expectedSum !== raw.expectedTotal) errors.push("PLAN_EXPECTED_TOTAL_MISMATCH");
  const paidSum = employees.reduce((sum, employee) => sum + employee.actualPaidAmount, 0) + residuals.reduce((sum, residual) => sum + residual.amount, 0);
  if (paidSum !== raw.expectedTotal) errors.push("PLAN_PAID_TOTAL_MISMATCH");
  if (errors.length) return { ok: false, errors };

  const plan: SettlementPlan = { version: 1, payrollMonth: SPECIAL_SETTLEMENT_MONTH, sourceTitle: sourceTitle!, employees, residuals, expectedGroups, expectedTotal: raw.expectedTotal as number };
  return { ok: true, plan, planHash: stablePayrollSourceHash(plan) };
}

export function computeGroupTotals(employees: readonly SettlementPlanEmployee[], residuals: readonly SettlementResidual[]) {
  const totals = new Map<string, number>();
  for (const employee of employees) for (const allocation of employee.allocations) totals.set(groupKeyOf(allocation), (totals.get(groupKeyOf(allocation)) ?? 0) + allocation.amount);
  for (const residual of residuals) totals.set(groupKeyOf(residual), (totals.get(groupKeyOf(residual)) ?? 0) + residual.amount);
  return totals;
}

export function settlementDifferenceReason(input: { sourceTitle: string; calculatedNetAmount: number; actualPaidAmount: number; note: string | null }) {
  const difference = input.actualPaidAmount - input.calculatedNetAmount;
  if (difference === 0) return null;
  const sign = difference > 0 ? "+" : "−";
  const base = `2026-10 회계사 정정본(${input.sourceTitle}) 실지급 기준 · APP 계산 ${input.calculatedNetAmount}₫ → 실지급 ${input.actualPaidAmount}₫ (차액 ${sign}${Math.abs(difference)}₫)`;
  return input.note ? `${base} · ${input.note}` : base;
}

export type SettlementCandidate = {
  userId: number; employeeName: string; calculatedNetAmount: number | null; calculationHash: string | null;
  isPayable: boolean; failureCodes: string[]; paymentStatus: "unpaid" | "paid";
};
export type SettlementPreviewRow = {
  userId: number; employeeName: string; calculatedNetAmount: number | null; actualPaidAmount: number; differenceAmount: number | null;
  differenceReason: string | null; allocations: SettlementAllocation[]; paymentStatus: "unpaid" | "paid";
  isPayable: boolean; failureCodes: string[]; calculationHash: string | null;
};

export function buildSettlementPreview(plan: SettlementPlan, planHash: string, candidates: readonly SettlementCandidate[]) {
  const blockers: string[] = [];
  const byUser = new Map(candidates.map(candidate => [candidate.userId, candidate]));
  const planUsers = new Set(plan.employees.map(employee => employee.userId));
  for (const candidate of candidates) if (!planUsers.has(candidate.userId)) blockers.push(`ROSTER_USER_NOT_IN_PLAN:${candidate.userId}`);
  const rows: SettlementPreviewRow[] = [];
  for (const employee of plan.employees) {
    const candidate = byUser.get(employee.userId);
    if (!candidate) { blockers.push(`PLAN_USER_NOT_IN_ROSTER:${employee.userId}`); continue; }
    const calculated = candidate.calculatedNetAmount;
    const payable = candidate.isPayable && calculated !== null && candidate.calculationHash !== null;
    if (candidate.paymentStatus === "unpaid" && !payable) blockers.push(`EMPLOYEE_NOT_PAYABLE:${employee.userId}`);
    rows.push({
      userId: employee.userId, employeeName: candidate.employeeName, calculatedNetAmount: calculated, actualPaidAmount: employee.actualPaidAmount,
      differenceAmount: calculated === null ? null : employee.actualPaidAmount - calculated,
      differenceReason: calculated === null ? null : settlementDifferenceReason({ sourceTitle: plan.sourceTitle, calculatedNetAmount: calculated, actualPaidAmount: employee.actualPaidAmount, note: employee.note }),
      allocations: employee.allocations, paymentStatus: candidate.paymentStatus, isPayable: candidate.isPayable,
      failureCodes: candidate.failureCodes, calculationHash: candidate.calculationHash,
    });
  }
  if (plan.employees.length !== SPECIAL_SETTLEMENT_EMPLOYEE_COUNT) blockers.push(`PLAN_EMPLOYEE_COUNT:${plan.employees.length}`);
  if (candidates.length !== SPECIAL_SETTLEMENT_EMPLOYEE_COUNT) blockers.push(`ROSTER_EMPLOYEE_COUNT:${candidates.length}`);
  const unpaid = rows.filter(row => row.paymentStatus === "unpaid");
  // All-or-nothing: either nobody is recorded yet (settle all) or everyone is (done).
  if (unpaid.length > 0 && unpaid.length < rows.length) blockers.push("BATCH_PARTIALLY_PAID");
  if (blockers.length === 0 && unpaid.length === 0) blockers.push("NOTHING_TO_SETTLE");
  const previewToken = stablePayrollSourceHash({
    planHash,
    rows: unpaid.map(row => ({ userId: row.userId, calculationHash: row.calculationHash, calculatedNetAmount: row.calculatedNetAmount, actualPaidAmount: row.actualPaidAmount })),
  });
  const totals = {
    employeeCount: rows.length,
    unpaidCount: unpaid.length,
    calculatedNetTotal: rows.reduce((sum, row) => sum + (row.calculatedNetAmount ?? 0), 0),
    actualPaidTotal: rows.reduce((sum, row) => sum + row.actualPaidAmount, 0),
    residualTotal: plan.residuals.reduce((sum, residual) => sum + residual.amount, 0),
    cashOutflowTotal: plan.expectedTotal,
  };
  return { rows, blockers, previewToken, totals, groups: plan.expectedGroups, residuals: plan.residuals };
}

export const validSettlementRequestKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:_-]{16,128}$/.test(value);
