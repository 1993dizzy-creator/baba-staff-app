import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  getMappingAdminActor,
  getPositiveInteger,
  getPositiveNumber,
  getRecipeMapping,
} from "@/lib/pos/mapping-admin";
import { isMissingMappingSchemaError } from "@/lib/pos/mapping-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECIPE_SELECT =
  "id, mapping_id, inventory_item_id, quantity_per_pos_unit, is_active, is_required, version, updated_at, updated_by";

type JsonObject = Record<string, unknown>;

async function getAuthorizedRecipe(params: {
  mappingIdValue: string;
  recipeIdValue: string;
  actorUsername: string;
}) {
  const mappingId = getPositiveInteger(params.mappingIdValue);
  const recipeId = getPositiveInteger(params.recipeIdValue);

  if (!mappingId || !recipeId) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Invalid mapping or recipe id." },
        { status: 400 }
      ),
    };
  }

  const actor = await getMappingAdminActor(params.actorUsername);
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

  const { data: recipe, error } = await supabaseServer
    .from("pos_item_mapping_recipes")
    .select(RECIPE_SELECT)
    .eq("id", recipeId)
    .eq("mapping_id", mappingId)
    .maybeSingle();

  if (error) throw error;
  if (!recipe) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Recipe row was not found." },
        { status: 404 }
      ),
    };
  }

  return { actor, mappingId, recipe };
}

function hasOwn(body: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; recipeId: string }> }
) {
  try {
    const { id, recipeId } = await context.params;
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const authorization = await getAuthorizedRecipe({
      mappingIdValue: id,
      recipeIdValue: recipeId,
      actorUsername,
    });
    if ("response" in authorization) return authorization.response;

    const quantityPerPosUnit = hasOwn(body, "quantityPerPosUnit")
      ? getPositiveNumber(body.quantityPerPosUnit)
      : getPositiveNumber(authorization.recipe.quantity_per_pos_unit);
    const isRequired = hasOwn(body, "isRequired")
      ? body.isRequired === true
      : authorization.recipe.is_required !== false;
    const isActive = hasOwn(body, "isActive")
      ? body.isActive === true
      : authorization.recipe.is_active === true;

    if (!quantityPerPosUnit) {
      return NextResponse.json(
        {
          ok: false,
          error: "quantityPerPosUnit must be greater than zero.",
        },
        { status: 400 }
      );
    }

    const currentVersion = Number(authorization.recipe.version ?? 1);
    const { data, error } = await supabaseServer
      .from("pos_item_mapping_recipes")
      .update({
        quantity_per_pos_unit: quantityPerPosUnit,
        is_required: isRequired,
        is_active: isActive,
        version: currentVersion + 1,
        updated_at: new Date().toISOString(),
        updated_by: authorization.actor.username,
      })
      .eq("id", authorization.recipe.id)
      .eq("mapping_id", authorization.mappingId)
      .eq("version", currentVersion)
      .select(RECIPE_SELECT)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        {
          ok: false,
          error: "Recipe row changed while it was being edited. Reload and retry.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, recipe: data });
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

    console.error("[ADMIN_POS_MAPPING_RECIPE_PATCH_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to update recipe.",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string; recipeId: string }> }
) {
  try {
    const { id, recipeId } = await context.params;
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const authorization = await getAuthorizedRecipe({
      mappingIdValue: id,
      recipeIdValue: recipeId,
      actorUsername,
    });
    if ("response" in authorization) return authorization.response;

    if (authorization.recipe.is_active !== true) {
      return NextResponse.json({ ok: true, recipe: authorization.recipe });
    }

    const currentVersion = Number(authorization.recipe.version ?? 1);
    const { data, error } = await supabaseServer
      .from("pos_item_mapping_recipes")
      .update({
        is_active: false,
        version: currentVersion + 1,
        updated_at: new Date().toISOString(),
        updated_by: authorization.actor.username,
      })
      .eq("id", authorization.recipe.id)
      .eq("mapping_id", authorization.mappingId)
      .eq("version", currentVersion)
      .select(RECIPE_SELECT)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Recipe row changed while it was being disabled. Reload and retry.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, recipe: data, softDeleted: true });
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

    console.error("[ADMIN_POS_MAPPING_RECIPE_DELETE_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to disable recipe.",
      },
      { status: 500 }
    );
  }
}
