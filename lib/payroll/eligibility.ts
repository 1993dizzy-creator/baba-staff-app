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

// 근태 기록을 쓰지 않는 직원(attendance_tracking_enabled=false, 예: 회계·마케팅처럼 매장
// 근무시간표가 없는 직원)은 attendance_records/employee_work_schedule_versions로 급여를
// 계산할 방법이 없다 — owner/master와 동일하게 월 고정급(monthly + fixed_monthly) 계약만
// 허용한다. 역할(role) 자체는 staff/manager/leader 등 그대로 유지되며, 이 함수는 급여
// 계약의 "근무시간 필요 여부"만 판정한다 — 권한(owner 승격) 판정이 아니다.
export function requiresFixedMonthlyContract(
  role: string | null,
  attendanceTrackingEnabled: boolean | null | undefined,
) {
  return isPayrollOwnerRole(role) || attendanceTrackingEnabled === false;
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
