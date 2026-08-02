import { supabaseServer } from "@/lib/supabase/server";
import { mapContract } from "@/lib/payroll/db-mappers";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { isMonthFirstDate } from "@/lib/payroll/contract-form";

export const dynamic = "force-dynamic";

function positiveId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const contractId = positiveId(body?.contractId);
  const userId = positiveId(body?.userId);
  const expectedRevision = positiveId(body?.expectedRevision);
  const expectedAuditVersion = positiveId(body?.expectedAuditVersion);
  const baseSalary = Number(body?.baseSalary);
  const fixedRaiseAmount = Number(body?.fixedRaiseAmount ?? 0);
  const standardMinutesPerDay = Number(body?.standardMinutesPerDay);
  const timeBlockMinutes = Number(body?.timeBlockMinutes);
  const standardWorkdays = body?.standardWorkdays === null ? null : Number(body?.standardWorkdays);
  const correctionReason = typeof body?.correctionReason === "string" ? body.correctionReason.trim() : "";
  if (
    !body || !contractId || !userId || !expectedRevision || !expectedAuditVersion
    || !validDate(body.expectedEffectiveFrom) || !validDate(body.effectiveFrom)
    || body.expectedEffectiveFrom !== body.effectiveFrom
    || !["monthly", "daily", "hourly"].includes(String(body.payType))
    || !["minute", "hour", "day", "fixed_monthly"].includes(String(body.calculationBasis))
    || !Number.isSafeInteger(baseSalary) || baseSalary < 0
    || !Number.isSafeInteger(fixedRaiseAmount) || fixedRaiseAmount < 0
    || !Number.isSafeInteger(standardMinutesPerDay) || standardMinutesPerDay < 1 || standardMinutesPerDay > 1440
    || !Number.isSafeInteger(timeBlockMinutes) || timeBlockMinutes < 1 || timeBlockMinutes > 1440
    || (body.payType === "monthly" && (!(standardWorkdays! > 0) || !Number.isFinite(standardWorkdays)))
    || (body.payType !== "monthly" && standardWorkdays !== null)
    || (body.payType === "hourly" && body.calculationBasis === "day")
    || (body.payType !== "monthly" && fixedRaiseAmount !== 0)
  ) return payrollJson({ ok: false, code: body?.expectedEffectiveFrom !== body?.effectiveFrom ? "CONTRACT_EFFECTIVE_FROM_CHANGE_FORBIDDEN" : "INVALID_CONTRACT" }, 400);
  if (!correctionReason) return payrollJson({ ok: false, code: "CONTRACT_CORRECTION_REASON_REQUIRED" }, 400);

  const { data: target, error: targetError } = await supabaseServer
    .from("users")
    .select("id,position,is_active")
    .eq("id", userId)
    .eq("is_system_account", false)
    .eq("is_active", true)
    .maybeSingle();
  if (targetError) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_READ_FAILED" }, 500);
  if (!target) return payrollJson({ ok: false, code: "USER_NOT_FOUND" }, 404);
  const targetIsOwner = String(target.position ?? "").toLowerCase() === "owner";
  if ((targetIsOwner && (body.payType !== "monthly" || body.calculationBasis !== "fixed_monthly")) || (!targetIsOwner && body.calculationBasis === "fixed_monthly")) {
    return payrollJson({ ok: false, code: "INVALID_CONTRACT" }, 400);
  }
  if (targetIsOwner && !isMonthFirstDate(body.effectiveFrom)) {
    return payrollJson({ ok: false, code: "INVALID_FIXED_MONTHLY_EFFECTIVE_DATE" }, 400);
  }

  const { data, error } = await supabaseServer.rpc("payroll_correct_latest_unused_contract_v1", {
    p_contract_id: contractId,
    p_user_id: userId,
    p_expected_revision: expectedRevision,
    p_expected_audit_log_id: expectedAuditVersion,
    p_expected_effective_from: body.expectedEffectiveFrom,
    p_pay_type: body.payType,
    p_calculation_basis: body.calculationBasis,
    p_base_salary: baseSalary,
    p_fixed_raise_amount: fixedRaiseAmount,
    p_standard_workdays: standardWorkdays,
    p_standard_minutes_per_day: standardMinutesPerDay,
    p_time_block_minutes: timeBlockMinutes,
    p_rounding_mode: body.roundingMode,
    p_late_adjustment_mode: body.lateAdjustmentMode,
    p_early_leave_adjustment_mode: body.earlyLeaveAdjustmentMode,
    p_overtime_mode: body.overtimeMode,
    p_paid_leave_mode: body.paidLeaveMode,
    p_effective_from: body.effectiveFrom,
    p_actor_user_id: auth.actor.id,
    p_note: typeof body.note === "string" ? body.note.trim() || null : null,
    p_reason: correctionReason,
  });
  if (error) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_CORRECTION_FAILED" }, 500);
  const result = data as { status?: string; contract?: Record<string, unknown> };
  const statusCodes: Record<string, { code: string; http: number }> = {
    revision_conflict: { code: "CONTRACT_REVISION_CONFLICT", http: 409 },
    not_latest_contract: { code: "CONTRACT_NOT_LATEST", http: 409 },
    effective_from_change_forbidden: { code: "CONTRACT_EFFECTIVE_FROM_CHANGE_FORBIDDEN", http: 409 },
    contract_already_used: { code: "CONTRACT_ALREADY_USED", http: 409 },
    locked_payroll_contract: { code: "CONTRACT_LOCKED_PAYROLL", http: 409 },
    period_conflict: { code: "CONTRACT_PERIOD_CONFLICT", http: 409 },
    correction_reason_required: { code: "CONTRACT_CORRECTION_REASON_REQUIRED", http: 400 },
    fixed_raise_reason_required: { code: "FIXED_RAISE_REASON_REQUIRED", http: 400 },
    forbidden: { code: "CONTRACT_CORRECTION_FORBIDDEN", http: 403 },
    invalid_fixed_monthly_effective_date: { code: "INVALID_FIXED_MONTHLY_EFFECTIVE_DATE", http: 400 },
    invalid_contract: { code: "INVALID_CONTRACT", http: 400 },
    contract_not_found: { code: "CONTRACT_REVISION_CONFLICT", http: 409 },
  };
  if (result.status !== "corrected" || !result.contract) {
    const mapped = statusCodes[String(result.status)] ?? { code: "PAYROLL_CONTRACT_CORRECTION_FAILED", http: 400 };
    return payrollJson({ ok: false, code: mapped.code }, mapped.http);
  }
  return payrollJson({ ok: true, contract: mapContract(result.contract) });
}
