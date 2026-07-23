import { NextRequest, NextResponse } from "next/server";
import { isBarColorKey } from "@/lib/bar/colors";
import { canAssignBarZone, canEditBarZone, normalizeBarPermissionValue } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { isBarZoneCode } from "@/lib/bar/zone-map";
import { supabaseServer } from "@/lib/supabase/server";

type Context = { params: Promise<{ code: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { actor, response } = await getBarServerActor();
    if (response || !actor) return response;
    if (!canEditBarZone(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    const { code } = await context.params;
    if (!isBarZoneCode(code)) return NextResponse.json({ ok: false, error: "Invalid zone code" }, { status: 400 });

    const body = await request.json() as Record<string, unknown>;
    const suppliedKeys = Object.keys(body);
    const sensitiveKeys = new Set(["assigneeUserId", "colorKey", "assignee_user_id", "color_key"]);
    if (suppliedKeys.some((key) => sensitiveKeys.has(key)) && !canAssignBarZone(actor)) {
      return NextResponse.json({ ok: false, error: "Assignee and color management is not allowed", code: "FORBIDDEN" }, { status: 403 });
    }
    const allowedKeys = new Set(["version", "noteKo", "noteVi", "assigneeUserId", "colorKey"]);
    if (suppliedKeys.some((key) => !allowedKeys.has(key))) {
      return NextResponse.json({ ok: false, error: "Unsupported update field", code: "INVALID_INPUT" }, { status: 400 });
    }
    const expectedVersion = Number(body.version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 2_147_483_647) {
      return NextResponse.json({ ok: false, error: "A valid version is required" }, { status: 400 });
    }
    const hasNoteKo = Object.hasOwn(body, "noteKo");
    const hasNoteVi = Object.hasOwn(body, "noteVi");
    const updatesNotes = hasNoteKo || hasNoteVi;
    const updatesAssignee = Object.hasOwn(body, "assigneeUserId");
    const updatesColor = Object.hasOwn(body, "colorKey");
    if (!updatesNotes && !updatesAssignee && !updatesColor) {
      return NextResponse.json({ ok: false, error: "No supported fields were supplied" }, { status: 400 });
    }

    const { data: current, error: currentError } = await supabaseServer
      .from("bar_zones")
      .select("note_ko, note_vi, assignee_user_id")
      .eq("code", code)
      .maybeSingle();
    if (currentError) throw currentError;
    if (!current) return NextResponse.json({ ok: false, error: "Zone not found" }, { status: 404 });

    const noteKo = hasNoteKo ? cleanNote(body.noteKo) : current.note_ko;
    const noteVi = hasNoteVi ? cleanNote(body.noteVi) : current.note_vi;
    if (noteKo === undefined || noteVi === undefined) {
      return NextResponse.json({ ok: false, error: "Notes must be strings or null" }, { status: 400 });
    }

    let assigneeUserId = updatesAssignee ? nullableId(body.assigneeUserId) : current.assignee_user_id;
    if (assigneeUserId === undefined) return NextResponse.json({ ok: false, error: "Invalid assignee" }, { status: 400 });
    if (assigneeUserId != null) {
      const { data: assignee, error } = await supabaseServer
        .from("users").select("id, part, is_active").eq("id", assigneeUserId).maybeSingle();
      if (error) throw error;
      if (!assignee || assignee.is_active !== true || normalizeBarPermissionValue(assignee.part) !== "bar") {
        return NextResponse.json({ ok: false, error: "Assignee must be an active BAR employee" }, { status: 400 });
      }
      assigneeUserId = Number(assignee.id);
    }
    const colorKey = updatesColor ? body.colorKey : null;
    if (updatesColor && !isBarColorKey(colorKey)) {
      return NextResponse.json({ ok: false, error: "Invalid color key" }, { status: 400 });
    }
    if (updatesColor && assigneeUserId == null) {
      return NextResponse.json({ ok: false, error: "Select an assignee before setting a color" }, { status: 400 });
    }

    const { data, error } = await supabaseServer.rpc("bar_update_zone", {
      p_code: code,
      p_expected_version: expectedVersion,
      p_actor_user_id: actor.id,
      p_actor_name: actor.name,
      p_update_notes: updatesNotes,
      p_note_ko: noteKo,
      p_note_vi: noteVi,
      p_update_assignee: updatesAssignee,
      p_assignee_user_id: assigneeUserId,
      p_update_color: updatesColor,
      p_color_key: colorKey,
    });
    if (error) throw error;
    if (data?.status === "conflict") return NextResponse.json({ ok: false, error: "Another user updated this zone first", code: "VERSION_CONFLICT", version: data.version }, { status: 409 });
    if (data?.status === "not_found") return NextResponse.json({ ok: false, error: "Zone not found" }, { status: 404 });
    return NextResponse.json({ ok: true, version: data?.version, changed: data?.changed });
  } catch (error) {
    console.error("[BAR_ZONE_PATCH_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to update BAR zone" }, { status: 500 });
  }
}

function cleanNote(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > 3000) return undefined;
  return trimmed || null;
}

function nullableId(value: unknown): number | null | undefined {
  if (value == null || value === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
