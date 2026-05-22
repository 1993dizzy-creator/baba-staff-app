import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { roundDecimal } from "@/lib/inventory/number";
import { getBusinessDate } from "@/lib/common/business-time";
import { insertInventoryPriceLog } from "@/lib/inventory/price-logs";
import {
  type InventoryReasonValue,
  type InventorySourceValue,
  getReasonByRegistrationType,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const INVENTORY_IMAGE_BUCKET = "inventory-images";

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

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Server error";

type InventoryLogPayload = Record<string, unknown>;

const insertInventoryLog = async (
  payload: InventoryLogPayload,
  meta: {
    reason: InventoryReasonValue;
    source: InventorySourceValue;
    businessDate?: string;
  }
) => {
  const businessDate = meta.businessDate ?? getBusinessDate();
  const logPayload = {
    ...payload,
    reason: meta.reason,
    source: meta.source,
    business_date: businessDate,
  };

  const { data, error } = await supabaseAdmin
    .from("inventory_logs")
    .insert([logPayload])
    .select("id, reason, source, business_date")
    .single();

  if (error) throw error;

  if (data && (!data.reason || !data.source || !data.business_date)) {
    const { error: metadataError } = await supabaseAdmin
      .from("inventory_logs")
      .update({
        reason: meta.reason,
        source: meta.source,
        business_date: businessDate,
      })
      .eq("id", data.id);

    if (metadataError) throw metadataError;
  }

  return data;
};

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("inventory")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({
      ok: true,
      data: data || [],
    });
  } catch (error) {
    console.error("[INVENTORY_ITEMS_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { payload, actorUsername, registrationType, reason } = body;

    if (!payload) {
      return NextResponse.json(
        { ok: false, message: "Missing payload" },
        { status: 400 }
      );
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    const { data: insertedData, error } = await supabaseAdmin
      .from("inventory")
      .insert([payload])
      .select()
      .single();

    if (error || !insertedData) throw error;

    const logReason =
      registrationType === "existing_stock" || registrationType === "new_purchase"
        ? getReasonByRegistrationType(registrationType)
        : normalizeInventoryReason(reason, "unclassified");

    const businessDate = getBusinessDate();

    await insertInventoryLog(
      {
        item_id: insertedData.id,
        item_name: insertedData.item_name ?? null,
        item_name_vi: insertedData.item_name_vi ?? null,
        action: "create",

        part: insertedData.part ?? null,
        category: insertedData.category ?? null,
        category_vi: insertedData.category_vi ?? null,

        prev_quantity: 0,
        new_quantity: insertedData.quantity ?? 0,
        change_quantity: insertedData.quantity ?? 0,

        prev_purchase_price: null,
        new_purchase_price: insertedData.purchase_price ?? null,

        prev_note: null,
        new_note: insertedData.note ?? null,

        prev_supplier: null,
        new_supplier: insertedData.supplier ?? null,

        prev_code: null,
        new_code: insertedData.code ?? null,

        prev_unit: null,
        new_unit: insertedData.unit ?? null,

        prev_category: null,
        new_category: insertedData.category ?? null,

        prev_category_vi: null,
        new_category_vi: insertedData.category_vi ?? null,

        prev_part: null,
        new_part: insertedData.part ?? null,

        unit: insertedData.unit ?? null,
        code: insertedData.code ?? null,

        actor_name: actor.name || "",
        actor_username: actor.username || "",

        prev_low_stock_threshold: null,
        new_low_stock_threshold: insertedData.low_stock_threshold ?? 1,
      },
      {
        reason: logReason,
        source: "create",
        businessDate,
      }
    );

    await insertInventoryPriceLog({
      supabase: supabaseAdmin,
      itemId: insertedData.id,
      itemName: insertedData.item_name,
      itemCode: insertedData.code,
      oldPrice: null,
      newPrice: insertedData.purchase_price,
      businessDate,
      source: "create",
      reason: "create",
      actorUsername: actor.username,
    });

    return NextResponse.json({ ok: true, data: insertedData });
  } catch (error) {
    console.error("[INVENTORY_POST_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const {
      mode,
      id,
      payload,
      actorUsername,
      expectedQuantity,
      reason,
    } = body;

    if (!id || !payload) {
      return NextResponse.json(
        { ok: false, message: "Missing id or payload" },
        { status: 400 }
      );
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    const { data: prevItem, error: prevError } = await supabaseAdmin
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
      .eq("id", Number(id))
      .maybeSingle();

    if (prevError) throw prevError;

    if (!prevItem) {
      return NextResponse.json(
        { ok: false, message: "Target not found" },
        { status: 404 }
      );
    }

    if (mode === "quick-save" && expectedQuantity !== undefined) {
      const currentQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
      const baseQuantity = roundDecimal(Number(expectedQuantity));

      if (!Number.isFinite(baseQuantity)) {
        return NextResponse.json(
          { ok: false, message: "Invalid expected quantity" },
          { status: 400 }
        );
      }

      if (currentQuantity !== baseQuantity) {
        return NextResponse.json(
          {
            ok: false,
            code: "QUANTITY_CONFLICT",
            message:
              "Inventory quantity was changed by another user. Refresh and try again.",
            currentQuantity,
          },
          { status: 409 }
        );
      }
    }

    const { data: updatedItem, error: updateError } = await supabaseAdmin
      .from("inventory")
      .update(payload)
      .eq("id", Number(id))
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
      .single();

    if (updateError || !updatedItem) throw updateError;

    const prevQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
    const newQuantity = roundDecimal(Number(updatedItem.quantity ?? 0));
    const changeQuantity = roundDecimal(newQuantity - prevQuantity);
    const logReason =
      mode === "quick-save"
        ? normalizeInventoryReason(reason, "stock_check")
        : changeQuantity !== 0
          ? "stock_check"
          : "other";
    const logSource = mode === "quick-save" ? "quick_save" : "edit_form";

    const businessDate = getBusinessDate();

    await insertInventoryLog(
      {
        item_id: updatedItem.id,
        item_name: updatedItem.item_name ?? null,
        item_name_vi: updatedItem.item_name_vi ?? null,
        action: "update",

        part: updatedItem.part ?? null,
        category: updatedItem.category ?? null,
        category_vi: updatedItem.category_vi ?? null,

        prev_quantity: prevQuantity,
        new_quantity: newQuantity,
        change_quantity: changeQuantity,

        prev_purchase_price: prevItem.purchase_price ?? null,
        new_purchase_price: updatedItem.purchase_price ?? null,

        prev_note: prevItem.note ?? null,
        new_note: updatedItem.note ?? null,

        prev_supplier: prevItem.supplier ?? null,
        new_supplier: updatedItem.supplier ?? null,

        prev_code: prevItem.code ?? null,
        new_code: updatedItem.code ?? null,

        prev_unit: prevItem.unit ?? null,
        new_unit: updatedItem.unit ?? null,

        prev_category: prevItem.category ?? null,
        new_category: updatedItem.category ?? null,

        prev_category_vi: prevItem.category_vi ?? null,
        new_category_vi: updatedItem.category_vi ?? null,

        prev_part: prevItem.part ?? null,
        new_part: updatedItem.part ?? null,

        unit: updatedItem.unit ?? null,
        code: updatedItem.code ?? null,

        actor_name: actor.name || "",
        actor_username: actor.username || "",

        prev_low_stock_threshold: prevItem.low_stock_threshold ?? 1,
        new_low_stock_threshold: updatedItem.low_stock_threshold ?? 1,
      },
      {
        reason: logReason,
        source: logSource,
        businessDate,
      }
    );

    if (mode === "quick-save" && logReason === "purchase") {
      await insertInventoryPriceLog({
        supabase: supabaseAdmin,
        itemId: updatedItem.id,
        itemName: updatedItem.item_name,
        itemCode: updatedItem.code,
        oldPrice: prevItem.purchase_price,
        newPrice: updatedItem.purchase_price,
        businessDate,
        source: "quick_save",
        reason: "purchase",
        actorUsername: actor.username,
      });
    }

    if (
      mode !== "quick-save" &&
      Object.prototype.hasOwnProperty.call(payload, "purchase_price")
    ) {
      await insertInventoryPriceLog({
        supabase: supabaseAdmin,
        itemId: updatedItem.id,
        itemName: updatedItem.item_name,
        itemCode: updatedItem.code,
        oldPrice: prevItem.purchase_price,
        newPrice: updatedItem.purchase_price,
        businessDate: typeof body.business_date === "string" ? body.business_date : businessDate,
        source: "edit_form",
        reason: "manual_price_update",
        actorUsername: actor.username,
      });
    }

    return NextResponse.json({ ok: true, mode });
  } catch (error) {
    console.error("[INVENTORY_PATCH_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const { id, actorUsername } = body;

    if (!id) {
      return NextResponse.json(
        { ok: false, message: "Missing id" },
        { status: 400 }
      );
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    const { data: deletedRows, error: deleteError } = await supabaseAdmin
      .from("inventory")
      .delete()
      .eq("id", Number(id))
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
      `);

    if (deleteError) throw deleteError;

    if (!deletedRows || deletedRows.length === 0) {
      return NextResponse.json(
        { ok: false, message: "Target not found" },
        { status: 404 }
      );
    }

    const deletedItem = deletedRows[0];

    if (deletedItem.image_path) {
      const { error: removeImageError } = await supabaseAdmin.storage
        .from(INVENTORY_IMAGE_BUCKET)
        .remove([deletedItem.image_path]);

      if (removeImageError) {
        console.warn("[INVENTORY_DELETE_IMAGE_CLEANUP_ERROR]", removeImageError);
      }
    }

    await insertInventoryLog(
      {
        item_id: deletedItem.id,
        item_name: deletedItem.item_name ?? null,
        item_name_vi: deletedItem.item_name_vi ?? null,
        action: "delete",

        part: deletedItem.part ?? null,
        category: deletedItem.category ?? null,
        category_vi: deletedItem.category_vi ?? null,

        prev_quantity: deletedItem.quantity ?? 0,
        new_quantity: 0,
        change_quantity: -Number(deletedItem.quantity ?? 0),

        prev_purchase_price: deletedItem.purchase_price ?? null,
        new_purchase_price: null,

        prev_note: deletedItem.note ?? null,
        new_note: null,

        prev_supplier: deletedItem.supplier ?? null,
        new_supplier: null,

        prev_code: deletedItem.code ?? null,
        new_code: null,

        prev_unit: deletedItem.unit ?? null,
        new_unit: null,

        prev_category: deletedItem.category ?? null,
        new_category: null,

        prev_category_vi: deletedItem.category_vi ?? null,
        new_category_vi: null,

        prev_part: deletedItem.part ?? null,
        new_part: null,

        unit: deletedItem.unit ?? null,
        code: deletedItem.code ?? null,

        actor_name: actor.name || "",
        actor_username: actor.username || "",

        prev_low_stock_threshold: deletedItem.low_stock_threshold ?? 1,
        new_low_stock_threshold: null,
      },
      {
        reason: "other",
        source: "delete",
      }
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[INVENTORY_DELETE_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
