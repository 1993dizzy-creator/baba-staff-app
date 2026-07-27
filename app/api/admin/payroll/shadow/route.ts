import { supabaseServer } from "@/lib/supabase/server";
import { normalizeAttendanceDayFacts } from "@/lib/payroll/attendance-facts";
import { mapContract, mapSchedule } from "@/lib/payroll/db-mappers";
import { projectPayrollAttendanceDay } from "@/lib/payroll/projection";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import type { CalculationBasis, PayrollWarningCode } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";
const BASES: CalculationBasis[] = ["minute", "hour", "day"];

function validMonth(value: string | null) { return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null; }
function monthDates(month: string) {
  const [year, number] = month.split("-").map(Number);
  const end = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: end }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
}
function activeOn<T extends { effectiveFrom: string; effectiveTo: string | null }>(rows: T[], date: string) {
  return rows.filter((row) => row.effectiveFrom <= date && (!row.effectiveTo || row.effectiveTo > date));
}

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("userId"));
  const month = validMonth(url.searchParams.get("month"));
  if (!Number.isSafeInteger(userId) || userId <= 0 || !month) return payrollJson({ ok: false, code: "INVALID_SHADOW_REQUEST" }, 400);
  const dates = monthDates(month);
  const start = dates[0]; const end = dates[dates.length - 1];
  const [userResult, recordResult, scheduleResult, contractResult, settingsResults] = await Promise.all([
    supabaseServer.from("users").select("id,name,full_name,username,is_active,hire_date").eq("id", userId).maybeSingle(),
    supabaseServer.from("attendance_records").select("id,status,work_date,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status,updated_at").eq("user_id", userId).gte("work_date", start).lte("work_date", end),
    supabaseServer.from("employee_work_schedule_versions").select("id,user_id,start_time,end_time,unpaid_break_minutes,effective_from,effective_to,revision,change_reason").eq("user_id", userId).lte("effective_from", end).or(`effective_to.is.null,effective_to.gt.${start}`),
    supabaseServer.from("payroll_contract_versions").select("id,user_id,pay_type,calculation_basis,base_salary,standard_workdays,standard_minutes_per_day,time_block_minutes,rounding_mode,late_adjustment_mode,early_leave_adjustment_mode,overtime_mode,paid_leave_mode,effective_from,effective_to,revision").eq("user_id", userId).lte("effective_from", end).or(`effective_to.is.null,effective_to.gt.${start}`),
    Promise.all(dates.map((date) => supabaseServer.rpc("store_get_settings_overview_v1", { p_business_date: date }))),
  ]);
  if (userResult.error || recordResult.error || scheduleResult.error || contractResult.error || settingsResults.some((item) => item.error)) return payrollJson({ ok: false, code: "PAYROLL_SHADOW_READ_FAILED" }, 500);
  if (!userResult.data) return payrollJson({ ok: false, code: "USER_NOT_FOUND" }, 404);
  const user = userResult.data;
  const records = new Map((recordResult.data ?? []).map((row) => [row.work_date, row]));
  const schedules = (scheduleResult.data ?? []).map((row) => mapSchedule(row as Record<string, unknown>));
  const contracts = (contractResult.data ?? []).map((row) => mapContract(row as Record<string, unknown>));
  const revisions = new Map(dates.map((date, index) => {
    const overview = settingsResults[index].data as { current?: { revision?: number } | null } | null;
    return [date, overview?.current?.revision ?? null];
  }));
  const attendancePolicies = new Map(dates.map((date, index) => {
    const overview = settingsResults[index].data as { current?: { attendancePolicy?: { lateGraceMinutes?: number; earlyLeaveGraceMinutes?: number } } | null } | null;
    return [date, overview?.current?.attendancePolicy ?? null];
  }));

  const days = dates.map((businessDate) => {
    const scheduleMatches = activeOn(schedules, businessDate);
    const contractMatches = activeOn(contracts, businessDate);
    const row = records.get(businessDate);
    const facts = normalizeAttendanceDayFacts({
      userId, businessDate,
      attendanceRecord: row ? { id: Number(row.id), status: row.status, checkInAt: row.check_in_at, checkOutAt: row.check_out_at, approvalStatus: row.approval_status, storedLateMinutes: row.late_minutes, storedEarlyLeaveMinutes: row.early_leave_minutes, storedWorkMinutes: row.work_minutes } : null,
      schedule: scheduleMatches[0] ?? null,
      hireDate: user.hire_date,
      storeSettingsRevision: revisions.get(businessDate),
      lateGraceMinutes: attendancePolicies.get(businessDate)?.lateGraceMinutes ?? 0,
      earlyLeaveGraceMinutes: attendancePolicies.get(businessDate)?.earlyLeaveGraceMinutes ?? 0,
    });
    if (contractMatches.length > 1) facts.warningCodes.push("CONTRACT_OVERLAP");
    const contract = contractMatches.length === 1 ? contractMatches[0] : null;
    return { businessDate, facts, contractRevision: contract?.revision ?? null, projections: Object.fromEntries(BASES.map((basis) => [basis, projectPayrollAttendanceDay(facts, contract, basis)])) };
  });
  const summary = Object.fromEntries(BASES.map((basis) => {
    const projections = days.map((day) => day.projections[basis]);
    const warnings = [...new Set(projections.flatMap((item) => item.warningCodes))] as PayrollWarningCode[];
    const calculable = projections.filter((item) => item.payrollStatus === "calculable");
    return [basis, { recognizedMinutes: calculable.reduce((sum, item) => sum + (item.recognizedMinutes ?? 0), 0), recognizedHours: calculable.reduce((sum, item) => sum + (item.recognizedHours ?? 0), 0), recognizedDays: calculable.reduce((sum, item) => sum + (item.recognizedDays ?? 0), 0), estimatedAmount: calculable.reduce((sum, item) => sum + (item.estimatedAmount ?? 0), 0), requiresReviewDays: projections.filter((item) => item.payrollStatus === "requires_review").length, warningCodes: warnings }];
  }));
  return payrollJson({ ok: true, user, month, readOnly: true, disclaimer: "SHADOW_NOT_PAYROLL_FINAL", inputRevisions: { schedules: schedules.map((item) => item.revision), contracts: contracts.map((item) => item.revision), storeSettings: [...new Set(revisions.values())] }, summary, days });
}
