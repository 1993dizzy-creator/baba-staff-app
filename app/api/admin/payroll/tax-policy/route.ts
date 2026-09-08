import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { mapTaxPolicyRow, TAX_POLICY_FIELDS } from "@/lib/payroll/tax-server";
import { selectTaxPolicy, validateTaxBrackets, type PayrollTaxBracket } from "@/lib/payroll/tax";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const month = validPayrollMonth(new URL(request.url).searchParams.get("month"));
  if (!month) return payrollJson({ ok: false, code: "INVALID_MONTH" }, 400);
  const { data, error } = await supabaseServer
    .from("payroll_tax_policy_versions")
    .select(TAX_POLICY_FIELDS)
    .order("effective_month", { ascending: false })
    .order("revision", { ascending: false });
  if (error) return payrollJson({ ok: false, code: "PAYROLL_TAX_POLICY_READ_FAILED" }, 500);
  const history = (data ?? []).map((row) => mapTaxPolicyRow(row as Record<string, unknown>));
  return payrollJson({ ok: true, current: selectTaxPolicy(history, month), history });
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const effectiveMonth = String(body?.effectiveMonth ?? "");
  const personalDeductionAmount = Number(body?.personalDeductionAmount);
  const dependentDeductionAmount = Number(body?.dependentDeductionAmount);
  const brackets = body?.brackets as PayrollTaxBracket[] | undefined;
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth)
    || !Number.isSafeInteger(personalDeductionAmount)
    || personalDeductionAmount < 0
    || !Number.isSafeInteger(dependentDeductionAmount)
    || dependentDeductionAmount < 0
    || !Array.isArray(brackets)
    || !validateTaxBrackets(brackets)
  ) return payrollJson({ ok: false, code: "INVALID_TAX_POLICY" }, 400);
  const { data, error } = await supabaseServer.rpc("payroll_create_tax_policy_version_v1", {
    p_effective_month: `${effectiveMonth}-01`,
    p_personal_deduction_amount: personalDeductionAmount,
    p_dependent_deduction_amount: dependentDeductionAmount,
    p_brackets: brackets,
    p_actor_user_id: auth.actor.id,
    p_note: String(body?.note ?? "").trim() || null,
  });
  if (error) {
    const paid = error.message.includes("PAYROLL_TAX_POLICY_LOCKED_FOR_PAID_MONTH");
    return payrollJson({ ok: false, code: paid ? "PAYROLL_TAX_POLICY_LOCKED_FOR_PAID_MONTH" : "INVALID_TAX_POLICY" }, paid ? 409 : 400);
  }
  return payrollJson({ ok: true, policy: mapTaxPolicyRow(data as Record<string, unknown>) }, 201);
}
