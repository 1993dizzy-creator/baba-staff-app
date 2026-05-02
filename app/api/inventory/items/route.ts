import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

const isMaster = (user: any) => user?.role === "master";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");

  try {
    if (mode === "list") {
      const { data, error } = await supabaseAdmin
        .from("inventory")
        .select("*")
        .order("updated_at", { ascending: false });

      if (error) throw error;

      return NextResponse.json({ ok: true, data: data || [] });
    }

    if (mode === "recent-logs") {
      const { data, error } = await supabaseAdmin
        .from("inventory_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(3);

      if (error) throw error;

      return NextResponse.json({ ok: true, data: data || [] });
    }

    if (mode === "item-logs") {
      const itemId = searchParams.get("itemId");

      if (!itemId) {
        return NextResponse.json(
          { ok: false, message: "Missing itemId" },
          { status: 400 }
        );
      }

      const { data, error } = await supabaseAdmin
        .from("inventory_logs")
        .select("*")
        .eq("item_id", Number(itemId))
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      return NextResponse.json({ ok: true, data: data || [] });
    }

    if (mode === "latest-snapshot") {
      const { data: batchRow, error: batchError } = await supabaseAdmin
        .from("inventory_snapshot_batches")
        .select("id, snapshot_date")
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (batchError) throw batchError;

      if (!batchRow) {
        return NextResponse.json({
          ok: true,
          data: {
            snapshotDate: "",
            snapshotMap: {},
          },
        });
      }

      const { data: snapshotItems, error: itemsError } = await supabaseAdmin
        .from("inventory_snapshot_items")
        .select("item_id, quantity")
        .eq("batch_id", batchRow.id);

      if (itemsError) throw itemsError;

      const snapshotMap: Record<number, number> = {};

      (snapshotItems || []).forEach((row: any) => {
        if (row.item_id !== null && row.item_id !== undefined) {
          snapshotMap[Number(row.item_id)] = Number(row.quantity ?? 0);
        }
      });

      return NextResponse.json({
        ok: true,
        data: {
          snapshotDate: batchRow.snapshot_date || "",
          snapshotMap,
        },
      });
    }

    return NextResponse.json(
      { ok: false, message: "Invalid mode" },
      { status: 400 }
    );
  } catch (error: any) {
    console.error("[INVENTORY_GET_ERROR]", error);
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

        actor_name: actorName || actor.name || "",
        actor_username: actorUsername || actor.username || "",

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
      logPayload,
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

    const { error: updateError } = await supabaseAdmin
      .from("inventory")
      .update(payload)
      .eq("id", Number(id));

    if (updateError) throw updateError;

    if (logPayload) {
      const { error: logError } = await supabaseAdmin.from("inventory_logs").insert([
        {
          ...logPayload,
          actor_name: actorName || actor.name || "",
          actor_username: actorUsername || actor.username || "",
        },
      ]);

      if (logError) throw logError;
    }

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

        actor_name: actorName || actor.name || "",
        actor_username: actorUsername || actor.username || "",

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