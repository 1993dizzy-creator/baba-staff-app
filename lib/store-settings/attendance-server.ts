import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  DEFAULT_STORE_ATTENDANCE_POLICY,
  type StoreAttendancePolicy,
  type StoreBusinessDayOverride,
} from "@/lib/store-settings/types";

type PolicyRow = {
  late_grace_minutes: number | null;
  default_normal_checkout_time: string | null;
};

type OverrideRow = {
  id: number;
  business_date: string;
  actual_close_time: string;
  reason: string | null;
  state: "active" | "cancelled";
  created_by: number;
  created_at: string;
  updated_by: number | null;
  updated_at: string | null;
  cancelled_by: number | null;
  cancelled_at: string | null;
};

function normalizeTime(value: string | null | undefined, fallback: string) {
  return value ? String(value).slice(0, 5) : fallback;
}

export async function getStoreAttendancePolicy(
  settingVersionId: number
): Promise<StoreAttendancePolicy> {
  if (!Number.isSafeInteger(settingVersionId) || settingVersionId < 1) {
    return { ...DEFAULT_STORE_ATTENDANCE_POLICY };
  }

  const { data, error } = await supabaseServer
    .from("store_attendance_policies")
    .select("late_grace_minutes,default_normal_checkout_time")
    .eq("setting_version_id", settingVersionId)
    .maybeSingle<PolicyRow>();

  if (error) {
    console.warn("[ATTENDANCE_POLICY_FALLBACK]", {
      settingVersionId,
      code: error.code,
    });
    return { ...DEFAULT_STORE_ATTENDANCE_POLICY };
  }

  return {
    lateGraceMinutes: Number(
      data?.late_grace_minutes ??
        DEFAULT_STORE_ATTENDANCE_POLICY.lateGraceMinutes
    ),
    defaultNormalCheckoutTime: normalizeTime(
      data?.default_normal_checkout_time,
      DEFAULT_STORE_ATTENDANCE_POLICY.defaultNormalCheckoutTime
    ),
  };
}

export async function getStoreBusinessDayOverride(
  businessDate: string
): Promise<StoreBusinessDayOverride | null> {
  const { data, error } = await supabaseServer
    .from("store_business_day_overrides")
    .select(
      "id,business_date,actual_close_time,reason,state,created_by,created_at,updated_by,updated_at,cancelled_by,cancelled_at"
    )
    .eq("business_date", businessDate)
    .eq("state", "active")
    .maybeSingle<OverrideRow>();

  if (error) {
    console.warn("[BUSINESS_DAY_OVERRIDE_UNAVAILABLE]", {
      businessDate,
      code: error.code,
    });
    return null;
  }
  if (!data) return null;

  return {
    id: Number(data.id),
    businessDate: data.business_date,
    actualCloseTime: normalizeTime(data.actual_close_time, "00:00"),
    reason: data.reason,
    state: data.state,
    createdBy: Number(data.created_by),
    createdAt: data.created_at,
    updatedBy: data.updated_by === null ? null : Number(data.updated_by),
    updatedAt: data.updated_at,
    cancelledBy:
      data.cancelled_by === null ? null : Number(data.cancelled_by),
    cancelledAt: data.cancelled_at,
  };
}
