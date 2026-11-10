import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import { getVietnamDateKey } from "@/lib/employment/termination-policy";
import { buildEmployeeLevelHistory } from "@/lib/employee-level/history";
import { EMPLOYEE_LEVEL_VERSION_SELECT, serializeEmployeeLevelProgramVersion } from "@/lib/employee-level/version-selection";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["owner", "master"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });
  const { id } = await context.params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return NextResponse.json({ ok: false }, { status: 400 });
  try {
    const today = getVietnamDateKey();
    const [year, month] = today.split("-").map(Number);
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const [user, versions, audits, contracts] = await Promise.all([
      supabaseServer.from("users").select("role,hire_date,termination_date,is_system_account").eq("id", id).maybeSingle(),
      supabaseServer.from("employee_level_program_versions").select(EMPLOYEE_LEVEL_VERSION_SELECT).eq("user_id", id).order("revision"),
      supabaseServer.from("employee_level_audit_logs").select("id,action,created_at").eq("user_id", id).order("id", { ascending: false }),
      supabaseServer.from("payroll_contract_versions").select("id,pay_type,base_salary,fixed_raise_amount,standard_workdays,standard_minutes_per_day,effective_from,effective_to")
        .eq("user_id", id).lte("effective_from", nextMonth).or(`effective_to.is.null,effective_to.gt.${today}`),
    ]);
    if ([user, versions, audits, contracts].some(result => result.error)) throw new Error("LEVEL_HISTORY_READ_FAILED");
    if (!user.data || user.data.is_system_account) return NextResponse.json({ ok: false }, { status: 404 });
    return NextResponse.json({ ok: true,
      history: buildEmployeeLevelHistory(user.data, (versions.data ?? []).map(serializeEmployeeLevelProgramVersion), today),
      adminChanges: (audits.data ?? []).map(a => ({ id: a.id, action: a.action, createdAt: a.created_at })),
      contracts: (contracts.data ?? []).map(c => ({ id: c.id, payType: c.pay_type, baseSalary: Number(c.base_salary),
        fixedRaiseAmount: Number(c.fixed_raise_amount), standardWorkdays: c.standard_workdays === null ? null : Number(c.standard_workdays),
        standardMinutesPerDay: Number(c.standard_minutes_per_day), effectiveFrom: c.effective_from, effectiveTo: c.effective_to })),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "LEVEL_HISTORY_READ_FAILED" }, { status: 500 });
  }
}
