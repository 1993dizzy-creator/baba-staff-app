import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { isPayrollEligible } from "@/lib/payroll/eligibility";
import { getVietnamDateKey } from "@/lib/employment/termination-policy";
import { applyEmployeeLevelProgramVersion, loadEmployeeLevelProgramVersions, withEmployeeLevelInfo, type EmployeeLevelUser } from "@/lib/employee-level/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const { data, error } = await supabaseServer.from("users").select("id,name,full_name,username,is_active,hire_date,termination_date,part,position,role,is_system_account,payroll_eligible_override,level_program_enabled,level_base_date_override,attendance_tracking_enabled").eq("is_system_account",false).eq("is_active",true).order("id");
  if (error) return payrollJson({ ok: false, code: "PAYROLL_USERS_READ_FAILED" }, 500);
  const users = (data ?? []).filter(isPayrollEligible) as unknown as Array<EmployeeLevelUser & { id: number; attendance_tracking_enabled: boolean }>;
  const levelAsOfDate = getVietnamDateKey();
  const versions = await loadEmployeeLevelProgramVersions(users.map((user) => Number(user.id)), levelAsOfDate);
  // 급여설정 화면이 owner/master뿐 아니라 근태 미사용 직원도 월 고정급 계약 UI로 안내할 수
  // 있도록 attendanceTrackingEnabled를 함께 내려준다(lib/payroll/eligibility.ts의
  // requiresFixedMonthlyContract가 이 값을 role과 함께 판정에 쓴다).
  return payrollJson({
    ok: true,
    users: users.map((user) => ({
      ...withEmployeeLevelInfo(applyEmployeeLevelProgramVersion(user, versions.get(Number(user.id))), levelAsOfDate),
      attendanceTrackingEnabled: user.attendance_tracking_enabled !== false,
    })),
  });
}
