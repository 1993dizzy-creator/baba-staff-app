import type { PayrollContract } from "./types";

export const FIRST_MONTH_PRORATION_VERSION = "fixed-calendar-v1";
export type FirstMonthPolicy = {
  userId: number;
  policyVersion: string;
  hireDate: string;
  firstContractId: number | null;
  status: "pending" | "active";
  rehired: boolean;
};

export function calendarProration(monthlyAmount: number, hireDate: string, terminationDate: string | null = null) {
  const [year, month, day] = hireDate.split("-").map(Number);
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = terminationDate && terminationDate.slice(0, 7) === hireDate.slice(0, 7)
    ? Number(terminationDate.slice(8)) : totalDays;
  const employedDays = Math.max(0, end - day + 1);
  return { employedDays, totalDays, amount: Math.round(monthlyAmount * employedDays / totalDays) };
}

// A policy affects only its original month (or a changed/re-hire month's review).
// No policy means no new fields, calculations or hash inputs on the legacy path.
export function firstMonthPolicyApplies(policy: FirstMonthPolicy | undefined, month: string, hireDate: string | null) {
  return Boolean(policy && (month === policy.hireDate.slice(0, 7)
    || (hireDate !== policy.hireDate && month === hireDate?.slice(0, 7))));
}

export function firstMonthPolicyProblem(policy: FirstMonthPolicy, user: { hire_date: string | null; termination_date: string | null }, contracts: PayrollContract[]) {
  if (policy.status !== "active") return "pending";
  if (policy.policyVersion !== FIRST_MONTH_PRORATION_VERSION) return "policy_version";
  if (policy.rehired) return "rehire";
  if (policy.hireDate !== user.hire_date) return "hire_date";
  if (user.termination_date && user.termination_date < policy.hireDate) return "termination_date";
  if (contracts.length !== 1) return "contract_period";
  const c = contracts[0];
  if (c.id !== policy.firstContractId || c.payType !== "monthly" || c.calculationBasis !== "fixed_monthly"
    || c.effectiveFrom !== `${policy.hireDate.slice(0, 7)}-01`
    || (c.effectiveTo && c.effectiveTo < `${nextMonth(policy.hireDate)}-01`)) return "contract";
  return null;
}

function nextMonth(date: string) {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

export function firstMonthEvidence(policy: FirstMonthPolicy, contract: PayrollContract, monthlyAmount: number, terminationDate: string | null) {
  const result = calendarProration(monthlyAmount, policy.hireDate, terminationDate);
  return { policyVersion: policy.policyVersion, hireDate: policy.hireDate, terminationDate,
    firstContractId: contract.id, contractRevision: contract.revision,
    contractSalary: contract.baseSalary, fixedRaiseAmount: contract.fixedRaiseAmount,
    monthlyAmount, employedDays: result.employedDays, totalDays: result.totalDays, amount: result.amount };
}
