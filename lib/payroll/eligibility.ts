export type PayrollEligibilityUser = {
  role: string | null;
  is_system_account: boolean;
  payroll_eligible_override: boolean | null;
};

export function isPayrollOwnerRole(role: string | null) {
  return role === "owner" || role === "master";
}

export function isPayrollEligible(user: PayrollEligibilityUser) {
  if (user.is_system_account) return false;
  if (user.payroll_eligible_override !== null) {
    return user.payroll_eligible_override;
  }
  return !isPayrollOwnerRole(user.role);
}

export function isPayrollUserCandidate({
  user,
  employmentIntersects,
  hasAttendance,
  hasContract,
}: {
  user: PayrollEligibilityUser;
  employmentIntersects: boolean;
  hasAttendance: boolean;
  hasContract: boolean;
}) {
  return (
    isPayrollEligible(user) &&
    (employmentIntersects || hasAttendance || hasContract)
  );
}
