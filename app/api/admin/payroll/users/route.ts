import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { isPayrollEligible } from "@/lib/payroll/eligibility";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const { data, error } = await supabaseServer.from("users").select("id,name,full_name,username,is_active,hire_date,termination_date,part,position,role,is_system_account,payroll_eligible_override").eq("is_system_account",false).order("is_active", { ascending: false }).order("name");
  if (error) return payrollJson({ ok: false, code: "PAYROLL_USERS_READ_FAILED" }, 500);
  return payrollJson({ ok: true, users: (data ?? []).filter(isPayrollEligible) });
}
