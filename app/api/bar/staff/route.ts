import { NextResponse } from "next/server";
import { isBarColorKey } from "@/lib/bar/colors";
import { canAssignBarZone, normalizeBarPermissionValue } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const { actor, response } = await getBarServerActor(request);
    if (response || !actor) return response;
    if (!canAssignBarZone(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

    const [{ data: users, error: usersError }, { data: profiles, error: profilesError }] = await Promise.all([
      supabaseServer.from("users").select("id, username, name, full_name, role, part").eq("is_active", true),
      supabaseServer.from("bar_staff_profiles").select("user_id, color_key"),
    ]);
    if (usersError) throw usersError;
    if (profilesError) throw profilesError;
    const colorByUser = new Map((profiles ?? []).map((profile) => [Number(profile.user_id), isBarColorKey(profile.color_key) ? profile.color_key : null]));
    const staff = (users ?? [])
      .filter((user) => normalizeBarPermissionValue(user.part) === "bar")
      .map((user) => ({
        id: Number(user.id),
        name: user.name || user.full_name || user.username,
        role: user.role,
        part: user.part,
        colorKey: colorByUser.get(Number(user.id)) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ ok: true, staff });
  } catch (error) {
    console.error("[BAR_STAFF_GET_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to load BAR staff" }, { status: 500 });
  }
}
