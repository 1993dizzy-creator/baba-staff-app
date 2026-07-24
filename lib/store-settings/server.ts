import "server-only";

import { NextResponse } from "next/server";
import { readServerSession } from "@/lib/auth/server-session";
import { supabaseServer } from "@/lib/supabase/server";
import { calculateStoreBusinessDate } from "@/lib/store-settings/business-time";
import { getStoreAttendancePolicy } from "@/lib/store-settings/attendance-server";
import { fallbackStoreSetting } from "@/lib/store-settings/fallback";
import {
  type StoreSettingsOverview,
} from "@/lib/store-settings/types";

export { fallbackStoreSetting } from "@/lib/store-settings/fallback";

export type StoreSettingsActor = { id: number; username: string; name: string; role: string };

export async function getStoreSettingsActor() {
  let session;
  try { session = await readServerSession(); }
  catch (error) {
    console.error("[STORE_SETTINGS_SESSION_ERROR]", error);
    return { actor: null, response: NextResponse.json({ ok: false, code: "SESSION_CONFIG_ERROR" }, { status: 500 }) };
  }
  if (!session) return { actor: null, response: NextResponse.json({ ok: false, code: "RELOGIN_REQUIRED" }, { status: 401 }) };
  const { data, error } = await supabaseServer.from("users").select("id,username,name,full_name,role,is_active").eq("id", session.uid).maybeSingle();
  if (error) throw new Error(`Failed to verify store settings actor: ${error.message}`);
  if (!data || data.is_active !== true) return { actor: null, response: NextResponse.json({ ok: false, code: "RELOGIN_REQUIRED" }, { status: 401 }) };
  const role = String(data.role || "").trim().toLowerCase();
  if (!["owner", "master", "manager", "leader"].includes(role)) return { actor: null, response: NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 }) };
  return { actor: { id: Number(data.id), username: String(data.username), name: data.name || data.full_name || data.username, role }, response: null };
}

export const canMutateStoreSettings = (actor: StoreSettingsActor) => ["owner", "master"].includes(actor.role);

export async function getStoreSettingsOverview(baseDate = new Date()): Promise<StoreSettingsOverview> {
  const fallbackBusinessDate = calculateStoreBusinessDate(baseDate);
  const { data: calculatedDate, error: dateError } = await supabaseServer.rpc("store_business_date_for_timestamp_v1", { p_timestamp: baseDate.toISOString() });
  if (dateError) throw new Error(`Failed to calculate store business date: ${dateError.message}`);
  const businessDate = typeof calculatedDate === "string" ? calculatedDate : fallbackBusinessDate;
  const { data, error } = await supabaseServer.rpc("store_get_settings_overview_v1", { p_business_date: businessDate });
  if (error) throw new Error(`Failed to load store settings: ${error.message}`);
  const overview = data as Omit<StoreSettingsOverview, "fallbackUsed">;
  if (!overview.current) {
    console.warn("[STORE_SETTINGS_FALLBACK]", JSON.stringify({ businessDate }));
    return { ...overview, current: fallbackStoreSetting(businessDate), fallbackUsed: true };
  }
  const [currentPolicy, scheduledPolicy] = await Promise.all([
    overview.current.attendancePolicy
      ? Promise.resolve(overview.current.attendancePolicy)
      : getStoreAttendancePolicy(overview.current.id),
    overview.scheduled
      ? overview.scheduled.attendancePolicy
        ? Promise.resolve(overview.scheduled.attendancePolicy)
        : getStoreAttendancePolicy(overview.scheduled.id)
      : Promise.resolve(null),
  ]);
  return {
    ...overview,
    current: { ...overview.current, attendancePolicy: currentPolicy },
    scheduled: overview.scheduled
      ? { ...overview.scheduled, attendancePolicy: scheduledPolicy! }
      : null,
    fallbackUsed: false,
  };
}
