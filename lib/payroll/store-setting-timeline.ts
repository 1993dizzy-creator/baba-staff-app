// loadPayrollMonthSnapshot()(monthly-run.ts)가 계산 대상 날짜마다
// store_get_settings_overview_v1 RPC를 반복 호출하던 것을, active
// store_setting_versions timeline을 한 번만 읽어 메모리에서 날짜별로 resolve하도록
// 바꾸기 위한 순수 함수. Supabase 접근은 monthly-run.ts가 담당하고, 이 파일은 이미
// 조회된 원시 timeline 행으로부터 결정론적으로 계산만 한다(business-time-adapter-core.ts /
// policy-resolution-core.ts와 동일한 core/adapter 분리 패턴).
//
// store_get_settings_overview_v1의 current 선택 규칙과 완전히 동일해야 한다:
//   select id from store_setting_versions
//   where state = 'active' and effective_from_business_date <= p_business_date
//   order by effective_from_business_date desc, id desc limit 1
// payroll이 실제로 쓰는 값은 그 version의 revision과
// store_attendance_policies.{late_grace_minutes,early_leave_grace_minutes}뿐이다 —
// missingCheckoutGraceMinutes/timezone/businessDayCutoffTime/hours/scheduled/
// created·cancelled metadata는 이 timeline이 다루지 않는다(payroll이 안 쓰므로).

export type PayrollStoreSettingTimelineRow = {
  id: number;
  revision: number;
  effectiveFromBusinessDate: string;
  /** store_attendance_policies 행이 없으면 null — SQL의 coalesce(...,0)과 동일하게 취급한다. */
  lateGraceMinutes: number | null;
  earlyLeaveGraceMinutes: number | null;
};

export type PayrollAttendancePolicyByDate = {
  revision: number | null;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
};

// dates 각각에 대해 "그 날짜 이전(포함)에 effective_from_business_date를 가진 active
// version 중 가장 최근 버전"을 고른다 — 동률(effective_from_business_date 동일)이면 id가
// 더 큰 쪽. 해당하는 version이 없으면(overview.current가 null이었던 것과 동일한 상황)
// revision=null, lateGraceMinutes=0, earlyLeaveGraceMinutes=0 fallback을 쓴다 —
// fallbackStoreSetting()은 호출하지 않는다(기존 monthly-run 동작을 그대로 보존한다).
export function resolvePayrollAttendancePolicyByDate(
  dates: readonly string[],
  timeline: readonly PayrollStoreSettingTimelineRow[],
): Map<string, PayrollAttendancePolicyByDate> {
  // effective_from_business_date ASC, id ASC로 정렬해 두면, 각 날짜에 대해 "그 날짜
  // 이하인 마지막 행"이 곧 SQL의 "DESC, DESC LIMIT 1"과 같은 행이 된다.
  const sorted = [...timeline].sort((a, b) =>
    a.effectiveFromBusinessDate === b.effectiveFromBusinessDate
      ? a.id - b.id
      : a.effectiveFromBusinessDate < b.effectiveFromBusinessDate
        ? -1
        : 1,
  );

  const result = new Map<string, PayrollAttendancePolicyByDate>();
  for (const date of dates) {
    let current: PayrollStoreSettingTimelineRow | null = null;
    for (const row of sorted) {
      if (row.effectiveFromBusinessDate > date) break;
      current = row;
    }
    result.set(
      date,
      current
        ? {
            revision: current.revision,
            lateGraceMinutes: current.lateGraceMinutes ?? 0,
            earlyLeaveGraceMinutes: current.earlyLeaveGraceMinutes ?? 0,
          }
        : { revision: null, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 },
    );
  }
  return result;
}
