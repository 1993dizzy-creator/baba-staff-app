import { supabaseServer } from "@/lib/supabase/server";
import { mapContract } from "@/lib/payroll/db-mappers";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { applyEmployeeLevelProgramVersion, getEmployeeLevelInfo, loadEmployeeLevelProgramVersions } from "@/lib/employee-level/server";
import { isMonthFirstDate, resolveFixedRaiseReason } from "@/lib/payroll/contract-form";
import { mapSchedule } from "@/lib/payroll/db-mappers";
import { scheduledMinutesPerDay } from "@/lib/payroll/work-schedule";
import { requiresFixedMonthlyContract } from "@/lib/payroll/eligibility";

export const dynamic = "force-dynamic";
const FIELDS = "id,user_id,pay_type,calculation_basis,base_salary,fixed_raise_amount,standard_workdays,standard_minutes_per_day,time_block_minutes,rounding_mode,late_adjustment_mode,early_leave_adjustment_mode,overtime_mode,paid_leave_mode,effective_from,effective_to,revision,created_by,created_at,note";

function validId(value: unknown) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const userId = validId(new URL(request.url).searchParams.get("userId"));
  if (!userId) return payrollJson({ ok: false, code: "INVALID_USER_ID" }, 400);
  const [{ data: user, error: userError }, { data, error }, { data: auditData, error: auditError }, { data: scheduleData, error: scheduleError }] = await Promise.all([
    supabaseServer.from("users").select("id,name,full_name,username,is_active,hire_date,termination_date,is_system_account,role,level_program_enabled,level_base_date_override").eq("id", userId).eq("is_system_account",false).maybeSingle(),
    supabaseServer.from("payroll_contract_versions").select(FIELDS).eq("user_id", userId).order("effective_from", { ascending: false }),
    supabaseServer.from("payroll_contract_audit_logs").select("id,contract_version_id,action,actor_user_id,reason,created_at").eq("user_id", userId).order("id", { ascending: true }),
    supabaseServer.from("employee_work_schedule_versions").select("id,user_id,start_time,end_time,unpaid_break_minutes,effective_from,effective_to,revision,change_reason").eq("user_id", userId).order("effective_from", { ascending: false }),
  ]);
  if (userError || error || auditError || scheduleError) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_READ_FAILED" }, 500);
  if (!user) return payrollJson({ ok: false, code: "USER_NOT_FOUND" }, 404);
  const actorIds = [...new Set([
    ...(data ?? []).map((row) => Number(row.created_by)),
    ...(auditData ?? []).map((row) => Number(row.actor_user_id)),
  ].filter(Number.isSafeInteger))];
  const { data: actorData, error: actorError } = actorIds.length
    ? await supabaseServer.from("users").select("id,name,full_name,username").in("id", actorIds)
    : { data: [], error: null };
  if (actorError) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_READ_FAILED" }, 500);
  const actorNames = new Map((actorData ?? []).map((actor) => [
    Number(actor.id),
    String(actor.name || actor.full_name || actor.username || "").trim() || null,
  ]));
  const auditsByContract = new Map<number, Array<{ id: number; action: string; actorUserId: number; actorName: string | null; reason: string | null; createdAt: string }>>();
  for (const audit of auditData ?? []) {
    const contractId = Number(audit.contract_version_id);
    const list = auditsByContract.get(contractId) ?? [];
    const actorUserId = Number(audit.actor_user_id);
    list.push({ id: Number(audit.id), action: String(audit.action), actorUserId, actorName: actorNames.get(actorUserId) ?? null, reason: audit.reason ? String(audit.reason) : null, createdAt: String(audit.created_at) });
    auditsByContract.set(contractId, list);
  }
  const contracts = (data ?? []).map((row) => {
    const contract = mapContract(row as Record<string, unknown>);
    const auditLogs = auditsByContract.get(contract.id) ?? [];
    return { ...contract, createdByName: contract.createdBy ? actorNames.get(contract.createdBy) ?? null : null, auditVersion: auditLogs.at(-1)?.id ?? null, auditLogs };
  });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const versions = await loadEmployeeLevelProgramVersions([Number(user.id)], today);
  const levelUser = applyEmployeeLevelProgramVersion(user, versions.get(Number(user.id)));
  return payrollJson({ ok: true, user: { ...levelUser, levelInfo: getEmployeeLevelInfo(levelUser, today) }, current: contracts.find((c) => c.effectiveFrom <= today && (!c.effectiveTo || c.effectiveTo > today)) ?? null, scheduled: contracts.find((c) => c.effectiveFrom > today) ?? null, history: contracts, workSchedules: (scheduleData ?? []).map((row) => mapSchedule(row as Record<string, unknown>)) });
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const fixedRaiseAmount = Number(body?.fixedRaiseAmount ?? 0);
  if (!body || !validId(body.userId) || !["minute","fixed_monthly"].includes(String(body.calculationBasis)) || !["monthly","daily","hourly"].includes(String(body.payType)) || !Number.isSafeInteger(Number(body.baseSalary)) || Number(body.baseSalary) < 0 || !Number.isSafeInteger(fixedRaiseAmount) || fixedRaiseAmount < 0 || (body.payType !== "monthly" && fixedRaiseAmount !== 0)) return payrollJson({ ok: false, code: "INVALID_CONTRACT" }, 400);
  const { data: target } = await supabaseServer.from("users").select("id,role,is_active,attendance_tracking_enabled").eq("id",validId(body.userId)!).eq("is_system_account",false).eq("is_active",true).maybeSingle();
  if(!target)return payrollJson({ok:false,code:"USER_NOT_FOUND"},404);
  // owner/master이거나(기존과 동일) 근태 기록을 쓰지 않는 직원(예: 회계·마케팅처럼 근무시간
  // version 자체가 없는 직원)은 월 고정급(monthly + fixed_monthly)만 허용하고 근무시간
  // 검증을 건너뛴다. attendance_tracking_enabled=false여도 role은 staff/manager/leader
  // 그대로 유지된다 — 여기서 권한을 바꾸지 않는다.
  const targetUsesFixedMonthly = requiresFixedMonthlyContract(target.role, target.attendance_tracking_enabled);
  if ((targetUsesFixedMonthly && (body.payType !== "monthly" || body.calculationBasis !== "fixed_monthly")) || (!targetUsesFixedMonthly && body.calculationBasis === "fixed_monthly")) return payrollJson({ ok: false, code: "INVALID_CONTRACT" }, 400);
  if (targetUsesFixedMonthly && body.payType === "monthly" && body.calculationBasis === "fixed_monthly" && !isMonthFirstDate(body.effectiveFrom)) return payrollJson({ ok: false, code: "INVALID_FIXED_MONTHLY_EFFECTIVE_DATE" }, 400);
  if (!targetUsesFixedMonthly) {
    const { data: schedules, error: scheduleError } = await supabaseServer.from("employee_work_schedule_versions").select("start_time,end_time,unpaid_break_minutes").eq("user_id", validId(body.userId)!).lte("effective_from", String(body.effectiveFrom)).or(`effective_to.is.null,effective_to.gt.${body.effectiveFrom}`);
    if (scheduleError) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_READ_FAILED" }, 500);
    if (!schedules || schedules.length === 0) return payrollJson({ ok: false, code: "WORK_SCHEDULE_NOT_FOUND" }, 400);
    if (schedules.length !== 1) return payrollJson({ ok: false, code: "WORK_SCHEDULE_OVERLAP" }, 409);
    const calculated = scheduledMinutesPerDay(String(schedules[0].start_time), String(schedules[0].end_time), Number(schedules[0].unpaid_break_minutes));
    if (calculated === null) return payrollJson({ ok: false, code: "INVALID_WORK_SCHEDULE" }, 400);
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const { data: currentContract, error: currentError } = await supabaseServer
    .from("payroll_contract_versions")
    .select("fixed_raise_amount")
    .eq("user_id", validId(body.userId)!)
    .lte("effective_from", today)
    .or(`effective_to.is.null,effective_to.gt.${today}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (currentError) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_READ_FAILED" }, 500);
  const currentFixedRaiseAmount = Number(currentContract?.fixed_raise_amount ?? 0);
  const fixedRaiseReason = resolveFixedRaiseReason(currentFixedRaiseAmount, fixedRaiseAmount, body.note);
  if (!fixedRaiseReason.valid) return payrollJson({ ok: false, code: "FIXED_RAISE_REASON_REQUIRED" }, 400);
  const { data, error } = await supabaseServer.rpc("payroll_create_contract_version_v6", {
    p_user_id: validId(body.userId), p_pay_type: body.payType,
    p_base_salary: body.baseSalary, p_fixed_raise_amount: fixedRaiseAmount, p_standard_workdays: body.standardWorkdays || null,
    p_effective_from: body.effectiveFrom, p_actor_user_id: auth.actor.id, p_note: fixedRaiseReason.note,
  });
  if (error) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_CREATE_FAILED" }, 500);
  const result = data as { status?: string; contract?: Record<string, unknown> };
  if (result.status === "period_conflict") return payrollJson({ ok: false, code: "CONTRACT_PERIOD_CONFLICT" }, 409);
  if (result.status === "work_schedule_not_found") return payrollJson({ ok: false, code: "WORK_SCHEDULE_NOT_FOUND" }, 400);
  if (result.status === "work_schedule_overlap") return payrollJson({ ok: false, code: "WORK_SCHEDULE_OVERLAP" }, 409);
  if (result.status === "invalid_work_schedule") return payrollJson({ ok: false, code: "INVALID_WORK_SCHEDULE" }, 400);
  if (result.status !== "created" || !result.contract) return payrollJson({ ok: false, code: String(result.status || "INVALID_CONTRACT") }, result.status === "forbidden" ? 403 : 400);
  return payrollJson({ ok: true, contract: mapContract(result.contract) }, 201);
}
