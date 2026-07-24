import { NextResponse } from "next/server";
import { evaluateAttendancePolicy } from "@/lib/attendance/policy-engine";
import {
  compareAttendanceShadow,
  summarizeAttendanceShadow,
  type AttendanceShadowComparison,
} from "@/lib/attendance/shadow";
import { parseAttendanceShadowRange } from "@/lib/attendance/shadow-period";
import { resolveAttendanceShadowSetting } from "@/lib/attendance/shadow-settings";
import { getShiftAutoCloseIso, isOpenRecordUnresolved } from "@/lib/attendance/time";
import {
  canMutateStoreSettings,
  fallbackStoreSetting,
  getStoreSettingsActor,
} from "@/lib/store-settings/server";
import { getStoreAttendancePolicy } from "@/lib/store-settings/attendance-server";
import type {
  StoreBusinessDayOverride,
  StoreSetting,
  StoreSettingsOverview,
} from "@/lib/store-settings/types";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type AttendanceRecordRow = {
  id: number;
  user_id: number;
  work_date: string;
  status: string;
  check_in_at: string | null;
  check_out_at: string | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  approval_status: string | null;
  is_staff_direct_leave: boolean;
};
type UserRow = {
  id: number;
  name: string | null;
  username: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
};
type ManualOverrideRow = {
  attendance_record_id: number;
  override_metric: "late" | "early_leave";
};

