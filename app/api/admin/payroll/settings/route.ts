import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const { data, error } = await supabaseServer.from("payroll_settings").select("payment_day,payment_month_offset,updated_at,updated_by").eq("id", 1).single();
  return error ? payrollJson({ ok:false, code:"PAYROLL_SETTINGS_READ_FAILED" },500) : payrollJson({ ok:true, settings:data });
}

export async function PATCH(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as { paymentDay?: unknown } | null;
  const paymentDay = Number(body?.paymentDay);
  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 28) return payrollJson({ ok:false, code:"INVALID_PAYMENT_DAY" },400);
  const { data, error } = await supabaseServer.from("payroll_settings").update({ payment_day:paymentDay, updated_at:new Date().toISOString(), updated_by:auth.actor.id }).eq("id",1).select("payment_day,payment_month_offset,updated_at,updated_by").single();
  return error ? payrollJson({ ok:false, code:"PAYROLL_SETTINGS_UPDATE_FAILED" },500) : payrollJson({ ok:true, settings:data });
}
