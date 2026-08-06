// isOwnerOrMasterRole(lib/common/roles.ts)과 의미가 같다. 이 파일은 tests/에서
// "@/" 별칭 없는 Node 직접 실행(--experimental-strip-types)으로 상대 경로 임포트되므로,
// 별칭 기반 cross-module import를 추가하지 않고 판정식만 그대로 유지한다.
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
