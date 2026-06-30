import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  getMappingAdminActor,
  getPositiveInteger,
  getPositiveNumber,
  getRecipeMapping,
  getSupabaseErrorCode,
  inventoryItemExists,
} from "@/lib/pos/mapping-admin";
import { isMissingMappingSchemaError } from "@/lib/pos/mapping-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECIPE_SELECT =
  "id, mapping_id, inventory_item_id, quantity_per_pos_unit, source_quantity, source_unit, source_package_content_quantity, source_package_content_unit, is_active, is_required, version, updated_at, updated_by";

type JsonObject = Record<string, unknown>;

function hasOwn(body: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function getOptionalPositiveNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getOptionalText(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

function isValidSourceRecipeInput(params: {
  sourceQuantity: number | null;
  sourceUnit: string | null;
  sourcePackageContentQuantity: number | null;
  sourcePackageContentUnit: string | null;
}) {
  const values = [
    params.sourceQuantity,
    params.sourceUnit,
    params.sourcePackageContentQuantity,
    params.sourcePackageContentUnit,
  ];
  if (values.every((value) => value === null)) return true;
  if (values.some((value) => value === null)) return false;
  return (
    params.sourceUnit === params.sourcePackageContentUnit &&
    (params.sourceUnit === "ml" || params.sourceUnit === "g")
  );
}

async function getAuthorizedMapping(
  mappingIdValue: string,
  actorUsername: string
) {
  const mappingId = getPositiveInteger(mappingIdValue);
  if (!mappingId) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Invalid mapping id." },
        { status: 400 }
      ),
    };
  }

  const actor = await getMappingAdminActor(actorUsername);
  if (!actor) {
    return {
      response: NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      ),
    };
  }

  const mapping = await getRecipeMapping(mappingId);
  if (!mapping) {
    return {
      response: NextResponse.json(
        { ok: false, error: "POS mapping was not found." },
        { status: 404 }
      ),
    };
  }

  if (mapping.mapping_type !== "recipe") {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "Recipe rows can only be managed for recipe mappings.",
        },
        { status: 400 }
      ),
    };
  }

  return { mappingId, actor };
}

