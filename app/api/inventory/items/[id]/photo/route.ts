import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getBusinessDate } from "@/lib/common/business-time";

const INVENTORY_IMAGE_BUCKET = "inventory-images";
const MAX_UPLOAD_BYTES = 120 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type RouteParams = {
  params: Promise<{ id: string }>;
};

type InventoryPhotoItem = {
  id: number;
  item_name?: string | null;
  item_name_vi?: string | null;
  part?: string | null;
  category?: string | null;
  category_vi?: string | null;
  quantity?: string | number | null;
  purchase_price?: string | number | null;
  note?: string | null;
  unit?: string | null;
  code?: string | null;
  supplier?: string | null;
  low_stock_threshold?: string | number | null;
  image_path?: string | null;
};

type InventoryPhotoActor = {
  name?: string | null;
  username?: string | null;
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Server error";

const jsonError = (error: string, message: string, status = 500) =>
  NextResponse.json({ ok: false, error, message }, { status });

const getSupabaseAdmin = () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      client: null,
      error: "missing_server_env",
      message: !supabaseUrl
        ? "Missing NEXT_PUBLIC_SUPABASE_URL"
        : "Missing SUPABASE_SERVICE_ROLE_KEY",
    };
  }

  return {
    client: createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }),
    error: null,
    message: null,
  };
};

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>["client"]>;

const getActor = async (supabaseAdmin: SupabaseAdmin, actorUsername?: string) => {
  if (!actorUsername) return null;

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
};

const parseItemId = async ({ params }: RouteParams) => {
  const { id } = await params;
  const itemId = Number(id);

  return Number.isInteger(itemId) && itemId > 0 ? itemId : null;
};

const getInventoryItem = async (supabaseAdmin: SupabaseAdmin, itemId: number) => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select(`
      id,
      item_name,
      item_name_vi,
      part,
      category,
      category_vi,
      quantity,
      purchase_price,
      note,
      unit,
      code,
      supplier,
      low_stock_threshold,
      image_path
    `)
    .eq("id", itemId)
    .maybeSingle();

  if (error) throw error;
  return data;
};

const getExtension = (contentType: string) => {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  return "webp";
};

const createImagePath = (itemId: number, contentType: string) => {
  const extension = getExtension(contentType);
  const random = Math.random().toString(36).slice(2, 10);

  return `inventory-items/${itemId}/${Date.now()}-${random}.${extension}`;
};

const insertPhotoLog = async ({
  supabaseAdmin,
  item,
  actor,
  note,
}: {
  supabaseAdmin: SupabaseAdmin;
  item: InventoryPhotoItem;
  actor: InventoryPhotoActor;
  note: string;
}) => {
  const quantity = Number(item.quantity ?? 0);

  const { error } = await supabaseAdmin.from("inventory_logs").insert([
    {
      item_id: item.id,
      item_name: item.item_name ?? null,
      item_name_vi: item.item_name_vi ?? null,
      action: "update",
      part: item.part ?? null,
      category: item.category ?? null,
      category_vi: item.category_vi ?? null,
      prev_quantity: quantity,
      new_quantity: quantity,
      change_quantity: 0,
      prev_purchase_price: item.purchase_price ?? null,
      new_purchase_price: item.purchase_price ?? null,
      prev_note: null,
      new_note: note,
      prev_supplier: item.supplier ?? null,
      new_supplier: item.supplier ?? null,
      prev_code: item.code ?? null,
      new_code: item.code ?? null,
      prev_unit: item.unit ?? null,
      new_unit: item.unit ?? null,
      prev_category: item.category ?? null,
      new_category: item.category ?? null,
      prev_category_vi: item.category_vi ?? null,
      new_category_vi: item.category_vi ?? null,
      prev_part: item.part ?? null,
      new_part: item.part ?? null,
      unit: item.unit ?? null,
      code: item.code ?? null,
      actor_name: actor.name || "",
      actor_username: actor.username || "",
      prev_low_stock_threshold: item.low_stock_threshold ?? 1,
      new_low_stock_threshold: item.low_stock_threshold ?? 1,
      reason: "other",
      source: "photo",
      business_date: getBusinessDate(),
    },
  ]);

  return error;
};

