import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

export type MappingAdminActor = {
  id: number;
  username: string;
  role: string;
  is_active: boolean;
};

export async function getMappingAdminActor(actorUsername: string) {
  if (!actorUsername) return null;

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  if (
    !data ||
    (data.role !== "owner" &&
      data.role !== "master" &&
      data.role !== "manager" &&
      data.role !== "leader")
  ) {
    return null;
  }

  return data as MappingAdminActor;
}

export function getPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function getPositiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getSupabaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

export async function getRecipeMapping(mappingId: number) {
  const { data, error } = await supabaseServer
    .from("pos_item_mappings")
    .select("id, mapping_type, is_active, target_type")
    .eq("id", mappingId)
    .is("archived_at", null)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function inventoryItemExists(inventoryItemId: number) {
  const { data, error } = await supabaseServer
    .from("inventory")
    .select("id")
    .eq("id", inventoryItemId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}
