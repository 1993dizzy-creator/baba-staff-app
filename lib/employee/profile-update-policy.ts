// app/api/admin/users/route.ts(PATCH)가 일반 프로필 수정과 "급여 대상에 포함
// (payroll_eligible_override)" 단독 수정을 구분하고, master 계정의 일반 수정을
// 차단하기 위해 쓰는 순수 판정 로직을 모아둔다. 의도적으로 외부 의존성이 없는
// 순수 함수로만 구성해, Node로 직접 실행되는 테스트에서도 "@/" 별칭 없이 상대
// 경로로 바로 임포트해 실제 값으로 검증할 수 있게 한다.
//
// 중요한 불변식: 이 판정은 반드시 "레거시 position 동기화를 반영하기 전의 update
// 객체"로 계산해야 한다. role에서 파생한 legacy position(lib/common/roles.ts의
// toLegacyEmployeePosition)을 update 객체 자체에 섞으면 Object.keys(update).length
// 가 항상 1 늘어나, payroll_eligible_override 단독 수정(override-only)이 일반
// 수정으로 오인되어 master 계정이 정상적인 급여 대상 토글까지 403으로 차단될 수
// 있다. app/api/admin/users/route.ts는 derivedPosition을 update와 별도 변수로 들고
// 있다가 RPC 호출 시점에만 스프레드로 병합해 이 문제를 구조적으로 차단한다.

export function isPayrollOverrideOnlyUpdate(
  update: Record<string, unknown>,
  hasPayrollOverrideUpdate: boolean
): boolean {
  return hasPayrollOverrideUpdate && Object.keys(update).length === 1;
}

export function isMasterGeneralEditBlocked(
  targetRole: unknown,
  isPayrollOverrideOnly: boolean
): boolean {
  return targetRole === "master" && !isPayrollOverrideOnly;
}
