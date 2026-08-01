import { supabaseServer } from "@/lib/supabase/server";
import { mapContract } from "@/lib/payroll/db-mappers";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { getEmployeeLevelInfo } from "@/lib/employee-level/server";
import { resolveFixedRaiseReason } from "@/lib/payroll/contract-form";

export const dynamic = "force-dynamic";
const FIELDS = "id,user_id,pay_type,calculation_basis,base_salary,fixed_raise_amount,standard_workdays,standard_minutes_per_day,time_block_minutes,rounding_mode,late_adjustment_mode,early_leave_adjustment_mode,overtime_mode,paid_leave_mode,effective_from,effective_to,revision,created_by,created_at,note";

function validId(value: unknown) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const userId = validId(new URL(request.url).searchParams.get("userId"));
  if (!userId) return payrollJson({ ok: false, code: "INVALID_USER_ID" }, 400);
  const [{ data: user, error: userError }, { data, error }] = await Promise.all([
    supabaseServer.from("users").select("id,name,full_name,username,is_active,hire_date,termination_date,is_system_account,role,level_program_enabled,level_base_date_override").eq("id", userId).eq("is_system_account",false).maybeSingle(),
    supabaseServer.from("payroll_contract_versions").select(FIELDS).eq("user_id", userId).order("effective_from", { ascending: false }),
  ]);
  if (userError || error) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_READ_FAILED" }, 500);
  if (!user) return payrollJson({ ok: false, code: "USER_NOT_FOUND" }, 404);
  const contracts = (data ?? []).map((row) => mapContract(row as Record<string, unknown>));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return payrollJson({ ok: true, user: { ...user, levelInfo: getEmployeeLevelInfo(user, today) }, current: contracts.find((c) => c.effectiveFrom <= today && (!c.effectiveTo || c.effectiveTo > today)) ?? null, scheduled: contracts.find((c) => c.effectiveFrom > today) ?? null, history: contracts });
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const fixedRaiseAmount = Number(body?.fixedRaiseAmount ?? 0);
  if (!body || !validId(body.userId) || !["minute","day"].includes(String(body.calculationBasis)) || !["monthly","daily","hourly"].includes(String(body.payType)) || !Number.isSafeInteger(Number(body.baseSalary)) || Number(body.baseSalary) < 0 || !Number.isSafeInteger(fixedRaiseAmount) || fixedRaiseAmount < 0 || (body.payType === "hourly" && body.calculationBasis === "day") || (body.payType !== "monthly" && fixedRaiseAmount !== 0)) return payrollJson({ ok: false, code: "INVALID_CONTRACT" }, 400);
  const { data: target } = await supabaseServer.from("users").select("id").eq("id",validId(body.userId)!).eq("is_system_account",false).maybeSingle();
  if(!target)return payrollJson({ok:false,code:"USER_NOT_FOUND"},404);
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
  const { data, error } = await supabaseServer.rpc("payroll_create_contract_version_v2", {
    p_user_id: validId(body.userId), p_pay_type: body.payType, p_calculation_basis: body.calculationBasis,
    p_base_salary: body.baseSalary, p_fixed_raise_amount: fixedRaiseAmount, p_standard_workdays: body.standardWorkdays || null,
    p_standard_minutes_per_day: body.standardMinutesPerDay, p_time_block_minutes: body.timeBlockMinutes,
    p_rounding_mode: body.roundingMode, p_late_adjustment_mode: body.lateAdjustmentMode,
    p_early_leave_adjustment_mode: "deduct_minutes", p_overtime_mode: "ignore",
    p_paid_leave_mode: "unpaid", p_effective_from: body.effectiveFrom,
    p_actor_user_id: auth.actor.id, p_note: fixedRaiseReason.note,
  });
  if (error) return payrollJson({ ok: false, code: "PAYROLL_CONTRACT_CREATE_FAILED" }, 500);
  const result = data as { status?: string; contract?: Record<string, unknown> };
  if (result.status === "period_conflict") return payrollJson({ ok: false, code: "CONTRACT_PERIOD_CONFLICT" }, 409);
  if (result.status !== "created" || !result.contract) return payrollJson({ ok: false, code: String(result.status || "INVALID_CONTRACT") }, result.status === "forbidden" ? 403 : 400);
  return payrollJson({ ok: true, contract: mapContract(result.contract) }, 201);
}