async function serializeRecipes(mappingId: number) {
  const { data: recipes, error } = await supabaseServer
    .from("pos_item_mapping_recipes")
    .select(RECIPE_SELECT)
    .eq("mapping_id", mappingId)
    .order("is_active", { ascending: false })
    .order("id", { ascending: true });

  if (error) throw error;

  const inventoryIds = Array.from(
    new Set(
      (recipes || [])
        .map((recipe) => Number(recipe.inventory_item_id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  const inventoryById = new Map<
    number,
    {
      id: number;
      item_name: string | null;
      item_name_vi: string | null;
      code: string | null;
      unit: string | null;
      package_content_quantity: number | string | null;
      package_content_unit: string | null;
    }
  >();

  if (inventoryIds.length > 0) {
    const { data: inventoryItems, error: inventoryError } = await supabaseServer
      .from("inventory")
      .select("id, item_name, item_name_vi, code, unit, package_content_quantity, package_content_unit")
      .in("id", inventoryIds);

    if (inventoryError) throw inventoryError;
    for (const item of inventoryItems || []) {
      inventoryById.set(Number(item.id), item);
    }
  }

  return (recipes || []).map((recipe) => ({
    id: Number(recipe.id),
    mappingId: Number(recipe.mapping_id),
    inventoryItemId: Number(recipe.inventory_item_id),
    quantityPerPosUnit: Number(recipe.quantity_per_pos_unit),
    sourceQuantity:
      recipe.source_quantity === null || recipe.source_quantity === undefined
        ? null
        : Number(recipe.source_quantity),
    sourceUnit: recipe.source_unit ?? null,
    sourcePackageContentQuantity:
      recipe.source_package_content_quantity === null ||
      recipe.source_package_content_quantity === undefined
        ? null
        : Number(recipe.source_package_content_quantity),
    sourcePackageContentUnit: recipe.source_package_content_unit ?? null,
    isActive: recipe.is_active === true,
    isRequired: recipe.is_required !== false,
    version: Number(recipe.version ?? 1),
    updatedAt: recipe.updated_at,
    updatedBy: recipe.updated_by,
    inventoryItem: inventoryById.get(Number(recipe.inventory_item_id)) ?? null,
  }));
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const actorUsername = (
      new URL(req.url).searchParams.get("actorUsername") || ""
    ).trim();
    const authorization = await getAuthorizedMapping(id, actorUsername);
    if ("response" in authorization) return authorization.response;

    const recipes = await serializeRecipes(authorization.mappingId);
    return NextResponse.json({ ok: true, recipes });
  } catch (error) {
    if (isMissingMappingSchemaError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "POS mapping catalog migration has not been applied.",
        },
        { status: 503 }
      );
    }

    console.error("[ADMIN_POS_MAPPING_RECIPES_GET_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to load recipes.",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const authorization = await getAuthorizedMapping(id, actorUsername);
    if ("response" in authorization) return authorization.response;

    const inventoryItemId = getPositiveInteger(body.inventoryItemId);
    const quantityPerPosUnit = getPositiveNumber(body.quantityPerPosUnit);
    const sourceQuantity = getOptionalPositiveNumber(body.sourceQuantity);
    const sourceUnit = getOptionalText(body.sourceUnit);
    const sourcePackageContentQuantity = getOptionalPositiveNumber(
      body.sourcePackageContentQuantity
    );
    const sourcePackageContentUnit = getOptionalText(
      body.sourcePackageContentUnit
    );
    const isRequired = body.isRequired !== false;
    const isActive = body.isActive !== false;

    if (!inventoryItemId || !quantityPerPosUnit) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "inventoryItemId and a quantityPerPosUnit greater than zero are required.",
        },
        { status: 400 }
      );
    }

    if (
      sourceQuantity === undefined ||
      sourceUnit === undefined ||
      sourcePackageContentQuantity === undefined ||
      sourcePackageContentUnit === undefined ||
      !isValidSourceRecipeInput({
        sourceQuantity,
        sourceUnit,
        sourcePackageContentQuantity,
        sourcePackageContentUnit,
      })
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "sourceQuantity and sourcePackageContentQuantity must be greater than zero when provided.",
        },
        { status: 400 }
      );
    }

    if (!(await inventoryItemExists(inventoryItemId))) {
      return NextResponse.json(
        { ok: false, error: "Inventory item was not found." },
        { status: 400 }
      );
    }

    const { data: existingRows, error: existingError } = await supabaseServer
      .from("pos_item_mapping_recipes")
      .select(RECIPE_SELECT)
      .eq("mapping_id", authorization.mappingId)
      .eq("inventory_item_id", inventoryItemId)
      .order("id", { ascending: true });

    if (existingError) throw existingError;
    if ((existingRows || []).length > 1) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Multiple recipe rows already use this inventory item. Review existing data first.",
        },
        { status: 409 }
      );
    }

    const existing = existingRows?.[0];
    if (existing?.is_active === true) {
      return NextResponse.json(
        {
          ok: false,
          error: "This inventory item already exists in the active recipe.",
        },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    if (existing) {
      const { error } = await supabaseServer
        .from("pos_item_mapping_recipes")
        .update({
          quantity_per_pos_unit: quantityPerPosUnit,
          source_quantity: hasOwn(body, "sourceQuantity")
            ? sourceQuantity
            : existing.source_quantity ?? null,
          source_unit: hasOwn(body, "sourceUnit")
            ? sourceUnit
            : existing.source_unit ?? null,
          source_package_content_quantity: hasOwn(
            body,
            "sourcePackageContentQuantity"
          )
            ? sourcePackageContentQuantity
            : existing.source_package_content_quantity ?? null,
          source_package_content_unit: hasOwn(
            body,
            "sourcePackageContentUnit"
          )
            ? sourcePackageContentUnit
            : existing.source_package_content_unit ?? null,
          is_required: isRequired,
          is_active: isActive,
          version: Number(existing.version ?? 1) + 1,
          updated_at: now,
          updated_by: authorization.actor.username,
        })
        .eq("id", existing.id);

      if (error) throw error;
    } else {
      const { error } = await supabaseServer
        .from("pos_item_mapping_recipes")
        .insert({
          mapping_id: authorization.mappingId,
          inventory_item_id: inventoryItemId,
          quantity_per_pos_unit: quantityPerPosUnit,
          source_quantity: sourceQuantity,
          source_unit: sourceUnit,
          source_package_content_quantity: sourcePackageContentQuantity,
          source_package_content_unit: sourcePackageContentUnit,
          is_required: isRequired,
          is_active: isActive,
          version: 1,
          updated_at: now,
          updated_by: authorization.actor.username,
        });

      if (error) {
        if (getSupabaseErrorCode(error) === "23505") {
          return NextResponse.json(
            {
              ok: false,
              error: "This inventory item already exists in the recipe.",
            },
            { status: 409 }
          );
        }
        throw error;
      }
    }

    const recipes = await serializeRecipes(authorization.mappingId);
    return NextResponse.json(
      { ok: true, recipes, reactivated: Boolean(existing) },
      { status: existing ? 200 : 201 }
    );
  } catch (error) {
    if (isMissingMappingSchemaError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "POS mapping catalog migration has not been applied.",
        },
        { status: 503 }
      );
    }

    console.error("[ADMIN_POS_MAPPING_RECIPES_POST_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to create recipe.",
      },
      { status: 500 }
    );
  }
}
