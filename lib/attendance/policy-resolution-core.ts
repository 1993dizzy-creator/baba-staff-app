// 관리자 근태 보정(및 그 외 근태 기록 mutation) 경로가 evaluateAttendancePolicy에
// 넘길 입력을 조립하는 순수 함수 모음이다. Supabase 접근은 policy-resolution-adapter.ts가
// 담당하고, 이 파일은 이미 조회된 원시 값으로부터 결정론적으로 계산만 한다
// (business-time-adapter-core.ts / business-time-adapter.ts 분리 방식과 동일한 패턴).
import type { AttendancePolicyInput } from "./policy-engine";
import type { StoreSetting } from "../store-settings/types";

export type EmployeeScheduleVersionRow = {
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

function normalizeTime(value: string | null | undefined) {
  return value ? String(value).slice(0, 5) : null;
}

// work_date에 유효한 employee_work_schedule_versions 행을 고른다. 정상적으로는
// 겹치는 버전이 존재하지 않지만, 방어적으로 effective_from이 가장 늦은 버전을 우선한다.
export function selectActiveScheduleVersion(
  rows: EmployeeScheduleVersionRow[],
  workDate: string
): EmployeeScheduleVersionRow | null {
  const active = rows.filter(
    (row) =>
      row.effectiveFrom <= workDate &&
      (!row.effectiveTo || row.effectiveTo > workDate)
  );
  if (active.length === 0) return null;

  return active.reduce((latest, row) =>
    row.effectiveFrom > latest.effectiveFrom ? row : latest
  );
}

export type AdminAttendancePolicyContextInput = {
  workDate: string;
  setting: StoreSetting;
  /** null이면 store_setting_versions에 해당 날짜 설정이 없어 fallback을 사용했다는 뜻. */
  settingsRevision: number | null;
  scheduleVersion: EmployeeScheduleVersionRow | null;
  /** scheduleVersion이 없을 때만 사용하는 users.work_start_time/work_end_time. */
  fallbackScheduledStartTime: string | null;
  fallbackScheduledEndTime: string | null;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
  missingCheckoutGraceMinutes: number;
  /** 해당 영업일에 활성 상태인 특별 조기마감(store_business_day_overrides)의 실제 마감시각. */
  overrideCloseTime: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  now?: string;
};

export function buildAdminAttendancePolicyInput(
  input: AdminAttendancePolicyContextInput
): AttendancePolicyInput {
  const weekday = new Date(`${input.workDate}T00:00:00Z`).getUTCDay();
  const businessHour =
    input.setting.hours.find((hour) => hour.weekday === weekday) ?? null;

  const scheduledStartTime = input.scheduleVersion
    ? normalizeTime(input.scheduleVersion.startTime)
    : normalizeTime(input.fallbackScheduledStartTime);
  const scheduledEndTime = input.scheduleVersion
    ? normalizeTime(input.scheduleVersion.endTime)
    : normalizeTime(input.fallbackScheduledEndTime);

  return {
    businessDate: input.workDate,
    timezone: input.setting.timezone,
    businessDayCutoffTime: input.setting.businessDayCutoffTime,
    settingsRevision: input.settingsRevision,
    scheduledStartTime,
    scheduledEndTime,
    storeOpenTime: normalizeTime(businessHour?.openTime),
    storeCloseTime:
      businessHour && businessHour.isClosed === false
        ? normalizeTime(businessHour.closeTime)
        : null,
    lateGraceMinutes: input.lateGraceMinutes,
    earlyLeaveGraceMinutes: input.earlyLeaveGraceMinutes,
    missingCheckoutGraceMinutes: input.missingCheckoutGraceMinutes,
    overrideCloseTime: normalizeTime(input.overrideCloseTime),
    checkInAt: input.checkInAt,
    checkOutAt: input.checkOutAt,
    now: input.now,
  };
}
