/**
 * 근태 기록 OFF 저장이 서버 트리거로 차단된 경우의 오류 코드 식별(클라이언트 표시용, 서버 정책 변경 없음).
 *
 * 확인된 차단 코드(public.users BEFORE UPDATE 트리거, 운영 활성 확인 2026-11-13):
 * - ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE
 *   (users_block_attendance_tracking_disable_when_bonus_eligible, 20260811093311)
 * - MEAL_ALLOWANCE_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE
 *   (users_block_attendance_tracking_disable_when_meal_eligible, 202608070001)
 * 열린 출근 기록(ATTENDANCE_OPEN_RECORD_EXISTS)은 서버가 이미 code·현지화 문구로 응답하므로 여기서 다루지 않는다.
 *
 * PATCH /api/admin/users는 위 두 코드를 `Failed to atomically update user: <code>` 형태의 error 문자열(500)로
 * 돌려준다. 응답의 code가 있으면 code를, 없으면 error 안의 정확한 코드 토큰만 인정한다.
 */
export const ATTENDANCE_DISABLE_BLOCK_CODES = [
  "ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE",
  "MEAL_ALLOWANCE_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE",
] as const;

export type AttendanceDisableBlockCode = (typeof ATTENDANCE_DISABLE_BLOCK_CODES)[number];

export function attendanceDisableBlockCode(result: { code?: unknown; error?: unknown } | null | undefined): AttendanceDisableBlockCode | null {
  if (!result) return null;
  for (const value of [result.code, result.error]) {
    if (typeof value !== "string") continue;
    const tokens: string[] = value.match(/[A-Z][A-Z0-9_]+/g) ?? [];
    const found = ATTENDANCE_DISABLE_BLOCK_CODES.find((code) => tokens.includes(code));
    if (found) return found;
  }
  return null;
}
