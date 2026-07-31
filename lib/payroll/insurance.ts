export type PayrollInsuranceGlobalSettings = {
  employeeRateBp: number;
  employerRateBp: number;
  directorEnabled: boolean;
  directorBaseAmount: number;
  directorRateBp: number;
  settingsUpdatedAt: string | null;
};

export type PayrollInsuranceSettingVersion = {
  id: number;
  userId: number;
  isEnrolled: boolean;
  insuranceBaseAmount: number;
  effectiveMonth: string;
  revision: number;
  createdBy: number;
  createdAt: string;
  note: string | null;
};

export type PayrollEmployeeInsuranceSnapshot = {
  settingVersionId: number | null;
  revision: number | null;
  effectiveMonth: string | null;
  isEnrolled: boolean;
  insuranceBaseAmount: number;
  employeeRateBp: number;
  employerRateBp: number;
  employeeDeductionAmount: number;
  employerAmount: number;
};

export function calculateInsuranceAmount(baseAmount: number, rateBp: number) {
  if (!Number.isFinite(baseAmount) || !Number.isFinite(rateBp) || baseAmount <= 0 || rateBp <= 0) return 0;
  return Math.round(baseAmount * rateBp / 10_000);
}

export function percentToBasisPoints(value:number|string){const percent=Number(value);if(!Number.isFinite(percent)||percent<0||percent>100)return null;const scaled=percent*100;const rounded=Math.round(scaled);return Math.abs(scaled-rounded)<1e-8?rounded:null;}

export function selectInsuranceSetting(
  versions: PayrollInsuranceSettingVersion[],
  payrollMonth: string,
) {
  const monthStart = `${payrollMonth.slice(0, 7)}-01`;
  return versions
    .filter((version) => version.effectiveMonth <= monthStart)
    .sort((a, b) => b.effectiveMonth.localeCompare(a.effectiveMonth) || b.revision - a.revision)[0] ?? null;
}

export function buildEmployeeInsuranceSnapshot(
  setting: PayrollInsuranceSettingVersion | null,
  global: PayrollInsuranceGlobalSettings,
): PayrollEmployeeInsuranceSnapshot {
  const enrolled = setting?.isEnrolled === true;
  const baseAmount = enrolled ? setting.insuranceBaseAmount : 0;
  return {
    settingVersionId: setting?.id ?? null,
    revision: setting?.revision ?? null,
    effectiveMonth: setting?.effectiveMonth ?? null,
    isEnrolled: enrolled,
    insuranceBaseAmount: baseAmount,
    employeeRateBp: global.employeeRateBp,
    employerRateBp: global.employerRateBp,
    employeeDeductionAmount: calculateInsuranceAmount(baseAmount, global.employeeRateBp),
    employerAmount: calculateInsuranceAmount(baseAmount, global.employerRateBp),
  };
}

export function calculateDirectorInsurance(global: PayrollInsuranceGlobalSettings) {
  return global.directorEnabled ? calculateInsuranceAmount(global.directorBaseAmount, global.directorRateBp) : 0;
}

export function calculatePayrollInsuranceTotals(input: {
  preInsurancePayoutAmounts: number[];
  employeeDeductionAmounts: number[];
  employerAmounts: number[];
  directorAmount: number;
}) {
  const totalPreInsurancePayoutAmount = input.preInsurancePayoutAmounts.reduce((sum, value) => sum + value, 0);
  const totalEmployeeInsuranceDeductionAmount = input.employeeDeductionAmounts.reduce((sum, value) => sum + value, 0);
  const totalEmployerInsuranceAmount = input.employerAmounts.reduce((sum, value) => sum + value, 0);
  const totalNetAmount = totalPreInsurancePayoutAmount - totalEmployeeInsuranceDeductionAmount;
  return {
    totalPreInsurancePayoutAmount,
    totalEmployeeInsuranceDeductionAmount,
    totalNetAmount,
    totalEmployerInsuranceAmount,
    directorInsuranceAmount: input.directorAmount,
    totalInsuranceRemittanceAmount: totalEmployeeInsuranceDeductionAmount + totalEmployerInsuranceAmount + input.directorAmount,
    totalCompanyCostAmount: totalPreInsurancePayoutAmount + totalEmployerInsuranceAmount + input.directorAmount,
  };
}
