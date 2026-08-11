import "server-only";

import { classifyMonthlyAttendanceDay, evaluateMonthlyAttendanceStanding, resolveAttendanceStoreClosed, type MonthlyAttendanceStanding } from "./monthly-standing";
import { supabaseServer } from "@/lib/supabase/server";
import { normalizeAttendanceDayFacts } from "@/lib/payroll/attendance-facts";
import { mapSchedule } from "@/lib/payroll/db-mappers";
import { payrollMonthDates, resolvePayrollOverviewPeriod, type AttendanceRow } from "@/lib/payroll/monthly-run";
import { resolvePayrollAttendancePolicyByDate, type PayrollStoreSettingTimelineRow } from "@/lib/payroll/store-setting-timeline";
import type { WorkScheduleVersion } from "@/lib/payroll/types";
import { resolveStoreClosedByDate } from "@/lib/store-settings/business-time-adapter-core";
import { countHolidayGroupSizes, isBabaPremiumHoliday } from "@/lib/store-settings/holidays-policy";

export type MonthlyStandingUser = {
  id: number;
  hire_date: string | null;
  termination_date: string | null;
  attendance_tracking_enabled: boolean;
  is_system_account: boolean;
};

export async function loadMonthlyAttendanceStandings(month: string): Promise<{
  asOfDate: string;
  users: MonthlyStandingUser[];
  standings: Map<number, MonthlyAttendanceStanding>;
}> {
  const period = await resolvePayrollOverviewPeriod(month);
  const allDates = payrollMonthDates(month);
  const calculationEndDate = period.calculationEndDate;
  const dates = calculationEndDate ? allDates.filter((date) => date <= calculationEndDate) : [];
  const start = `${month}-01`;
  const end = allDates.at(-1) ?? start;
  const lastDate = dates.at(-1) ?? null;
  const [userResult, attendanceResult, scheduleResult, settingResult, holidayResult] = await Promise.all([
    supabaseServer.from("users").select("id,hire_date,termination_date,attendance_tracking_enabled,is_system_account").eq("is_system_account", false),
    supabaseServer.from("attendance_records").select("id,user_id,status,work_date,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status,updated_at").gte("work_date", start).lte("work_date", lastDate ?? start),
    supabaseServer.from("employee_work_schedule_versions").select("id,user_id,start_time,end_time,unpaid_break_minutes,effective_from,effective_to,revision,change_reason").lte("effective_from", end).or(`effective_to.is.null,effective_to.gte.${start}`),
    lastDate ? supabaseServer.from("store_setting_versions").select("id,revision,effective_from_business_date,store_attendance_policies(late_grace_minutes,early_leave_grace_minutes),store_business_hours(weekday,is_closed,open_time,close_time)").eq("state", "active").lte("effective_from_business_date", lastDate).order("effective_from_business_date").order("id") : Promise.resolve({ data: [], error: null }),
    supabaseServer.from("store_holidays").select("holiday_date,holiday_group,store_holiday_operation_policies(internal_pay_multiplier)").eq("calendar_year", Number(month.slice(0, 4))),
  ]);
  if (userResult.error || attendanceResult.error || scheduleResult.error || settingResult.error || holidayResult.error) {
    throw new Error("MONTHLY_ATTENDANCE_STANDING_READ_FAILED");
  }

  const users = (userResult.data ?? []) as MonthlyStandingUser[];
  const attendance = (attendanceResult.data ?? []) as AttendanceRow[];
  const attendanceRecordIds = attendance.map((row) => Number(row.id));
  const overrideResult = attendanceRecordIds.length
    ? await supabaseServer.from("attendance_record_manual_overrides").select("attendance_record_id").in("attendance_record_id", attendanceRecordIds).eq("override_metric", "late").eq("override_action", "normalize").is("revoked_at", null)
    : { data: [], error: null };
  if (overrideResult.error) throw new Error("MONTHLY_ATTENDANCE_STANDING_READ_FAILED");
  const overrides = new Set((overrideResult.data ?? []).map((row) => Number(row.attendance_record_id)));
  const schedules = (scheduleResult.data ?? []).map((row) => mapSchedule(row as Record<string, unknown>));
  const settingTimeline: PayrollStoreSettingTimelineRow[] = ((settingResult.data ?? []) as Record<string, unknown>[]).map((row) => {
    const raw = row.store_attendance_policies as Record<string, unknown> | Record<string, unknown>[] | null;
    const policy = Array.isArray(raw) ? raw[0] ?? null : raw;
    return { id: Number(row.id), revision: Number(row.revision), effectiveFromBusinessDate: String(row.effective_from_business_date), lateGraceMinutes: policy?.late_grace_minutes == null ? null : Number(policy.late_grace_minutes), earlyLeaveGraceMinutes: policy?.early_leave_grace_minutes == null ? null : Number(policy.early_leave_grace_minutes) };
  });
  const storeHoursTimeline = ((settingResult.data ?? []) as Record<string, unknown>[]).map((row) => {
    const hours = (Array.isArray(row.store_business_hours) ? row.store_business_hours : []) as Record<string, unknown>[];
    return { id: Number(row.id), effectiveFromBusinessDate: String(row.effective_from_business_date), hours: hours.map((hour) => ({ weekday: Number(hour.weekday), isClosed: Boolean(hour.is_closed), openTime: hour.open_time == null ? null : String(hour.open_time).slice(0, 5), closeTime: hour.close_time == null ? null : String(hour.close_time).slice(0, 5) })) };
  });
  const settings = resolvePayrollAttendancePolicyByDate(dates, settingTimeline);
  const storeClosedByDate = resolveStoreClosedByDate(dates, storeHoursTimeline);
  const holidays = ((holidayResult.data ?? []) as Record<string, unknown>[]).map((row) => {
    const rawPolicy = row.store_holiday_operation_policies as Record<string, unknown> | Record<string, unknown>[] | null;
    const operationPolicy = Array.isArray(rawPolicy) ? rawPolicy[0] ?? null : rawPolicy;
    return { holidayDate: String(row.holiday_date), holidayGroup: String(row.holiday_group), internalPayMultiplier: operationPolicy?.internal_pay_multiplier == null ? null : Number(operationPolicy.internal_pay_multiplier) };
  });
  const holidayGroupSizes = countHolidayGroupSizes(holidays);
  const premiumHolidayDates = new Set(holidays.filter((holiday) => isBabaPremiumHoliday(holiday, holidayGroupSizes.get(holiday.holidayGroup) ?? 0)).map((holiday) => holiday.holidayDate));
  const recordsByUserDate = new Map(attendance.map((row) => [`${row.user_id}:${row.work_date}`, row]));
  const schedulesByUser = new Map<number, WorkScheduleVersion[]>();
  for (const schedule of schedules) {
    const list = schedulesByUser.get(schedule.userId) ?? [];
    list.push(schedule); schedulesByUser.set(schedule.userId, list);
  }
  const standings = new Map<number, MonthlyAttendanceStanding>();
  for (const user of users) {
    const userSchedules = schedulesByUser.get(Number(user.id)) ?? [];
    const standingDays = dates.map((date) => {
      const employed = (!user.hire_date || date >= user.hire_date) && (!user.termination_date || date <= user.termination_date);
      const scheduleMatches = userSchedules.filter((row) => row.effectiveFrom <= date && (!row.effectiveTo || row.effectiveTo > date));
      const schedule = scheduleMatches.length === 1 ? scheduleMatches[0] : null;
      const record = recordsByUserDate.get(`${user.id}:${date}`) ?? null;
      const policy = settings.get(date) ?? { revision: null, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 };
      const storeClosed = resolveAttendanceStoreClosed({ weeklyStoreClosed: storeClosedByDate.get(date) === true, babaPremiumHoliday: premiumHolidayDates.has(date) });
      const classification = classifyMonthlyAttendanceDay({ employed, storeClosed, scheduleCount: scheduleMatches.length });
      const facts = classification.exempt ? null : normalizeAttendanceDayFacts({
        userId: Number(user.id), businessDate: date,
        attendanceRecord: record ? { id: Number(record.id), status: record.status, checkInAt: record.check_in_at, checkOutAt: record.check_out_at, approvalStatus: record.approval_status, storedLateMinutes: record.late_minutes, storedEarlyLeaveMinutes: record.early_leave_minutes, storedWorkMinutes: record.work_minutes } : null,
        schedule, hireDate: user.hire_date, storeSettingsRevision: policy.revision,
        lateGraceMinutes: policy.lateGraceMinutes, earlyLeaveGraceMinutes: policy.earlyLeaveGraceMinutes,
        manualLateNormalized: record ? overrides.has(Number(record.id)) : false,
      });
      return { date, facts, ...classification, approvedLeave: record?.status === "leave" && record.approval_status === "approved", completedBusinessDay: true };
    });
    standings.set(Number(user.id), evaluateMonthlyAttendanceStanding({ attendanceTrackingEnabled: user.attendance_tracking_enabled === true, days: standingDays }));
  }
  return { asOfDate: period.asOfDate, users, standings };
}
