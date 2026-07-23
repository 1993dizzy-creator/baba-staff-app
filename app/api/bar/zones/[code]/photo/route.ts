import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { canEditBarZone } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { isBarZoneCode } from "@/lib/bar/zone-map";
import { supabaseServer } from "@/lib/supabase/server";

const BUCKET = "bar-zone-images";
const MAX_SIZE = 800 * 1024;
const MIME_EXTENSIONS = new Map([["image/webp", "webp"], ["image/jpeg", "jpg"], ["image/png", "png"]]);
type Context = { params: Promise<{ code: string }> };

export async function POST(request: NextRequest, context: Context) {
  let uploadedPath: string | null = null;
  try {
    const auth = await authorize(request, context);
    if (auth.response) return auth.response;
    const form = await request.formData();
    const file = form.get("file");
    const version = Number(form.get("version"));
    if (!(file instanceof File) || !Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
      return NextResponse.json({ ok: false, error: "File and version are required" }, { status: 400 });
    }
    const extension = MIME_EXTENSIONS.get(file.type);
    if (!extension || file.size <= 0 || file.size > MAX_SIZE) {
      return NextResponse.json({ ok: false, error: "Use a JPEG, PNG, or WebP image up to 800 KB" }, { status: 400 });
    }
    uploadedPath = `zones/${auth.code}/${Date.now()}-${randomBytes(8).toString("hex")}.${extension}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesImageSignature(bytes, file.type)) {
      return NextResponse.json({ ok: false, error: "The file content does not match its image type", code: "PHOTO_TYPE_UNSUPPORTED" }, { status: 400 });
    }
    const { error: uploadError } = await supabaseServer.storage.from(BUCKET).upload(uploadedPath, bytes, { contentType: file.type, upsert: false, cacheControl: "3600" });
    if (uploadError) throw uploadError;
    const result = await updatePhoto(auth.code, version, uploadedPath, auth.actor.id, auth.actor.name);
    if (result.response) {
      await removeWithWarning(uploadedPath, "BAR_NEW_PHOTO_COMPENSATION_WARNING");
      return result.response;
    }
    uploadedPath = null;
    const oldPath = typeof result.data.old_image_path === "string" ? result.data.old_image_path : null;
    if (oldPath) {
      await removeWithWarning(oldPath, "BAR_OLD_PHOTO_CLEANUP_WARNING");
    }
    return NextResponse.json({ ok: true, version: result.data.version });
  } catch (error) {
    if (uploadedPath) await removeWithWarning(uploadedPath, "BAR_NEW_PHOTO_COMPENSATION_WARNING");
    console.error("[BAR_PHOTO_POST_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to save BAR photo" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const auth = await authorize(request, context);
    if (auth.response) return auth.response;
    const body = await request.json() as { version?: unknown };
    const version = Number(body.version);
    if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) return NextResponse.json({ ok: false, error: "A valid version is required" }, { status: 400 });
    const result = await updatePhoto(auth.code, version, null, auth.actor.id, auth.actor.name);
    if (result.response) return result.response;
    const oldPath = typeof result.data.old_image_path === "string" ? result.data.old_image_path : null;
    if (oldPath) {
      await removeWithWarning(oldPath, "BAR_DELETED_PHOTO_CLEANUP_WARNING");
    }
    return NextResponse.json({ ok: true, version: result.data.version });
  } catch (error) {
    console.error("[BAR_PHOTO_DELETE_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to delete BAR photo" }, { status: 500 });
  }
}

async function authorize(request: Request, context: Context) {
  const { actor, response } = await getBarServerActor();
  const { code } = await context.params;
  if (response || !actor) return { actor: null, code, response };
  if (!canEditBarZone(actor)) return { actor: null, code, response: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }) };
  if (!isBarZoneCode(code)) return { actor: null, code, response: NextResponse.json({ ok: false, error: "Invalid zone code" }, { status: 400 }) };
  return { actor, code, response: null };
}

async function updatePhoto(code: string, version: number, imagePath: string | null, actorId: number, actorName: string) {
  const { data, error } = await supabaseServer.rpc("bar_update_zone_photo", {
    p_code: code, p_expected_version: version, p_image_path: imagePath,
    p_actor_user_id: actorId, p_actor_name: actorName,
  });
  if (error) throw error;
  if (data?.status === "conflict") return { data, response: NextResponse.json({ ok: false, error: "Another user updated this zone first", code: "VERSION_CONFLICT", version: data.version }, { status: 409 }) };
  if (data?.status === "not_found") return { data, response: NextResponse.json({ ok: false, error: "Zone not found" }, { status: 404 }) };
  return { data, response: null };
}

function matchesImageSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

async function removeWithWarning(path: string, label: string) {
  const { error } = await supabaseServer.storage.from(BUCKET).remove([path]);
  if (error) console.warn(`[${label}]`, path, error.message);
}
