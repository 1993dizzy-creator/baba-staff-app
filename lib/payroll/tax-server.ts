import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  selectEmployeeTaxSetting,
  selectTaxPolicy,
  type PayrollTaxBracket,
  type PayrollTaxPolicyVersion,
  type PayrollTaxSettingVersion,
} from "@/lib/payroll/tax";

export const TAX_POLICY_FIELDS = "id,effective_month,personal_deduction_amount,dependent_deduction_amount,brackets,revision,created_by,created_at,note";
export const TAX_SETTING_FIELDS = "id,user_id,effective_month,tax_mode,dependent_count,burden_mode,accounting_name,insurance_deduction_mode,manual_insurance_deduction_amount,revision,created_by,created_at,note";

export function mapTaxPolicyRow(row: Record<string, unknown>): PayrollTaxPolicyVersion {
  const rawBrackets = Array.isArray(row.brackets) ? row.brackets : [];
  return {
    id: Number(row.id),
    effectiveMonth: String(row.effective_month),
    personalDeductionAmount: Number(row.personal_deduction_amount),
    dependentDeductionAmount: Number(row.dependent_deduction_amount),
    brackets: rawBrackets.map((value) => {
      const bracket = value as Record<string, unknown>;
      return {
        lowerBoundAmount: Number(bracket.lowerBoundAmount),
        upperBoundAmount: bracket.upperBoundAmount === null ? null : Number(bracket.upperBoundAmount),
        rateBp: Number(bracket.rateBp),
      } satisfies PayrollTaxBracket;
    }),
    revision: Number(row.revision),
    createdBy: Number(row.created_by),
    createdAt: String(row.created_at),
    note: row.note ? String(row.note) : null,
  };
}

export function mapTaxSettingRow(row: Record<string, unknown>): PayrollTaxSettingVersion {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    effectiveMonth: String(row.effective_month),
    taxMode: row.tax_mode as PayrollTaxSettingVersion["taxMode"],
    dependentCount: Number(row.dependent_count),
    burdenMode: row.burden_mode as PayrollTaxSettingVersion["burdenMode"],
    accountingName: row.accounting_name ? String(row.accounting_name) : null,
    insuranceDeductionMode: row.insurance_deduction_mode as PayrollTaxSettingVersion["insuranceDeductionMode"],
    manualInsuranceDeductionAmount: Number(row.manual_insurance_deduction_amount),
    revision: Number(row.revision),
    createdBy: Number(row.created_by),
    createdAt: String(row.created_at),
    note: row.note ? String(row.note) : null,
  };
}

export async function loadPayrollTaxVersions(month: string, userId?: number) {
  const monthStart = `${month}-01`;
  const policyQuery = supabaseServer
    .from("payroll_tax_policy_versions")
    .select(TAX_POLICY_FIELDS)
    .lte("effective_month", monthStart)
    .order("effective_month", { ascending: false })
    .order("revision", { ascending: false });
  const settingQuery = supabaseServer
    .from("payroll_tax_setting_versions")
    .select(TAX_SETTING_FIELDS)
    .lte("effective_month", monthStart)
    .order("effective_month", { ascending: false })
    .order("revision", { ascending: false });
  const [policyResult, settingResult] = await Promise.all([
    policyQuery,
    userId === undefined ? settingQuery : settingQuery.eq("user_id", userId),
  ]);
  if (policyResult.error || settingResult.error) throw new Error("PAYROLL_TAX_VERSION_READ_FAILED");
  const policies = (policyResult.data ?? []).map((row) => mapTaxPolicyRow(row as Record<string, unknown>));
  const settings = (settingResult.data ?? []).map((row) => mapTaxSettingRow(row as Record<string, unknown>));
  const settingsByUser = new Map<number, PayrollTaxSettingVersion[]>();
  for (const setting of settings) {
    const list = settingsByUser.get(setting.userId) ?? [];
    list.push(setting);
    settingsByUser.set(setting.userId, list);
  }
  const currentByUser = new Map<number, PayrollTaxSettingVersion>();
  for (const [targetUserId, versions] of settingsByUser) {
    const selected = selectEmployeeTaxSetting(versions, month);
    if (selected) currentByUser.set(targetUserId, selected);
  }
  return {
    policies,
    settings,
    currentPolicy: selectTaxPolicy(policies, month),
    currentByUser,
  };
}
