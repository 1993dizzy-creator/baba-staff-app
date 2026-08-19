import "server-only";

import { BAR_ZONE_CODES } from "@/lib/bar/zone-map";
import { isBarColorKey } from "@/lib/bar/colors";
import type { BarZoneRecord } from "@/lib/bar/types";
import { supabaseServer } from "@/lib/supabase/server";
import { getVietnamDateKey } from "@/lib/employment/termination-policy";
import { applyEmployeeLevelProgramVersion, loadEmployeeLevelProgramVersions, withEmployeeLevelInfo, type EmployeeLevelUser } from "@/lib/employee-level/server";

type ZoneRow = {
  id: number;
  code: string;
  kind: "storage" | "equipment";
  selectable_for_keeping: boolean;
  note_ko: string | null;
  note_vi: string | null;
  image_path: string | null;
  image_updated_at: string | null;
  assignee_user_id: number | null;
  is_active: boolean;
  version: number;
  updated_at: string;
};

export async function getBarZones(): Promise<BarZoneRecord[]> {
  const [{ data, error }, keepingsResult] = await Promise.all([
    supabaseServer.from("bar_zones").select("id, code, kind, selectable_for_keeping, note_ko, note_vi, image_path, image_updated_at, assignee_user_id, is_active, version, updated_at"),
    supabaseServer.from("bar_keepings").select("zone_code").eq("status", "active"),
  ]);
  if (error) throw new Error(`Failed to load BAR zones: ${error.message}`);
  if (keepingsResult.error) throw new Error(`Failed to load BAR keeping counts: ${keepingsResult.error.message}`);
  const activeCounts = new Map<string, number>();
  for (const keeping of keepingsResult.data ?? []) activeCounts.set(keeping.zone_code, (activeCounts.get(keeping.zone_code) ?? 0) + 1);

  const rows = (data ?? []) as ZoneRow[];
  const assigneeIds = [...new Set(rows.flatMap((row) => row.assignee_user_id == null ? [] : [row.assignee_user_id]))];
  const imagePaths = [...new Set(rows.flatMap((row) => row.image_path ? [row.image_path] : []))];
  const levelAsOfDate = getVietnamDateKey();
  const [usersResult, profilesResult, versions, signedUrls] = await Promise.all([
    assigneeIds.length
      ? supabaseServer.from("users").select("id, username, name, full_name, role, hire_date, termination_date, is_active, is_system_account, level_program_enabled, level_base_date_override").in("id", assigneeIds)
      : Promise.resolve({ data: [], error: null }),
    assigneeIds.length
      ? supabaseServer.from("bar_staff_profiles").select("user_id, color_key").in("user_id", assigneeIds)
      : Promise.resolve({ data: [], error: null }),
    loadEmployeeLevelProgramVersions(assigneeIds, levelAsOfDate),
    createBarZoneSignedUrls(imagePaths),
  ]);
  if (usersResult.error) throw new Error(`Failed to load BAR assignees: ${usersResult.error.message}`);
  if (profilesResult.error) throw new Error(`Failed to load BAR colors: ${profilesResult.error.message}`);

  const users = new Map((usersResult.data ?? []).map((user) => [Number(user.id), user]));
  const colors = new Map((profilesResult.data ?? []).map((profile) => [Number(profile.user_id), isBarColorKey(profile.color_key) ? profile.color_key : null]));

  const order = new Map(BAR_ZONE_CODES.map((code, index) => [code, index]));
  return rows.map((row) => {
    const user = row.assignee_user_id == null ? null : users.get(Number(row.assignee_user_id));
    return {
      id: Number(row.id),
      code: row.code,
      kind: row.kind,
      selectableForKeeping: row.selectable_for_keeping,
      noteKo: row.note_ko,
      noteVi: row.note_vi,
      imagePath: row.image_path,
      imageUrl: row.image_path ? signedUrls.get(row.image_path) ?? null : null,
      imageUpdatedAt: row.image_updated_at,
      activeKeepingCount: activeCounts.get(row.code) ?? 0,
      assignee: user ? {
        id: Number(user.id),
        name: user.name || user.full_name || user.username,
        isActive: user.is_active === true,
        colorKey: colors.get(Number(user.id)) ?? null,
        levelInfo: withEmployeeLevelInfo(applyEmployeeLevelProgramVersion(user as EmployeeLevelUser, versions.get(Number(user.id))), levelAsOfDate).levelInfo,
      } : null,
      isActive: row.is_active,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }).sort((a, b) => (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999));
}

async function createBarZoneSignedUrls(paths: string[]) {
  const signedUrls = new Map<string, string>();
  if (paths.length === 0) return signedUrls;

  try {
    const { data, error } = await supabaseServer.storage
      .from("bar-zone-images")
      .createSignedUrls(paths, 3600);
    if (error) {
      console.error("[BAR_SIGNED_URL_ERROR]", "batch", error.message);
      return signedUrls;
    }
    for (const signed of data ?? []) {
      if (signed.error || !signed.path || !signed.signedUrl) {
        console.error("[BAR_SIGNED_URL_ERROR]", signed.path ?? "unknown", signed.error ?? "Missing signed URL");
        continue;
      }
      signedUrls.set(signed.path, signed.signedUrl);
    }
  } catch (error) {
    console.error("[BAR_SIGNED_URL_ERROR]", "batch", error instanceof Error ? error.message : String(error));
  }

  return signedUrls;
}
