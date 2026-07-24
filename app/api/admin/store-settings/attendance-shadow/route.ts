import { NextResponse } from "next/server";
import {
  evaluateAttendancePolicy,
} from "@/lib/attendance/policy-engine";
import {
  compareAttendanceShadow,
  summarizeAttendanceShadow,
} from "@/lib/attendance/shadow";
import {
  getShiftAutoCloseIso,
  isOpenRecordUnresolved,
} from "@/lib/attendance/time";
import {
  canMutateStoreSettings,
  getStoreSettingsActor,
} from "@/lib/store-settings/server";
import {
  getStoreAttendancePolicy,
  getStoreBusinessDayOverride,
} from "@/lib/store-settings/attendance-server";
import { isStoreDateKey } from "@/lib/store-settings/business-time";
import type {
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
};

type UserRow = {
  id: number;
  name: string | null;
  username: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
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
      return NextResponse.json(
        { ok: false, code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const allowedKeys = new Set(["businessDate", "userId"]);
    const userId = parseOptionalUserId(body?.userId);
    if (
      !body ||
      Object.keys(body).some((key) => !allowedKeys.has(key)) ||
      !isStoreDateKey(body.businessDate) ||
      userId === undefined
    ) {
      return NextResponse.json(
        { ok: false, code: "INVALID_SHADOW_REQUEST" },
        { status: 400 }
      );
    }
    const businessDate = body.businessDate;

    const { data: overviewData, error: overviewError } =
      await supabaseServer.rpc("store_get_settings_overview_v1", {
        p_business_date: businessDate,
      });
    if (overviewError) throw new Error(overviewError.message);
    const overview = overviewData as Omit<
      StoreSettingsOverview,
      "fallbackUsed"
    >;
    const setting = overview.current as StoreSetting | null;
    if (!setting) {
      return NextResponse.json(
        { ok: false, code: "STORE_SETTING_NOT_FOUND" },
        { status: 404 }
      );
    }

    const [attendancePolicy, override] = await Promise.all([
      setting.attendancePolicy
        ? Promise.resolve(setting.attendancePolicy)
        : getStoreAttendancePolicy(setting.id),
      getStoreBusinessDayOverride(businessDate),
    ]);
    const weekday = new Date(`${businessDate}T00:00:00Z`).getUTCDay();
    const businessHour = setting.hours.find(
      (hour) => hour.weekday === weekday
    );

    let recordsQuery = supabaseServer
      .from("attendance_records")
      .select(
        "id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes"
      )
      .eq("work_date", businessDate)
      .not("check_in_at", "is", null);
    if (userId !== null) recordsQuery = recordsQuery.eq("user_id", userId);
    const { data: recordData, error: recordsError } =
      await recordsQuery.order("user_id", { ascending: true });
    if (recordsError) throw new Error(recordsError.message);
    const records = (recordData ?? []) as AttendanceRecordRow[];

    const userIds = [...new Set(records.map((record) => record.user_id))];
    const { data: userData, error: usersError } = userIds.length
      ? await supabaseServer
          .from("users")
          .select("id,name,username,work_start_time,work_end_time")
          .in("id", userIds)
      : { data: [], error: null };
    if (usersError) throw new Error(usersError.message);
    const users = new Map(
      ((userData ?? []) as UserRow[]).map((user) => [user.id, user])
    );
    const now = new Date();

    const rows = records.map((record) => {
      const user = users.get(record.user_id);
      const configured = evaluateAttendancePolicy({
        businessDate,
        timezone: setting.timezone,
        businessDayCutoffTime: setting.businessDayCutoffTime,
        settingsRevision: setting.revision,
        scheduledStartTime: normalizeTime(user?.work_start_time),
        scheduledEndTime: normalizeTime(user?.work_end_time),
        storeOpenTime: normalizeTime(businessHour?.openTime),
        storeCloseTime:
          businessHour?.isClosed === false
            ? normalizeTime(businessHour.closeTime)
            : null,
        lateGraceMinutes: attendancePolicy.lateGraceMinutes,
        defaultNormalCheckoutTime:
          attendancePolicy.defaultNormalCheckoutTime,
        overrideCloseTime: override?.actualCloseTime ?? null,
        checkInAt: record.check_in_at,
        checkOutAt: record.check_out_at,
        now: now.toISOString(),
      });
      const isOpen = Boolean(record.check_in_at && !record.check_out_at);

      return compareAttendanceShadow({
        recordId: record.id,
        userId: record.user_id,
        userName: user?.name || user?.username || `#${record.user_id}`,
        businessDate,
        legacy: {
          status: record.status,
          lateMinutes: Number(record.late_minutes || 0),
          earlyLeaveMinutes: Number(record.early_leave_minutes || 0),
          unresolved: isOpenRecordUnresolved(record, now),
          autoCloseAt: isOpen ? getShiftAutoCloseIso(businessDate) : null,
        },
        configured,
      });
    });

    return NextResponse.json(
      {
        ok: true,
        businessDate,
        setting: {
          revision: setting.revision,
          attendancePolicy,
          storeOpenTime: normalizeTime(businessHour?.openTime),
          storeCloseTime: normalizeTime(businessHour?.closeTime),
        },
        override,
        summary: summarizeAttendanceShadow(rows),
        rows,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[ATTENDANCE_SHADOW_FAILED]", error);
    return NextResponse.json(
      { ok: false, code: "ATTENDANCE_SHADOW_FAILED" },
      { status: 500 }
    );
  }
}
