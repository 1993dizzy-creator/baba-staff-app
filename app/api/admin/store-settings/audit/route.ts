import { NextResponse } from "next/server";
import { canMutateStoreSettings, getStoreSettingsActor } from "@/lib/store-settings/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    if (!canMutateStoreSettings(auth.actor)) return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    const { data, error } = await supabaseServer.rpc("store_list_setting_audit_logs_v1", { p_limit: 50 });
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? data : [];
    const actorIds = [...new Set(rows.map((row) => Number(row.actor_user_id)).filter(Number.isSafeInteger))];
    const { data: actors, error: actorError } = actorIds.length
      ? await supabaseServer.from("users").select("id,name,full_name,username").in("id", actorIds)
      : { data: [], error: null };
    if (actorError) throw new Error(actorError.message);
    const names = new Map((actors || []).map((actor) => [Number(actor.id), actor.name || actor.full_name || actor.username || `#${actor.id}`]));
    const logs = rows.map((row) => ({ ...row, actorName: names.get(Number(row.actor_user_id)) || `#${row.actor_user_id}` }));
    return NextResponse.json({ ok: true, logs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[STORE_SETTINGS_AUDIT_FAILED]", error);
    return NextResponse.json({ ok: false, code: "STORE_SETTINGS_AUDIT_FAILED" }, { status: 500 });
  }
}
