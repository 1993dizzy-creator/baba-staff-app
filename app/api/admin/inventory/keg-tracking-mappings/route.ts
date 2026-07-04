import { NextResponse } from "next/server";
import {
  getMappingAdminActor,
  getPositiveInteger,
  getPositiveNumber,
  getSupabaseErrorCode,
} from "@/lib/pos/mapping-admin";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

const KEG_TRACKING_SELECT =
  "id, inventory_item_id, target_type, pos_product_id, pos_option_id, quantity_per_pos_unit, unit, is_active, updated_by, updated_at";

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function getKegInventoryItem(inventoryItemId: number) {
  const { data, error } = await supabaseServer
    .from("inventory")
    .select("id, item_name, item_name_vi, unit, package_content_quantity, package_content_unit")
    .eq("id", inventoryItemId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const unit = String(data.unit || "").trim().toLowerCase();
  const packageUnit = String(data.package_content_unit || "").trim().toLowerCase();
  const packageQuantity = Number(data.package_content_quantity ?? 0);

  if (unit !== "keg" || packageUnit !== "ml" || packageQuantity <= 0) {
    return null;
  }

  return data;
}

function serializeMapping(mapping: Record<string, unknown>, inventoryItem?: Record<string, unknown> | null) {
  return {
    id: Number(mapping.id),
    inventoryItemId: Number(mapping.inventory_item_id),
    inventoryItemName:
      getString(inventoryItem?.item_name_vi) ||
      getString(inventoryItem?.item_name) ||
      null,
    targetType: mapping.target_type,
    posProductId: Number(mapping.pos_product_id),
    posOptionId: mapping.pos_option_id ?? null,
    quantityPerPosUnit: Number(mapping.quantity_per_pos_unit),
    unit: mapping.unit || "ml",
    isActive: mapping.is_active === true,
    updatedAt: mapping.updated_at ?? null,
    updatedBy: mapping.updated_by ?? null,
  };
}

function writeError(error: unknown) {
  const code = getSupabaseErrorCode(error);
  if (code === "23505") {
    return NextResponse.json(
      { ok: false, error: "Active keg tracking already exists for this POS product." },
      { status: 409 }
    );
  }

  if (code === "23503" || code === "23514") {
    return NextResponse.json(
      { ok: false, error: "Invalid keg tracking mapping payload." },
      { status: 400 }
    );
  }

  return null;
}

export async function GET(req: Request) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const actorUsername = getString(searchParams.get("actorUsername"));
    const posProductId = getPositiveInteger(searchParams.get("posProductId"));
    const actor = await getMappingAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json({ ok: false, error: "No permission" }, { status: 403 });
    }

    if (!posProductId) {
      return NextResponse.json(
        { ok: false, error: "posProductId is required." },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseServer
      .from("inventory_keg_tracking_mappings")
      .select(KEG_TRACKING_SELECT)
      .eq("target_type", "product")
      .eq("pos_product_id", posProductId)
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ ok: true, mapping: null });

    const inventoryItem = await getKegInventoryItem(Number(data.inventory_item_id));
    return NextResponse.json({
      ok: true,
      mapping: serializeMapping(data, inventoryItem),
    });
  } catch (error) {
    console.error("[ADMIN_KEG_TRACKING_MAPPINGS_GET_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to load keg tracking mapping.",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername = getString(body.actorUsername);
    const actor = await getMappingAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json({ ok: false, error: "No permission" }, { status: 403 });
    }

    const posProductId = getPositiveInteger(body.posProductId);
    const inventoryItemId = getPositiveInteger(body.inventoryItemId);
    const quantityPerPosUnit = getPositiveNumber(body.quantityPerPosUnit);

    if (!posProductId || !inventoryItemId || !quantityPerPosUnit) {
      return NextResponse.json(
        {
          ok: false,
          error: "posProductId, inventoryItemId, and quantityPerPosUnit are required.",
        },
        { status: 400 }
      );
    }

    const inventoryItem = await getKegInventoryItem(inventoryItemId);
    if (!inventoryItem) {
      return NextResponse.json(
        { ok: false, error: "Selected inventory item is not a valid ml Keg item." },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseServer
      .from("inventory_keg_tracking_mappings")
      .insert({
        inventory_item_id: inventoryItemId,
        target_type: "product",
        pos_product_id: posProductId,
        pos_option_id: null,
        quantity_per_pos_unit: quantityPerPosUnit,
        unit: "ml",
        is_active: true,
        updated_by: actor.username,
      })
      .select(KEG_TRACKING_SELECT)
      .single();

    if (error) {
      const response = writeError(error);
      if (response) return response;
      throw error;
    }

    return NextResponse.json(
      { ok: true, mapping: serializeMapping(data, inventoryItem) },
      { status: 201 }
    );
  } catch (error) {
    console.error("[ADMIN_KEG_TRACKING_MAPPINGS_POST_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save keg tracking mapping.",
      },
      { status: 500 }
    );
  }
}
