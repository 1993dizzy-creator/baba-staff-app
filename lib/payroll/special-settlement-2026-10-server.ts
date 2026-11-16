import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { loadPayrollOverview } from "@/lib/payroll/overview-server";
import { buildEmployeePaymentSnapshot, payrollPaymentSnapshotHash } from "@/lib/payroll/payment-snapshot";
import { paymentFailureCodes } from "@/lib/payroll/payment-preflight";
import { buildSettlementPreview, parseSettlementPlan, SPECIAL_SETTLEMENT_MONTH, type SettlementCandidate } from "@/lib/payroll/special-settlement-2026-10";

// Server-only env holding the private plan JSON (personal amounts). Never NEXT_PUBLIC_, never committed.
export const SETTLEMENT_PLAN_ENV = "BABA_PAYROLL_SETTLEMENT_2026_10_PLAN_JSON";

export class SettlementError extends Error {
  constructor(public code: string, public status: number, public detail?: Record<string, unknown>) { super(code); }
}

export function loadSettlementPlan() {
  const raw = process.env[SETTLEMENT_PLAN_ENV];
  if (!raw?.trim()) throw new SettlementError("SETTLEMENT_PLAN_NOT_CONFIGURED", 503);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new SettlementError("SETTLEMENT_PLAN_INVALID", 500, { errors: ["PLAN_JSON_PARSE"] }); }
  const parsed = parseSettlementPlan(json);
  if (!parsed.ok) throw new SettlementError("SETTLEMENT_PLAN_INVALID", 500, { errors: parsed.errors });
  return parsed;
}

// Reads the live APP calculation exactly like /api/admin/payroll/payments (same
// overview, preflight, snapshot and hash), for every roster employee at once.
export async function loadSettlementContext() {
  const { plan, planHash } = loadSettlementPlan();
  const month = SPECIAL_SETTLEMENT_MONTH;
  const { data: batch, error: batchError } = await supabaseServer.from("payroll_payment_batches").select("id,status").eq("payroll_month", `${month}-01`).maybeSingle();
  if (batchError) throw batchError;
  const { data: members, error: memberError } = batch
    ? await supabaseServer.from("payroll_employee_payments").select("user_id,payment_status,employee_name,part_snapshot,position_snapshot").eq("payroll_batch_id", batch.id)
    : { data: null, error: null };
  if (memberError) throw memberError;
  const statusByUser = new Map((members ?? []).map(row => [Number(row.user_id), row.payment_status === "paid" ? "paid" as const : "unpaid" as const]));

  const overview = await loadPayrollOverview(month);
  const assessed = overview.employees.map(item => {
    const raw = overview.rawByUser.get(item.userId);
    const calculationDate = typeof raw?.attendanceSnapshot.calculationDate === "string" ? raw.attendanceSnapshot.calculationDate : overview.period.asOfDate;
    const activeContractCount = overview.snapshot.context.contracts.filter(contract => contract.userId === item.userId && contract.effectiveFrom <= calculationDate && (!contract.effectiveTo || contract.effectiveTo > calculationDate)).length;
    const failureCodes = paymentFailureCodes(item, raw, activeContractCount);
    return { userId: item.userId, employeeName: item.name, part: item.part, position: item.position, isPayable: failureCodes.length === 0, failureCodes };
  });
  const targets = batch
    ? (members ?? []).map(member => assessed.find(item => item.userId === Number(member.user_id)) ?? {
      userId: Number(member.user_id), employeeName: member.employee_name, part: member.part_snapshot, position: member.position_snapshot,
      isPayable: false, failureCodes: ["MISSING_SNAPSHOT"] })
    : assessed;

  const snapshots = new Map<number, { snapshot: Record<string, unknown>; hash: string; net: number }>();
  const candidates: SettlementCandidate[] = targets.map(target => {
    const employee = overview.employees.find(item => item.userId === target.userId);
    const raw = overview.rawByUser.get(target.userId);
    let calculationHash: string | null = null;
    if (employee && raw && target.isPayable) {
      const snapshot = buildEmployeePaymentSnapshot(employee, raw, overview.snapshot.sourceSnapshot as Record<string, unknown>);
      calculationHash = payrollPaymentSnapshotHash(snapshot);
      snapshots.set(target.userId, { snapshot: snapshot as unknown as Record<string, unknown>, hash: calculationHash, net: employee.amounts.netPayoutAmount });
    }
    return {
      userId: target.userId, employeeName: target.employeeName,
      calculatedNetAmount: employee && Number.isSafeInteger(employee.amounts.netPayoutAmount) ? employee.amounts.netPayoutAmount : null,
      calculationHash, isPayable: target.isPayable, failureCodes: target.failureCodes,
      paymentStatus: statusByUser.get(target.userId) ?? "unpaid",
    };
  });
  const preview = buildSettlementPreview(plan, planHash, candidates);
  return { plan, planHash, batch, overview, targets, snapshots, preview };
}

