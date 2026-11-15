// 직원별 급여설정(급여계약·레벨·보험·TNCN·식대·개근 보너스)은 직원관리(/admin/users)에서만 관리한다.
// 급여관리·이전 급여설정 직원 탭 링크가 모두 이 함수로 같은 딥링크(?userId=&section=payroll&sheet=)를 만든다.
// 급여관리의 조회월(month)은 넘기지 않는다: 직원관리는 현재 기준으로 요약하며, 조회월이 계약 적용월로 쓰이면 안 된다.

/** 직원관리 근무·급여 영역에서 바로 열 수 있는 모달(직원관리 PAYROLL_SHEET_VIEWS와 같은 값). */
export const EMPLOYEE_PAYROLL_SHEETS = ["contract", "insurance", "tax", "meal", "bonus"] as const;
export type EmployeePayrollSheet = (typeof EMPLOYEE_PAYROLL_SHEETS)[number];

function validUserId(userId: number | string | null | undefined): number | null {
  if (userId === null || userId === undefined || userId === "") return null;
  const id = Number(userId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 해당 직원의 직원관리 근무·급여 영역(sheet가 있으면 그 모달). 직원 ID가 없거나 잘못되면 직원관리 목록. */
export function employeePayrollSettingsHref(userId: number | string | null | undefined, sheet: EmployeePayrollSheet | null = null): string {
  const id = validUserId(userId);
  if (id === null) return "/admin/users";
  return `/admin/users?userId=${id}&section=payroll${sheet ? `&sheet=${sheet}` : ""}`;
}

/**
 * 이전 급여설정 직원 탭 링크(/admin/payroll/settings?tab=employee&userId=&month=) 호환.
 * 예전 화면이 직원 탭으로 열던 경우(tab=employee, 또는 tab 없이 userId만 있는 경우)에만 직원관리 주소를 돌려준다.
 * tab=common·일반 접근은 null(공통 설정을 그대로 표시).
 */
export function legacyEmployeeSettingsRedirect(params: Pick<URLSearchParams, "get" | "has">): string | null {
  const tab = params.get("tab");
  const employeeTab = tab === "employee" || (tab !== "common" && params.has("userId"));
  if (!employeeTab) return null;
  const sheet = EMPLOYEE_PAYROLL_SHEETS.find((candidate) => candidate === params.get("sheet")) ?? null;
  const userId = params.get("userId");
  return validUserId(userId) === null ? "/admin/users" : employeePayrollSettingsHref(userId, sheet);
}
