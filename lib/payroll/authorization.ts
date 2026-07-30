export const PAYROLL_MANAGER_ROLES = ["owner", "master"] as const;

export function canManagePayroll(role: string | null | undefined) {
  return PAYROLL_MANAGER_ROLES.includes(String(role ?? "").trim().toLowerCase() as (typeof PAYROLL_MANAGER_ROLES)[number]);
}
