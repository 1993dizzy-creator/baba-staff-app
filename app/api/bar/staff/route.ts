import { NextResponse } from "next/server";
import { isBarColorKey } from "@/lib/bar/colors";
import { canAssignBarZone, normalizeBarPermissionValue } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import { getVietnamDateKey } from "@/lib/employment/termination-policy";
import { applyEmployeeLevelProgramVersion, loadEmployeeLevelProgramVersions, withEmployeeLevelInfo, type EmployeeLevelUser } from "@/lib/employee-level/server";

export async function GET() {
  try {
    const { actor, response } = await getBarServerActor();
    if (response || !actor) return response;
    if (!canAssignBarZone(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

    const [{ data: users, error: usersError }, { data: profiles, error: profilesError }] = await Promise.all([
      supabaseServer.from("users").select("id, username, name, full_name, role, part, hire_date, termination_date, is_system_account, level_program_enabled, level_base_date_override").eq("is_active", true),
      supabaseServer.from("bar_staff_profiles").select("user_id, color_key"),
    ]);
    if (usersError) throw usersError;
    if (profilesError) throw profilesError;
    const colorByUser = new Map((profiles ?? []).map((profile) => [Number(profile.user_id), isBarColorKey(profile.color_key) ? profile.color_key : null]));
    const levelAsOfDate = getVietnamDateKey();
    const versions = await loadEmployeeLevelProgramVersions((users ?? []).map((user) => Number(user.id)), levelAsOfDate);
    const staff = (users ?? [])
      .filter((user) => normalizeBarPermissionValue(user.part) === "bar")
      .map((user) => {
        const levelInfo = withEmployeeLevelInfo(applyEmployeeLevelProgramVersion(user as EmployeeLevelUser, versions.get(Number(user.id))), levelAsOfDate).levelInfo;
        return {
          id: Number(user.id),
          name: user.name || user.full_name || user.username,
          role: user.role,
          part: user.part,
          colorKey: colorByUser.get(Number(user.id)) ?? null,
          levelInfo,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ ok: true, staff });
  } catch (error) {
    console.error("[BAR_STAFF_GET_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to load BAR staff" }, { status: 500 });
  }
}
