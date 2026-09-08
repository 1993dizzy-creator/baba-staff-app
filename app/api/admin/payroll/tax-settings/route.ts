import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";
import { mapTaxSettingRow, TAX_SETTING_FIELDS } from "@/lib/payroll/tax-server";
import { selectEmployeeTaxSetting, type PayrollTaxBurdenMode, type PayrollTaxInsuranceDeductionMode, type PayrollTaxMode } from "@/lib/payroll/tax";

export const dynamic = "force-dynamic";
const TAX_MODES = new Set<PayrollTaxMode>(["not_applicable", "resident_progressive"]);
const BURDEN_MODES = new Set<PayrollTaxBurdenMode>(["employee_deducted", "company_bears"]);
const INSURANCE_MODES = new Set<PayrollTaxInsuranceDeductionMode>(["payroll", "manual", "none"]);
function validId(value: unknown) { const result = Number(value); return Number.isSafeInteger(result) && result > 0 ? result : null; }

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const userId = validId(url.searchParams.get("userId"));
  const month = validPayrollMonth(url.searchParams.get("month")) ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  if (!userId) return payrollJson({ ok: false, code: "INVALID_USER_ID" }, 400);
  const [{ data: user, error: userError }, { data, error }] = await Promise.all([
    supabaseServer.from("users").select("id,name,full_name,username").eq("id", userId).eq("is_system_account", false).maybeSingle(),
    supabaseServer.from("payroll_tax_setting_versions").select(TAX_SETTING_FIELDS).eq("user_id", userId).order("effective_month", { ascending: false }).order("revision", { ascending: false }),
  ]);
  if (userError || error) return payrollJson({ ok: false, code: "PAYROLL_TAX_SETTING_READ_FAILED" }, 500);
  if (!user) return payrollJson({ ok: false, code: "USER_NOT_FOUND" }, 404);
  const history = (data ?? []).map((row) => mapTaxSettingRow(row as Record<string, unknown>));
  return payrollJson({ ok: true, current: selectEmployeeTaxSetting(history, month), history, employee: { id: Number(user.id), name: user.name || user.full_name || user.username } });
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const userId = validId(body?.userId);
  const effectiveMonth = String(body?.effectiveMonth ?? "");
  const taxMode = String(body?.taxMode ?? "") as PayrollTaxMode;
  const dependentCount = Number(body?.dependentCount);
  const burdenMode = String(body?.burdenMode ?? "") as PayrollTaxBurdenMode;
  const accountingName = String(body?.accountingName ?? "").trim();
  const insuranceDeductionMode = String(body?.insuranceDeductionMode ?? "") as PayrollTaxInsuranceDeductionMode;
  const manualInsuranceDeductionAmount = Number(body?.manualInsuranceDeductionAmount ?? 0);
  const note = String(body?.note ?? "").trim();
  const notApplicableShape = taxMode !== "not_applicable" || (dependentCount === 0 && burdenMode === "employee_deducted" && insuranceDeductionMode === "none" && manualInsuranceDeductionAmount === 0);
  if (
    !userId
    || !/^\d{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth)
    || !TAX_MODES.has(taxMode)
    || !Number.isSafeInteger(dependentCount)
    || dependentCount < 0
    || dependentCount > 1000
    || !BURDEN_MODES.has(burdenMode)
    || !INSURANCE_MODES.has(insuranceDeductionMode)
    || !Number.isSafeInteger(manualInsuranceDeductionAmount)
    || manualInsuranceDeductionAmount < 0
    || (insuranceDeductionMode !== "manual" && manualInsuranceDeductionAmount !== 0)
    || (insuranceDeductionMode === "manual" && !note)
    || (taxMode === "resident_progressive" && !accountingName)
    || !notApplicableShape
  ) return payrollJson({ ok: false, code: "INVALID_TAX_SETTING" }, 400);
  const { data, error } = await supabaseServer.rpc("payroll_create_tax_setting_version_v1", {
    p_user_id: userId,
    p_effective_month: `${effectiveMonth}-01`,
    p_tax_mode: taxMode,
    p_dependent_count: dependentCount,
    p_burden_mode: burdenMode,
    p_accounting_name: accountingName || null,
    p_insurance_deduction_mode: insuranceDeductionMode,
    p_manual_insurance_deduction_amount: manualInsuranceDeductionAmount,
    p_actor_user_id: auth.actor.id,
    p_note: note || null,
  });
  if (error) {
    const paid = error.message.includes("PAYROLL_TAX_SETTING_LOCKED_FOR_PAID_EMPLOYEE");
    const missing = error.message.includes("USER_NOT_FOUND");
    return payrollJson({ ok: false, code: paid ? "PAYROLL_TAX_SETTING_LOCKED_FOR_PAID_EMPLOYEE" : missing ? "USER_NOT_FOUND" : "INVALID_TAX_SETTING" }, paid ? 409 : missing ? 404 : 400);
  }
  return payrollJson({ ok: true, setting: mapTaxSettingRow(data as Record<string, unknown>) }, 201);
}
