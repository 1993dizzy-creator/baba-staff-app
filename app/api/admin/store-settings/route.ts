import { NextResponse } from "next/server";
import { calculateStoreBusinessDate, isStoreDateKey, isStoreTime, validateStoreHours } from "@/lib/store-settings/business-time";
import { canMutateStoreSettings, getStoreSettingsActor, getStoreSettingsOverview } from "@/lib/store-settings/server";
import { STORE_TIMEZONE, type StoreBusinessHour } from "@/lib/store-settings/types";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    const overview = await getStoreSettingsOverview();
    return NextResponse.json({ ok: true, overview, capabilities: { mutate: canMutateStoreSettings(auth.actor), audit: canMutateStoreSettings(auth.actor) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[STORE_SETTINGS_GET_FAILED]", error);
    return NextResponse.json({ ok: false, code: "STORE_SETTINGS_LOAD_FAILED" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    if (!canMutateStoreSettings(auth.actor)) return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const hours = body?.hours as StoreBusinessHour[];
    const expectedRevision = Number(body?.expectedRevision);
    const allowedKeys = new Set(["timezone", "businessDayCutoffTime", "effectiveFromBusinessDate", "expectedRevision", "hours"]);
    if (!body || Object.keys(body).some((key) => !allowedKeys.has(key)) || !isStoreDateKey(body.effectiveFromBusinessDate) || !isStoreTime(body.businessDayCutoffTime) || body.timezone !== STORE_TIMEZONE || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(hours) || !validateStoreHours(hours)) {
      return NextResponse.json({ ok: false, code: "INVALID_SETTINGS" }, { status: 400 });
    }
    const currentBusinessDate = calculateStoreBusinessDate(new Date());
    if (body.effectiveFromBusinessDate <= currentBusinessDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE" }, { status: 400 });
    const { data, error } = await supabaseServer.rpc("store_schedule_settings_v1", {
      p_effective_from_business_date: body.effectiveFromBusinessDate,
      p_expected_revision: expectedRevision,
      p_timezone: STORE_TIMEZONE,
      p_business_day_cutoff_time: body.businessDayCutoffTime,
      p_hours: hours,
      p_actor_user_id: auth.actor.id,
    });
    if (error) { console.error("[STORE_SETTINGS_SCHEDULE_RPC_ERROR]", { code: error.code, message: error.message }); return NextResponse.json({ ok: false, code: "STORE_SETTINGS_SAVE_FAILED" }, { status: 500 }); }
    return rpcResult(data);
  } catch (error) {
    console.error("[STORE_SETTINGS_SCHEDULE_FAILED]", error);
    return NextResponse.json({ ok: false, code: "STORE_SETTINGS_SAVE_FAILED" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    if (!canMutateStoreSettings(auth.actor)) return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const id = Number(body?.settingVersionId), expectedRevision = Number(body?.expectedRevision);
    const allowedKeys = new Set(["settingVersionId", "expectedRevision"]);
    if (!body || Object.keys(body).some((key) => !allowedKeys.has(key)) || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return NextResponse.json({ ok: false, code: "INVALID_SETTINGS" }, { status: 400 });
    const { data, error } = await supabaseServer.rpc("store_cancel_scheduled_settings_v1", { p_setting_version_id: id, p_expected_revision: expectedRevision, p_actor_user_id: auth.actor.id, p_cancel_reason: null });
    if (error) { console.error("[STORE_SETTINGS_CANCEL_RPC_ERROR]", { code: error.code, message: error.message }); return NextResponse.json({ ok: false, code: "STORE_SETTINGS_CANCEL_FAILED" }, { status: 500 }); }
    return rpcResult(data);
  } catch (error) {
    console.error("[STORE_SETTINGS_CANCEL_FAILED]", error);
    return NextResponse.json({ ok: false, code: "STORE_SETTINGS_CANCEL_FAILED" }, { status: 500 });
  }
}

function rpcResult(value: unknown) {
  const result = value as { status?: string; latestRevision?: number } | null;
  if (result?.status === "ok") return NextResponse.json({ ok: true, result });
  const map: Record<string, [string, number]> = {
    forbidden: ["FORBIDDEN", 403], version_conflict: ["VERSION_CONFLICT", 409], invalid_effective_date: ["INVALID_EFFECTIVE_DATE", 400],
    invalid_timezone: ["INVALID_TIMEZONE", 400], invalid_hours: ["INVALID_SETTINGS", 400], scheduled_exists: ["SCHEDULED_EXISTS", 409], not_found: ["NOT_FOUND", 404],
  };
  const [code, status] = map[result?.status || ""] || ["STORE_SETTINGS_SAVE_FAILED", 500];
  return NextResponse.json({ ok: false, code, latestRevision: result?.latestRevision }, { status });
}
