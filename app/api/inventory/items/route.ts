import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { roundDecimal } from "@/lib/inventory/number";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
  } catch (error: any) {
    console.error("[INVENTORY_ITEMS_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: error?.message || "Server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { payload, actorUsername, actorName } = body;

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

    const { error: logError } = await supabaseAdmin.from("inventory_logs").insert([
      {
        item_id: insertedData.id,
        item_name: insertedData.item_name ?? null,
        item_name_vi: insertedData.item_name_vi ?? null,
        action: "create",

        part: insertedData.part,
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
    ]);

    if (logError) throw logError;

    return NextResponse.json({ ok: true, data: insertedData });
  } catch (error: any) {
    console.error("[INVENTORY_POST_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: error?.message || "Server error" },
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
      actorName,
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
    low_stock_threshold
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
    low_stock_threshold
  `)
      .single();

    if (updateError || !updatedItem) throw updateError;

    const prevQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
    const newQuantity = roundDecimal(Number(updatedItem.quantity ?? 0));

    const { error: logError } = await supabaseAdmin.from("inventory_logs").insert([
      {
        item_id: updatedItem.id,
        item_name: updatedItem.item_name ?? null,
        item_name_vi: updatedItem.item_name_vi ?? null,
        action: "update",

        part: updatedItem.part,
        category: updatedItem.category ?? null,
        category_vi: updatedItem.category_vi ?? null,

        prev_quantity: prevQuantity,
        new_quantity: newQuantity,
        change_quantity: roundDecimal(newQuantity - prevQuantity),

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
    ]);

    if (logError) throw logError;

    return NextResponse.json({ ok: true, mode });
  } catch (error: any) {
    console.error("[INVENTORY_PATCH_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: error?.message || "Server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const { id, actorUsername, actorName } = body;

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
        low_stock_threshold
      `);

    if (deleteError) throw deleteError;

    if (!deletedRows || deletedRows.length === 0) {
      return NextResponse.json(
        { ok: false, message: "Target not found" },
        { status: 404 }
      );
    }

    const deletedItem = deletedRows[0];

    const { error: logError } = await supabaseAdmin.from("inventory_logs").insert([
      {
        item_id: deletedItem.id,
        item_name: deletedItem.item_name,
        item_name_vi: deletedItem.item_name_vi ?? null,
        action: "delete",

        part: deletedItem.part,
        category: deletedItem.category,
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
    ]);

    if (logError) throw logError;

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("[INVENTORY_DELETE_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: error?.message || "Server error" },
      { status: 500 }
    );
  }
}