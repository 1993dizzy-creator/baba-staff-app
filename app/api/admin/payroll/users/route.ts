import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { isPayrollEligible } from "@/lib/payroll/eligibility";
import { getVietnamDateKey } from "@/lib/employment/termination-policy";
import { withEmployeeLevelInfo, type EmployeeLevelUser } from "@/lib/employee-level/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const { data, error } = await supabaseServer.from("users").select("id,name,full_name,username,is_active,hire_date,termination_date,part,position,role,is_system_account,payroll_eligible_override,level_program_enabled,level_base_date_override").eq("is_system_account",false).order("is_active", { ascending: false }).order("name");
  if (error) return payrollJson({ ok: false, code: "PAYROLL_USERS_READ_FAILED" }, 500);
  const users = (data ?? []).filter(isPayrollEligible) as unknown as EmployeeLevelUser[];
  const levelAsOfDate = getVietnamDateKey();
  return payrollJson({ ok: true, users: users.map((user) => withEmployeeLevelInfo(user, levelAsOfDate)) });
}
