import "server-only";
import { randomBytes } from "node:crypto";
import { keepingExpiryState, KEEPING_DETAIL_IMAGE_MAX_BYTES, KEEPING_THUMBNAIL_MAX_BYTES } from "@/lib/bar/keeping";
import type { BarKeeping } from "@/lib/bar/keeping-types";
import { supabaseServer } from "@/lib/supabase/server";

export const KEEPING_BUCKET = "bar-keeping-images";
export const KEEPING_SELECT = "id,customer_name,customer_contact,customer_identifier,liquor_name,liquor_source,inventory_item_id,use_count,note,zone_code,status,close_reason,close_note,remaining_percent,image_path,thumbnail_path,image_updated_at,stored_at,last_used_at,expires_at,closed_at,version,created_at,updated_at,bar_zones!inner(code,is_active)";

export const cleanText = (value: unknown, max: number, required = false) => {
  if (value == null) return required ? undefined : null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if ((required && !text) || text.length > max) return undefined;
  return text || null;
};
export const cleanDate = (value: unknown, required = false) => {
  if ((value == null || value === "") && !required) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return undefined;
  return value;
};
export const cleanDateTime = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+07:00` : value;
  return !Number.isNaN(new Date(normalized).getTime()) ? new Date(normalized).toISOString() : undefined;
};
export const cleanPercent = (value: unknown) => { const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= 100 ? number : undefined; };
export const cleanVersion = (value: unknown) => { const number = Number(value); return Number.isSafeInteger(number) && number >= 1 && number <= 2_147_483_647 ? number : undefined; };
export const cleanId = (value: unknown) => { const number = Number(value); return Number.isSafeInteger(number) && number >= 1 ? number : undefined; };

export async function validKeepingZone(code: unknown) {
  if (typeof code !== "string") return false;
  const { data, error } = await supabaseServer.from("bar_zones").select("code").eq("code", code).eq("is_active", true).eq("selectable_for_keeping", true).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function resolveKeepingLiquor(source: unknown, inventoryItemId: unknown, externalName: unknown) {
  if (source === "external") {
    const liquorName = cleanText(externalName, 160, true);
    return liquorName ? { liquorSource: "external" as const, inventoryItemId: null, liquorName } : null;
  }
  if (source !== "inventory") return null;
  const id = cleanId(inventoryItemId);
  if (!id) return null;
  const { data, error } = await supabaseServer.from("inventory").select("id,item_name,item_name_vi").eq("id", id).eq("part", "bar").eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const liquorName = cleanText(data.item_name || data.item_name_vi, 160, true);
  return liquorName ? { liquorSource: "inventory" as const, inventoryItemId: Number(data.id), liquorName } : null;
}

export async function uploadKeepingFiles(detail: File, thumbnail: File) {
  validateImage(detail, KEEPING_DETAIL_IMAGE_MAX_BYTES); validateImage(thumbnail, KEEPING_THUMBNAIL_MAX_BYTES);
  const token = `${Date.now()}-${randomBytes(12).toString("hex")}`;
  const imagePath = `keeping/${token}/main.${imageExtension(detail.type)}`; const thumbnailPath = `keeping/${token}/thumb.${imageExtension(thumbnail.type)}`;
  const uploaded: string[] = [];
  try {
    for (const [path, file] of [[imagePath, detail], [thumbnailPath, thumbnail]] as const) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!matchesImageSignature(bytes, file.type)) throw new Error("Invalid keeping image content");
      const { error } = await supabaseServer.storage.from(KEEPING_BUCKET).upload(path, bytes, { contentType: file.type, upsert: false, cacheControl: "3600" });
      if (error) throw error; uploaded.push(path);
    }
    return { imagePath, thumbnailPath };
  } catch (error) { if (uploaded.length) await removeKeepingFiles(uploaded, "KEEPING_PARTIAL_UPLOAD_CLEANUP"); throw error; }
}
export async function removeKeepingFiles(paths: Array<string | null | undefined>, label: string) {
  const clean = paths.filter((path): path is string => typeof path === "string" && /^keeping\/\d+-[0-9a-f]{24}\/(main|thumb)\.(webp|jpg)$/.test(path));
  if (clean.length !== paths.filter(Boolean).length) console.warn(`[${label}_INVALID_PATH_SKIPPED]`);
  if (!clean.length) return;
  const { error } = await supabaseServer.storage.from(KEEPING_BUCKET).remove(clean); if (error) console.warn(`[${label}]`, error.message);
}
function validateImage(file: File, max: number) { if (!["image/webp", "image/jpeg"].includes(file.type) || file.size < 1 || file.size > max) throw new Error("Invalid keeping image"); }
function imageExtension(type: string) { return type === "image/webp" ? "webp" : "jpg"; }
function matchesImageSignature(bytes: Uint8Array, type: string) {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return type === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP";
}

export async function signedUrl(path: string | null) {
  if (!path) return null; const { data, error } = await supabaseServer.storage.from(KEEPING_BUCKET).createSignedUrl(path, 3600);
  if (error) { console.error("[KEEPING_SIGNED_URL_ERROR]", error.message); return null; } return data.signedUrl;
}

// Supabase joins are untyped in this project; this mapper is the runtime boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mapKeeping(row: Record<string, any>, includeDetail: boolean): Promise<BarKeeping> {
  const zone = Array.isArray(row.bar_zones) ? row.bar_zones[0] : row.bar_zones;
  const { isExpirySoon, isExpired } = keepingExpiryState(row.expires_at);
  return { id:Number(row.id), customerName:row.customer_name, customerContact:row.customer_contact, customerIdentifier:row.customer_identifier, liquorName:row.liquor_name, liquorSource:row.liquor_source, inventoryItemId:row.inventory_item_id == null ? null : Number(row.inventory_item_id), useCount:Number(row.use_count ?? 0), note:row.note,
    zoneCode:row.zone_code, zoneLabelKo:row.zone_code, zoneLabelVi:row.zone_code, zoneIsActive:zone?.is_active === true, status:row.status,
    closeReason:row.close_reason, closeNote:row.close_note, remainingPercent:row.remaining_percent,
    imageUrl:includeDetail ? await signedUrl(row.image_path) : null, thumbnailUrl:await signedUrl(row.thumbnail_path), imageUpdatedAt:row.image_updated_at,
    storedAt:row.stored_at, lastUsedAt:row.last_used_at, expiresAt:row.expires_at, closedAt:row.closed_at, version:row.version,
    createdAt:row.created_at, updatedAt:row.updated_at, isExpirySoon, isExpired };
}