export async function executeSettlement(input: { actorUserId: number; previewToken: string; requestKey: string }) {
  const context = await loadSettlementContext();
  const { plan, planHash, overview, targets, snapshots, preview } = context;
  // Every check below runs on a fresh server-side recalculation of ALL roster
  // employees (overview → preflight → snapshot → hash). Nothing calculated by
  // the client is trusted; the client only proves which preview it confirmed.
  if (context.batch) throw new SettlementError(context.batch.status === "completed" ? "PAYROLL_BATCH_COMPLETED" : "PAYROLL_SPECIAL_SETTLEMENT_BATCH_EXISTS", 409);
  if (preview.blockers.length) throw new SettlementError("SETTLEMENT_BLOCKED", 409, { blockers: preview.blockers });
  if (preview.previewToken !== input.previewToken) throw new SettlementError("PAYROLL_CALCULATION_STALE", 409);
  const planByUser = new Map(plan.employees.map(employee => [employee.userId, employee]));
  const payments = preview.rows.filter(row => row.paymentStatus === "unpaid").map(row => {
    const calculated = snapshots.get(row.userId)!;
    const planned = planByUser.get(row.userId)!;
    return {
      userId: row.userId, calculationSnapshot: calculated.snapshot, calculationHash: calculated.hash,
      calculatedNetAmount: calculated.net, actualPaidAmount: planned.actualPaidAmount, differenceReason: row.differenceReason,
      allocations: planned.allocations.map(allocation => ({ paymentDate: allocation.paymentDate, fundAccountId: allocation.fundAccountId, amount: allocation.amount, kind: allocation.kind, note: allocation.note })),
    };
  });
  const { data, error } = await supabaseServer.rpc("payroll_settle_2026_10_v1", {
    p_month: `${SPECIAL_SETTLEMENT_MONTH}-01`, p_targets: targets, p_payments: payments,
    p_residuals: plan.residuals, p_expected_groups: plan.expectedGroups,
    p_request_key: input.requestKey, p_request_hash: preview.previewToken, p_plan_hash: planHash,
    p_actor_user_id: input.actorUserId, p_engine_version: overview.snapshot.sourceSnapshot.engineVersion,
    p_common_settings_snapshot: overview.snapshot.sourceSnapshot, p_director_insurance_amount: overview.directorInsuranceAmount,
  });
  if (error) throw new SettlementError(settlementErrorCode(error.message), settlementErrorStatus(error.message));
  return data as Record<string, unknown>;
}

const KNOWN_CODES = ["PAYROLL_SPECIAL_SETTLEMENT_MONTH_NOT_ALLOWED", "PAYROLL_SPECIAL_SETTLEMENT_REQUEST_CONFLICT",
  "PAYROLL_SPECIAL_SETTLEMENT_REPLAY_STATE_MISMATCH", "PAYROLL_SPECIAL_SETTLEMENT_SCOPE_MISMATCH", "PAYROLL_SPECIAL_SETTLEMENT_BATCH_EXISTS",
  "PAYROLL_SPECIAL_SETTLEMENT_NOT_COMPLETE", "PAYROLL_SPECIAL_SETTLEMENT_PAYMENT_MISMATCH", "PAYROLL_SPECIAL_SETTLEMENT_GROUP_MISMATCH", "PAYROLL_SPECIAL_SETTLEMENT_GROUP_UNDECLARED",
  "PAYROLL_SPECIAL_SETTLEMENT_ALLOCATION_MISMATCH", "PAYROLL_LEDGER_PROJECTION_FAILED", "PAYROLL_COMPANY_COST_SYNC_FAILED", "PAYROLL_EMPLOYEE_ALREADY_PAID",
  "PAYROLL_BATCH_COMPLETED", "PAYROLL_BATCH_TARGET_MISMATCH", "PAYROLL_BATCH_PREFLIGHT_FAILED", "PAYROLL_FUND_ACCOUNT_INVALID", "FIRST_MONTH_POLICY_REVIEW_REQUIRED",
  "PAYROLL_PAYMENT_REASON_REQUIRED", "PAYROLL_INVALID_PAYMENT_REQUEST", "PAYROLL_FORBIDDEN"];
export function settlementErrorCode(message: string) { return KNOWN_CODES.find(code => message.includes(code)) ?? "PAYROLL_SPECIAL_SETTLEMENT_FAILED"; }
function settlementErrorStatus(message: string) {
  const code = settlementErrorCode(message);
  if (code === "PAYROLL_SPECIAL_SETTLEMENT_FAILED" || code === "PAYROLL_COMPANY_COST_SYNC_FAILED") return 500;
  if (code === "PAYROLL_FORBIDDEN") return 403;
  if (code === "PAYROLL_INVALID_PAYMENT_REQUEST" || code === "PAYROLL_FUND_ACCOUNT_INVALID" || code.endsWith("ALLOCATION_MISMATCH") || code.endsWith("GROUP_UNDECLARED") || code.endsWith("SCOPE_MISMATCH")) return 400;
  return 409;
}
