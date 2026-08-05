import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { fallbackStoreSetting } from "@/lib/store-settings/fallback";
import {
  getStoreAttendancePolicy,
  getStoreBusinessDayOverride,
} from "@/lib/store-settings/attendance-server";
import type { StoreSetting, StoreSettingsOverview } from "@/lib/store-settings/types";
import {
  buildAdminAttendancePolicyInput,
  selectActiveScheduleVersion,
  type EmployeeScheduleVersionRow,
} from "@/lib/attendance/policy-resolution-core";
import { evaluateAttendancePolicy, type AttendancePolicyResult } from "@/lib/attendance/policy-engine";

type ScheduleVersionRow = {
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
};

export type AttendanceRecordPolicyRequest = {
  userId: number;
  workDate: string;
  /** users.work_start_time/work_end_time — 해당 날짜의 employee_work_schedule_versions가
   * 없을 때만 사용하는 fallback이다. */
  fallbackScheduledStartTime: string | null;
  fallbackScheduledEndTime: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  now?: string;
};

// work_date 기준으로 유효한 store_setting_versions, store_attendance_policies,
// store_business_hours, store_business_day_overrides, employee_work_schedule_versions를
// 조회해 evaluateAttendancePolicy를 실행한다. 관리자 근태 보정·강제 퇴근·미퇴근 자동보정·
// 직원 본인 퇴근 등 attendance_records의 status/late_minutes/early_leave_minutes를
// 다시 계산하는 모든 mutation 경로가 이 함수 하나로 통일된 계산 결과를 받는다.
export async function resolveAttendanceRecordPolicy(
  request: AttendanceRecordPolicyRequest
): Promise<AttendancePolicyResult> {
  const [overviewResult, scheduleResult, override] = await Promise.all([
    supabaseServer.rpc("store_get_settings_overview_v1", {
      p_business_date: request.workDate,
    }),
    supabaseServer
      .from("employee_work_schedule_versions")
      .select("start_time,end_time,effective_from,effective_to")
      .eq("user_id", request.userId)
      .lte("effective_from", request.workDate)
      .or(`effective_to.is.null,effective_to.gt.${request.workDate}`),
    getStoreBusinessDayOverride(request.workDate),
  ]);

  if (overviewResult.error) {
    throw new Error(
      `Failed to load store settings for ${request.workDate}: ${overviewResult.error.message}`
    );
  }
  if (scheduleResult.error) {
    throw new Error(
      `Failed to load work schedule for user ${request.userId}: ${scheduleResult.error.message}`
    );
  }

  const overview = overviewResult.data as
    | Omit<StoreSettingsOverview, "fallbackUsed">
    | null;
  const current = (overview?.current ?? null) as StoreSetting | null;
  const setting = current ?? fallbackStoreSetting(request.workDate);
  const settingsRevision = current ? current.revision : null;
  const policy = current
    ? current.attendancePolicy ?? (await getStoreAttendancePolicy(current.id))
    : setting.attendancePolicy;

  const scheduleRows: EmployeeScheduleVersionRow[] = (
    (scheduleResult.data ?? []) as ScheduleVersionRow[]
  ).map((row) => ({
    startTime: row.start_time,
    endTime: row.end_time,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
  const scheduleVersion = selectActiveScheduleVersion(
    scheduleRows,
    request.workDate
  );

  const policyInput = buildAdminAttendancePolicyInput({
    workDate: request.workDate,
    setting,
    settingsRevision,
    scheduleVersion,
    fallbackScheduledStartTime: request.fallbackScheduledStartTime,
    fallbackScheduledEndTime: request.fallbackScheduledEndTime,
    lateGraceMinutes: policy.lateGraceMinutes,
    earlyLeaveGraceMinutes: policy.earlyLeaveGraceMinutes,
    missingCheckoutGraceMinutes: policy.missingCheckoutGraceMinutes,
    overrideCloseTime: override?.actualCloseTime ?? null,
    checkInAt: request.checkInAt,
    checkOutAt: request.checkOutAt,
    now: request.now,
  });

  return evaluateAttendancePolicy(policyInput);
}