function normalizeTime(value: string | null | undefined) {
  return value ? String(value).slice(0, 5) : null;
}
function parseOptionalUserId(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export async function POST(request: Request) {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    if (!canMutateStoreSettings(auth.actor)) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const allowedKeys = new Set([
      "businessDate",
      "startBusinessDate",
      "endBusinessDate",
      "userId",
    ]);
    const userId = parseOptionalUserId(body?.userId);
    const range = body ? parseAttendanceShadowRange(body) : null;
    if (
      !body ||
      Object.keys(body).some((key) => !allowedKeys.has(key)) ||
      userId === undefined ||
      !range
    ) {
      return NextResponse.json(
        { ok: false, code: "INVALID_SHADOW_REQUEST" },
        { status: 400 }
      );
    }

    const overviewResults = await Promise.all(
      range.businessDates.map(async (businessDate) => {
        const { data, error } = await supabaseServer.rpc(
          "store_get_settings_overview_v1",
          { p_business_date: businessDate }
        );
        if (error) throw new Error(error.message);
        const setting = (data as Omit<StoreSettingsOverview, "fallbackUsed">)
          .current as StoreSetting | null;
        return [
          businessDate,
          resolveAttendanceShadowSetting(
            businessDate,
            setting,
            fallbackStoreSetting
          ),
        ] as const;
      })
    );
    const settingsByDate = new Map(overviewResults);
    const settings = [
      ...new Map(
        overviewResults
          .filter(([, resolved]) => !resolved.fallbackUsed)
          .map(([, resolved]) => [resolved.setting.id, resolved.setting])
      ).values(),
    ];
    const policies = await Promise.all(
      settings.map(async (setting) => [
        setting.id,
        setting.attendancePolicy ?? (await getStoreAttendancePolicy(setting.id)),
      ] as const)
    );
    const policiesBySetting = new Map(policies);

    let recordsQuery = supabaseServer
      .from("attendance_records")
      .select("id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes,approval_status,is_staff_direct_leave")
      .gte("work_date", range.startBusinessDate)
      .lte("work_date", range.endBusinessDate);
    if (userId !== null) recordsQuery = recordsQuery.eq("user_id", userId);

    const [recordResult, overrideResult, cancellationResult] = await Promise.all([
      recordsQuery.order("work_date").order("user_id"),
      supabaseServer
        .from("store_business_day_overrides")
        .select("id,business_date,actual_close_time,reason,state,created_by,created_at")
        .gte("business_date", range.startBusinessDate)
        .lte("business_date", range.endBusinessDate)
        .eq("state", "active"),
      supabaseServer
        .from("attendance_record_audit_logs")
        .select("action")
        .gte("work_date", range.startBusinessDate)
        .lte("work_date", range.endBusinessDate)
        .in("action", ["cancel_check_in", "cancel_check_out", "cancel_leave"]),
    ]);
    if (recordResult.error) throw new Error(recordResult.error.message);
    if (overrideResult.error) throw new Error(overrideResult.error.message);
    if (cancellationResult.error) throw new Error(cancellationResult.error.message);
    const records = (recordResult.data ?? []) as AttendanceRecordRow[];
    const recordIds = records.map((record) => record.id);

    const [userResult, manualResult] = await Promise.all([
      records.length
        ? supabaseServer
            .from("users")
            .select("id,name,username,work_start_time,work_end_time")
            .in("id", [...new Set(records.map((record) => record.user_id))])
        : Promise.resolve({ data: [], error: null }),
      recordIds.length
        ? supabaseServer
            .from("attendance_record_manual_overrides")
            .select("attendance_record_id,override_metric")
            .in("attendance_record_id", recordIds)
            .is("revoked_at", null)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (userResult.error) throw new Error(userResult.error.message);
    if (manualResult.error) throw new Error(manualResult.error.message);

    const users = new Map(
      ((userResult.data ?? []) as UserRow[]).map((user) => [user.id, user])
    );
    const manualLateIds = new Set(
      ((manualResult.data ?? []) as ManualOverrideRow[])
        .filter((item) => item.override_metric === "late")
        .map((item) => item.attendance_record_id)
    );
    const overrides = new Map(
      (overrideResult.data ?? []).map((item) => [
        item.business_date,
        {
          id: item.id,
          businessDate: item.business_date,
          actualCloseTime: normalizeTime(item.actual_close_time) ?? "00:00",
          reason: item.reason,
          state: item.state,
          createdBy: item.created_by,
          createdAt: item.created_at,
          updatedBy: null,
          updatedAt: null,
          cancelledBy: null,
          cancelledAt: null,
        } satisfies StoreBusinessDayOverride,
      ])
    );
    const now = new Date();
    const rows: AttendanceShadowComparison[] = records.map((record) => {
      const resolved = settingsByDate.get(record.work_date)!;
      const setting = resolved.setting;
      const policy =
        resolved.attendancePolicy ??
        policiesBySetting.get(resolved.settingId!)!;
      const user = users.get(record.user_id);
      const weekday = new Date(`${record.work_date}T00:00:00Z`).getUTCDay();
      const businessHour = setting.hours.find((hour) => hour.weekday === weekday);
      const override = overrides.get(record.work_date);
      const configured = evaluateAttendancePolicy({
        businessDate: record.work_date,
        timezone: setting.timezone,
        businessDayCutoffTime: setting.businessDayCutoffTime,
        settingsRevision: resolved.revision,
        scheduledStartTime: normalizeTime(user?.work_start_time),
        scheduledEndTime: normalizeTime(user?.work_end_time),
        storeOpenTime: normalizeTime(businessHour?.openTime),
        storeCloseTime: businessHour?.isClosed === false ? normalizeTime(businessHour.closeTime) : null,
        lateGraceMinutes: policy.lateGraceMinutes,
        defaultNormalCheckoutTime: policy.defaultNormalCheckoutTime,
        overrideCloseTime: normalizeTime(override?.actualCloseTime),
        checkInAt: record.check_in_at,
        checkOutAt: record.check_out_at,
        now: now.toISOString(),
      });
      const isOpen = Boolean(record.check_in_at && !record.check_out_at);
      const comparison = compareAttendanceShadow({
        recordId: record.id,
        userId: record.user_id,
        userName: user?.name || user?.username || `#${record.user_id}`,
        businessDate: record.work_date,
        checkInAt: record.check_in_at,
        checkOutAt: record.check_out_at,
        manualLateNormalization: manualLateIds.has(record.id),
        legacy: {
          status: record.status,
          lateMinutes: Number(record.late_minutes || 0),
          earlyLeaveMinutes: Number(record.early_leave_minutes || 0),
          unresolved: isOpenRecordUnresolved(record, now),
          unresolvedAt: isOpen ? getShiftAutoCloseIso(record.work_date) : null,
          autoCloseAt: isOpen ? getShiftAutoCloseIso(record.work_date) : null,
        },
        configured,
      });
      if (record.status === "leave" && !record.check_in_at) {
        comparison.comparisonStatus = "excluded";
        comparison.exclusionReason = "leave";
        comparison.differenceTypes = ["leave"];
      } else if (!record.check_in_at) {
        comparison.comparisonStatus = "excluded";
        comparison.exclusionReason = "no_check_in";
        comparison.differenceTypes = ["other"];
      }
      return comparison;
    });

    const summary = summarizeAttendanceShadow(rows, records.length);
    const dateSummaries = range.businessDates.map((businessDate) => {
      const dateRows = rows.filter((row) => row.businessDate === businessDate);
      const resolved = settingsByDate.get(businessDate)!;
      const setting = resolved.setting;
      const hour = setting.hours.find(
        (item) => item.weekday === new Date(`${businessDate}T00:00:00Z`).getUTCDay()
      );
      return {
        businessDate,
        settingsRevision: resolved.revision,
        fallbackUsed: resolved.fallbackUsed,
        storeOpenTime: normalizeTime(hour?.openTime),
        storeCloseTime: normalizeTime(hour?.closeTime),
        businessDayCutoffTime: setting.businessDayCutoffTime,
        hasBusinessOverride: overrides.has(businessDate),
        ...summarizeAttendanceShadow(dateRows, dateRows.length),
      };
    });
    const cancellationActions = (cancellationResult.data ?? []).map((item) => item.action);
    const firstResolved = settingsByDate.get(range.startBusinessDate)!;
    const firstSetting = firstResolved.setting;
    const firstPolicy =
      firstResolved.attendancePolicy ??
      policiesBySetting.get(firstResolved.settingId!)!;
    const firstHour = firstSetting.hours.find(
      (item) => item.weekday === new Date(`${range.startBusinessDate}T00:00:00Z`).getUTCDay()
    );

    return NextResponse.json({
      ok: true,
      businessDate: range.singleDate ? range.startBusinessDate : undefined,
      startBusinessDate: range.startBusinessDate,
      endBusinessDate: range.endBusinessDate,
      businessDayCount: range.businessDates.length,
      historicalManualOverrideWarning: true,
      setting: {
        revision: firstResolved.revision,
        fallbackUsed: firstResolved.fallbackUsed,
        attendancePolicy: firstPolicy,
        storeOpenTime: normalizeTime(firstHour?.openTime),
        storeCloseTime: normalizeTime(firstHour?.closeTime),
        businessDayCutoffTime: firstSetting.businessDayCutoffTime,
      },
      override: range.singleDate ? overrides.get(range.startBusinessDate) ?? null : null,
      summary,
      dateSummaries,
      leaveSummary: {
        approved: records.filter((row) => row.status === "leave" && row.approval_status === "approved" && !row.is_staff_direct_leave).length,
        direct: records.filter((row) => row.status === "leave" && row.is_staff_direct_leave).length,
        valid: records.filter((row) => row.status === "leave").length,
        excluded: summary.leaveExcluded,
      },
      cancellationSummary: {
        total: cancellationActions.length,
        checkIn: cancellationActions.filter((action) => action === "cancel_check_in").length,
        checkOut: cancellationActions.filter((action) => action === "cancel_check_out").length,
        leave: cancellationActions.filter((action) => action === "cancel_leave").length,
      },
      differenceTypeCounts: rows.flatMap((row) => row.differenceTypes).reduce<Record<string, number>>(
        (counts, type) => ({ ...counts, [type]: (counts[type] ?? 0) + 1 }),
        {}
      ),
      rows,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ATTENDANCE_SHADOW_FAILED]", error);
    return NextResponse.json(
      { ok: false, code: "ATTENDANCE_SHADOW_FAILED" },
      { status: 500 }
    );
  }
}
