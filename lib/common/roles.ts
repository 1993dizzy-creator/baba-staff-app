// role(권한)이 직원 직급의 유일한 기준이다. 예전에는 화면 표시용 position(직급)이
// role(권한)과 별도 필드로 존재해 서로 어긋날 수 있었다(예: role=staff인데 position=leader).
// 이 파일은 role 값·라벨·정렬·owner 판정을 한 곳에 모아, 화면마다 같은 판정을 다시
// 구현하지 않게 한다. position은 레거시 DB 호환을 위해 users.position 컬럼에 계속
// 동기화되지만(app/api/admin/users/route.ts, create/route.ts), 화면 표시·정렬·권한
// 판단에는 이 파일의 role 기준 함수만 사용한다.

// master는 앱 내부 최상위 특수 권한이다. 일반 직원 생성·수정 select에는 노출하지 않고
// (EDITABLE_EMPLOYEE_ROLE_VALUES에서 제외), 화면에는 "최고관리자"로만 표시한다.
export const EDITABLE_EMPLOYEE_ROLE_VALUES = [
  "owner",
  "manager",
  "leader",
  "staff",
] as const;

export const EMPLOYEE_ROLE_VALUES = [
  "master",
  "owner",
  "manager",
  "leader",
  "staff",
] as const;

export type EditableEmployeeRole = (typeof EDITABLE_EMPLOYEE_ROLE_VALUES)[number];
export type EmployeeRole = (typeof EMPLOYEE_ROLE_VALUES)[number];

export function isEmployeeRole(value: unknown): value is EmployeeRole {
  return EMPLOYEE_ROLE_VALUES.includes(value as EmployeeRole);
}

export function isEditableEmployeeRole(
  value: unknown
): value is EditableEmployeeRole {
  return EDITABLE_EMPLOYEE_ROLE_VALUES.includes(value as EditableEmployeeRole);
}

// 급여의 "사장급" 판정 등 owner/master를 동일하게 취급해야 하는 모든 곳이 공유하는
// 단일 판정. lib/payroll/eligibility.ts의 isPayrollOwnerRole은 이 함수를 그대로 재사용한다.
export function isOwnerOrMasterRole(value: unknown): boolean {
  return value === "owner" || value === "master";
}

// 표시 순서: master → owner → manager → leader → staff → (알 수 없는 값은 맨 뒤)
const EMPLOYEE_ROLE_RANK: Record<EmployeeRole, number> = {
  master: 0,
  owner: 1,
  manager: 2,
  leader: 3,
  staff: 4,
};

export function getEmployeeRoleRank(value: unknown): number {
  return isEmployeeRole(value) ? EMPLOYEE_ROLE_RANK[value] : 99;
}

const EMPLOYEE_ROLE_LABELS: Record<EmployeeRole, { ko: string; vi: string }> = {
  master: { ko: "최고관리자", vi: "Quản trị viên cao nhất" },
  owner: { ko: "사장", vi: "Chủ cửa hàng" },
  manager: { ko: "매니저", vi: "Quản lý" },
  leader: { ko: "리더", vi: "Trưởng nhóm" },
  staff: { ko: "직원", vi: "Nhân viên" },
};

export function getEmployeeRoleLabel(value: unknown, lang: "ko" | "vi"): string {
  if (isEmployeeRole(value)) return EMPLOYEE_ROLE_LABELS[value][lang];
  return typeof value === "string" && value ? value : "-";
}

// users.position 레거시 컬럼 동기화 전용. role이 유일한 기준이 된 이후에도 position
// 컬럼과 그 값을 참조하는 다른 코드(과거 급여 position_snapshot 등)가 깨지지 않도록,
// role에서 position 값을 결정적으로 파생한다. master는 position 허용값에 없으므로
// owner로 매핑한다(HAN 계정처럼 운영에서 이미 이렇게 유지되고 있다).
export function toLegacyEmployeePosition(
  role: unknown
): "owner" | "manager" | "leader" | "staff" | null {
  if (role === "master") return "owner";
  if (role === "owner" || role === "manager" || role === "leader" || role === "staff") {
    return role;
  }
  return null;
}
