import "server-only";

import { BAR_ZONE_CODES } from "@/lib/bar/zone-map";
import { isBarColorKey } from "@/lib/bar/colors";
import type { BarZoneRecord } from "@/lib/bar/types";
import { supabaseServer } from "@/lib/supabase/server";

type ZoneRow = {
  id: number;
  code: string;
  kind: "storage" | "equipment";
  selectable_for_keeping: boolean;
  note_ko: string | null;
  note_vi: string | null;
  image_path: string | null;
  assignee_user_id: number | null;
  is_active: boolean;
  version: number;
  updated_at: string;
};

export async function getBarZones(): Promise<BarZoneRecord[]> {
  const { data, error } = await supabaseServer
    .from("bar_zones")
    .select("id, code, kind, selectable_for_keeping, note_ko, note_vi, image_path, assignee_user_id, is_active, version, updated_at");
  if (error) throw new Error(`Failed to load BAR zones: ${error.message}`);

  const rows = (data ?? []) as ZoneRow[];
  const assigneeIds = [...new Set(rows.flatMap((row) => row.assignee_user_id == null ? [] : [row.assignee_user_id]))];
  const [usersResult, profilesResult] = await Promise.all([
    assigneeIds.length
      ? supabaseServer.from("users").select("id, username, name, full_name, is_active").in("id", assigneeIds)
      : Promise.resolve({ data: [], error: null }),
    assigneeIds.length
      ? supabaseServer.from("bar_staff_profiles").select("user_id, color_key").in("user_id", assigneeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (usersResult.error) throw new Error(`Failed to load BAR assignees: ${usersResult.error.message}`);
  if (profilesResult.error) throw new Error(`Failed to load BAR colors: ${profilesResult.error.message}`);

  const users = new Map((usersResult.data ?? []).map((user) => [Number(user.id), user]));
  const colors = new Map((profilesResult.data ?? []).map((profile) => [Number(profile.user_id), isBarColorKey(profile.color_key) ? profile.color_key : null]));
  const signedUrls = new Map<string, string>();
  await Promise.all(rows.flatMap((row) => !row.image_path ? [] : [
    supabaseServer.storage.from("bar-zone-images").createSignedUrl(row.image_path, 3600).then(({ data: signed, error: signedError }) => {
      if (signedError) console.error("[BAR_SIGNED_URL_ERROR]", row.code, signedError.message);
      if (signed?.signedUrl) signedUrls.set(row.image_path as string, signed.signedUrl);
    }),
  ]));

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
      assignee: user ? {
        id: Number(user.id),
        name: user.name || user.full_name || user.username,
        isActive: user.is_active === true,
        colorKey: colors.get(Number(user.id)) ?? null,
      } : null,
      isActive: row.is_active,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }).sort((a, b) => (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999));
}

