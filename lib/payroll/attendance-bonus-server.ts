import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import type { AttendanceBonusEligibilityVersion, AttendanceBonusPolicyVersion } from "./attendance-bonus";

export async function loadAttendanceBonusVersions(month: string, userIds: readonly number[]) {
  const monthDate = `${month}-01`;
  const [policyResult, eligibilityResult] = await Promise.all([
    supabaseServer.from("payroll_attendance_bonus_policy_versions").select("id,effective_month,minimum_actual_workdays,allowed_late_count,allowed_early_leave_count,bonus_amount,revision").lte("effective_month", monthDate).order("effective_month", { ascending: false }).order("revision", { ascending: false }),
    userIds.length ? supabaseServer.from("payroll_attendance_bonus_eligibility_versions").select("id,user_id,is_eligible,effective_month,revision").in("user_id", [...userIds]).lte("effective_month", monthDate).order("effective_month", { ascending: false }).order("revision", { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (policyResult.error || eligibilityResult.error) throw new Error("ATTENDANCE_BONUS_VERSION_READ_FAILED");
  const policies: AttendanceBonusPolicyVersion[] = (policyResult.data ?? []).map((row) => ({ id: Number(row.id), effectiveMonth: String(row.effective_month).slice(0, 7), minimumActualWorkdays: Number(row.minimum_actual_workdays), allowedLateCount: Number(row.allowed_late_count), allowedEarlyLeaveCount: Number(row.allowed_early_leave_count), bonusAmount: Number(row.bonus_amount), revision: Number(row.revision) }));
  const eligibilityByUser = new Map<number, AttendanceBonusEligibilityVersion[]>();
  for (const row of eligibilityResult.data ?? []) {
    const version = { id: Number(row.id), userId: Number(row.user_id), isEligible: Boolean(row.is_eligible), effectiveMonth: String(row.effective_month).slice(0, 7), revision: Number(row.revision) };
    const list = eligibilityByUser.get(version.userId) ?? []; list.push(version); eligibilityByUser.set(version.userId, list);
  }
  return { policies, eligibilityByUser };
}
