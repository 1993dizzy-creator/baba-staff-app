import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getBusinessDate } from "@/lib/common/business-time";

const INVENTORY_IMAGE_BUCKET = "inventory-images";
const MAX_UPLOAD_BYTES = 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

const getActor = async (actorUsername?: string) => {
  if (!actorUsername) return null;

  const { data } = await supabaseAdmin
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  return data;
};

const parseItemId = async ({ params }: RouteParams) => {
  const { id } = await params;
  const itemId = Number(id);

  return Number.isInteger(itemId) && itemId > 0 ? itemId : null;
};

const getInventoryItem = async (itemId: number) => {
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

const insertPhotoLog = async ({
  item,
  actor,
  note,
}: {
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

  if (error) throw error;
};

export async function POST(req: Request, context: RouteParams) {
  try {
    const itemId = await parseItemId(context);

    if (!itemId) {
      return NextResponse.json(
        { ok: false, message: "Invalid item id" },
        { status: 400 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const actorUsername = String(formData.get("actorUsername") || "");

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, message: "Missing image file" },
        { status: 400 }
      );
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return NextResponse.json(
        { ok: false, message: "Unsupported image type" },
        { status: 400 }
      );
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, message: "Image file is too large" },
        { status: 400 }
      );
    }

    const item = await getInventoryItem(itemId);

    if (!item) {
      return NextResponse.json(
        { ok: false, message: "Target not found" },
        { status: 404 }
      );
    }

    const extension = getExtension(file.type);
    const imagePath = `inventory-items/${itemId}/main.${extension}`;
    const bytes = await file.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from(INVENTORY_IMAGE_BUCKET)
      .upload(imagePath, bytes, {
        contentType: file.type,
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) throw uploadError;

    if (item.image_path && item.image_path !== imagePath) {
      const { error: removeOldError } = await supabaseAdmin.storage
        .from(INVENTORY_IMAGE_BUCKET)
        .remove([item.image_path]);

      if (removeOldError) throw removeOldError;
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

    if (updateError || !updatedItem) throw updateError;

    await insertPhotoLog({
      item,
      actor,
      note: item.image_path ? "품목 사진 변경" : "품목 사진 추가",
    });

    return NextResponse.json({ ok: true, data: updatedItem });
  } catch (error) {
    console.error("[INVENTORY_PHOTO_POST_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export const PUT = POST;

export async function DELETE(req: Request, context: RouteParams) {
  try {
    const itemId = await parseItemId(context);

    if (!itemId) {
      return NextResponse.json(
        { ok: false, message: "Invalid item id" },
        { status: 400 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const actor = await getActor(body.actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    const item = await getInventoryItem(itemId);

    if (!item) {
      return NextResponse.json(
        { ok: false, message: "Target not found" },
        { status: 404 }
      );
    }

    if (item.image_path) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(INVENTORY_IMAGE_BUCKET)
        .remove([item.image_path]);

      if (removeError) throw removeError;
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

    if (updateError || !updatedItem) throw updateError;

    await insertPhotoLog({
      item,
      actor,
      note: "품목 사진 삭제",
    });

    return NextResponse.json({ ok: true, data: updatedItem });
  } catch (error) {
    console.error("[INVENTORY_PHOTO_DELETE_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