export async function POST(req: Request, context: RouteParams) {
  try {
    const { client: supabaseAdmin, error: envError, message: envMessage } =
      getSupabaseAdmin();

    if (!supabaseAdmin) {
      console.error("[INVENTORY_PHOTO_ENV_ERROR]", envMessage);
      return jsonError(envError || "missing_server_env", "Server is not configured", 500);
    }

    const itemId = await parseItemId(context);

    if (!itemId) {
      return jsonError("invalid_item_id", "Invalid item id", 400);
    }

    let formData: FormData;

    try {
      formData = await req.formData();
    } catch (error) {
      console.error("[INVENTORY_PHOTO_FORMDATA_ERROR]", error);
      return jsonError("form_data_parse_failed", "Could not read upload data", 400);
    }

    const file = formData.get("file");
    const actorUsername = String(formData.get("actorUsername") || "");

    let actor: InventoryPhotoActor | null;

    try {
      actor = await getActor(supabaseAdmin, actorUsername);
    } catch (error) {
      console.error("[INVENTORY_PHOTO_ACTOR_FETCH_ERROR]", error);
      return jsonError("actor_fetch_failed", getErrorMessage(error), 500);
    }

    if (!actor) {
      return jsonError("invalid_user", "Invalid user", 401);
    }

    if (!(file instanceof File)) {
      return jsonError("missing_file", "Missing image file", 400);
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return jsonError(
        "unsupported_file_type",
        `Unsupported image type: ${file.type || "unknown"}`,
        400
      );
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return jsonError("file_too_large", "Image file is too large", 413);
    }

    let item: InventoryPhotoItem | null;

    try {
      item = await getInventoryItem(supabaseAdmin, itemId);
    } catch (error) {
      console.error("[INVENTORY_PHOTO_ITEM_FETCH_ERROR]", error);
      return jsonError("item_fetch_failed", getErrorMessage(error), 500);
    }

    if (!item) {
      return jsonError("item_not_found", "Target not found", 404);
    }

    const imagePath = createImagePath(itemId, file.type);
    const bytes = await file.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from(INVENTORY_IMAGE_BUCKET)
      .upload(imagePath, bytes, {
        contentType: file.type,
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("[INVENTORY_PHOTO_STORAGE_UPLOAD_ERROR]", uploadError);
      return jsonError(
        uploadError.message.toLowerCase().includes("bucket")
          ? "storage_bucket_not_found"
          : "storage_upload_failed",
        uploadError.message,
        500
      );
    }

    const { data: updatedItem, error: updateError } = await supabaseAdmin
      .from("inventory")
      .update({
        image_path: imagePath,
        updated_at: new Date().toISOString(),
        updated_by_name: actor.name || "",
        updated_by_username: actor.username || "",
      })
      .eq("id", itemId)
      .select("id, image_path, updated_at, updated_by_name")
      .single();

    if (updateError || !updatedItem) {
      console.error("[INVENTORY_PHOTO_DB_UPDATE_ERROR]", updateError);
      const { error: removeNewError } = await supabaseAdmin.storage
        .from(INVENTORY_IMAGE_BUCKET)
        .remove([imagePath]);

      if (removeNewError) {
        console.warn("[INVENTORY_PHOTO_REMOVE_NEW_WARNING]", removeNewError);
      }

      return jsonError(
        "database_update_failed",
        updateError?.message || "Image path update failed",
        500
      );
    }

    if (item.image_path && item.image_path !== imagePath) {
      const { error: removeOldError } = await supabaseAdmin.storage
        .from(INVENTORY_IMAGE_BUCKET)
        .remove([item.image_path]);

      if (removeOldError) {
        console.warn("[INVENTORY_PHOTO_REMOVE_OLD_WARNING]", removeOldError);
      }
    }

    const logError = await insertPhotoLog({
      supabaseAdmin,
      item,
      actor,
      note: item.image_path ? "품목 사진 변경" : "품목 사진 추가",
    });

    if (logError) {
      console.warn("[INVENTORY_PHOTO_LOG_INSERT_WARNING]", logError);
    }

    return NextResponse.json({
      ok: true,
      data: {
        ...updatedItem,
        image_url: supabaseAdmin.storage
          .from(INVENTORY_IMAGE_BUCKET)
          .getPublicUrl(imagePath).data.publicUrl,
        image_updated_at: updatedItem.updated_at,
        version: updatedItem.updated_at || imagePath,
      },
      logWarning: logError ? "photo_log_insert_failed" : null,
    });
  } catch (error) {
    console.error("[INVENTORY_PHOTO_POST_ERROR]", error);
    return jsonError("unexpected_server_error", getErrorMessage(error), 500);
  }
}

export const PUT = POST;

export async function DELETE(req: Request, context: RouteParams) {
  try {
    const { client: supabaseAdmin, error: envError, message: envMessage } =
      getSupabaseAdmin();

    if (!supabaseAdmin) {
      console.error("[INVENTORY_PHOTO_ENV_ERROR]", envMessage);
      return jsonError(envError || "missing_server_env", "Server is not configured", 500);
    }

    const itemId = await parseItemId(context);

    if (!itemId) {
      return jsonError("invalid_item_id", "Invalid item id", 400);
    }

    const body = await req.json().catch(() => ({}));
    const actor = await getActor(supabaseAdmin, body.actorUsername);

    if (!actor) {
      return jsonError("invalid_user", "Invalid user", 401);
    }

    let item: InventoryPhotoItem | null;

    try {
      item = await getInventoryItem(supabaseAdmin, itemId);
    } catch (error) {
      console.error("[INVENTORY_PHOTO_ITEM_FETCH_ERROR]", error);
      return jsonError("item_fetch_failed", getErrorMessage(error), 500);
    }

    if (!item) {
      return jsonError("item_not_found", "Target not found", 404);
    }

    if (item.image_path) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(INVENTORY_IMAGE_BUCKET)
        .remove([item.image_path]);

      if (removeError) {
        console.error("[INVENTORY_PHOTO_STORAGE_DELETE_ERROR]", removeError);
        return jsonError("storage_delete_failed", removeError.message, 500);
      }
    }

    const { data: updatedItem, error: updateError } = await supabaseAdmin
      .from("inventory")
      .update({
        image_path: null,
        updated_at: new Date().toISOString(),
        updated_by_name: actor.name || "",
        updated_by_username: actor.username || "",
      })
      .eq("id", itemId)
      .select("id, image_path, updated_at, updated_by_name")
      .single();

    if (updateError || !updatedItem) {
      console.error("[INVENTORY_PHOTO_DB_UPDATE_ERROR]", updateError);
      return jsonError(
        "database_update_failed",
        updateError?.message || "Image path update failed",
        500
      );
    }

    const logError = await insertPhotoLog({
      supabaseAdmin,
      item,
      actor,
      note: "품목 사진 삭제",
    });

    if (logError) {
      console.warn("[INVENTORY_PHOTO_LOG_INSERT_WARNING]", logError);
    }

    return NextResponse.json({
      ok: true,
      data: updatedItem,
      logWarning: logError ? "photo_log_insert_failed" : null,
    });
  } catch (error) {
    console.error("[INVENTORY_PHOTO_DELETE_ERROR]", error);
    return jsonError("unexpected_server_error", getErrorMessage(error), 500);
  }
}
