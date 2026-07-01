import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  getCatalogCode,
  groupProductsByCode,
  isMissingMappingSchemaError,
  type PosItemMappingRecipeRow,
  type PosItemMappingRow,
  type PosProductRow,
} from "@/lib/pos/mapping-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRODUCT_SELECT =
  "id, source, branch_id, pos_item_id, item_code, item_name, item_name_vi, category_name, unit_name, is_active, is_sold, raw_json";
const MAPPING_SELECT =
  "id, pos_item_code, pos_item_name, pos_unit_name, mapping_type, inventory_item_id, quantity_multiplier, is_active, pos_product_id, target_type, pos_option_id, pos_product_code_snapshot, pos_product_name_snapshot, pos_option_name_snapshot, mapping_version, last_reconciled_at, updated_at, updated_by, archived_at, archived_by, archive_reason";
const RECIPE_SELECT =
  "id, mapping_id, inventory_item_id, quantity_per_pos_unit, is_active, is_required, version";
const PAGE_SIZE = 1000;
const SAMPLE_LIMIT = 20;

type JsonObject = Record<string, unknown>;
type ReconcileSample = {
  mappingId: number;
  posItemCode: string | null;
  posProductId?: number;
  productName?: string;
  reason?: string;
};

async function getAdminActor(actorUsername: string) {
  if (!actorUsername) return null;

  const { data } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (
    !data ||
    (data.role !== "owner" &&
      data.role !== "master" &&
      data.role !== "manager")
  ) {
    return null;
  }

  return data;
}

async function fetchAllProducts() {
  const rows: PosProductRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseServer
      .from("pos_products")
      .select(PRODUCT_SELECT)
      .eq("source", "cukcuk")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data || []) as PosProductRow[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function fetchAllMappings() {
  const rows: PosItemMappingRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseServer
      .from("pos_item_mappings")
      .select(MAPPING_SELECT)
      .is("archived_at", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data || []) as PosItemMappingRow[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function fetchAllRecipes() {
  const rows: PosItemMappingRecipeRow[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseServer
      .from("pos_item_mapping_recipes")
      .select(RECIPE_SELECT)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data || []) as PosItemMappingRecipeRow[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function fetchInventoryIds() {
  const ids = new Set<number>();

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseServer
      .from("inventory")
      .select("id")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    for (const row of data || []) ids.add(Number(row.id));
    if (!data || data.length < PAGE_SIZE) return ids;
  }
}

function hasValidInventoryRule(params: {
  mapping: PosItemMappingRow;
  recipes: PosItemMappingRecipeRow[];
  inventoryIds: Set<number>;
}) {
  if (params.mapping.is_active !== true) return false;

  if (params.mapping.mapping_type === "direct") {
    return (
      Number(params.mapping.inventory_item_id) > 0 &&
      params.inventoryIds.has(Number(params.mapping.inventory_item_id)) &&
      Number(params.mapping.quantity_multiplier) > 0
    );
  }

  if (params.mapping.mapping_type === "recipe") {
    const activeRecipes = params.recipes.filter(
      (recipe) => recipe.is_active === true
    );
    const activeInventoryIds = activeRecipes.map((recipe) =>
      Number(recipe.inventory_item_id)
    );

    return (
      activeRecipes.length > 0 &&
      new Set(activeInventoryIds).size === activeInventoryIds.length &&
      activeRecipes.every(
        (recipe) =>
          params.inventoryIds.has(Number(recipe.inventory_item_id)) &&
          Number(recipe.quantity_per_pos_unit) > 0
      )
    );
  }

  return (
    params.mapping.mapping_type === "manual" ||
    params.mapping.mapping_type === "ignore"
  );
}

function pushSample(list: ReconcileSample[], sample: ReconcileSample) {
  if (list.length < SAMPLE_LIMIT) list.push(sample);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const actor = await getAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const [products, mappings, recipes, inventoryIds] = await Promise.all([
      fetchAllProducts(),
      fetchAllMappings(),
      fetchAllRecipes(),
      fetchInventoryIds(),
    ]);
    const productsById = new Map(
      products.map((product) => [Number(product.id), product])
    );
    const productsByCode = groupProductsByCode(products);
    const mappingsByProductId = new Map<number, PosItemMappingRow[]>();
    const recipesByMappingId = new Map<number, PosItemMappingRecipeRow[]>();

    for (const mapping of mappings) {
      if (!mapping.pos_product_id) continue;
      const productId = Number(mapping.pos_product_id);
      const rows = mappingsByProductId.get(productId) ?? [];
      rows.push(mapping);
      mappingsByProductId.set(productId, rows);
    }

    for (const recipe of recipes) {
      const rows = recipesByMappingId.get(Number(recipe.mapping_id)) ?? [];
      rows.push(recipe);
      recipesByMappingId.set(Number(recipe.mapping_id), rows);
    }
    const duplicateCodes = new Set(
      Array.from(productsByCode.entries())
        .filter(([, rows]) => rows.length > 1)
        .map(([code]) => code)
    );
    const now = new Date().toISOString();
    const samples = {
      linked: [] as ReconcileSample[],
      needsReview: [] as ReconcileSample[],
      orphaned: [] as ReconcileSample[],
      inactiveProducts: [] as ReconcileSample[],
    };
    let linkedCount = 0;
    let skippedCount = 0;
    let needsReviewCount = 0;
    let orphanedCount = 0;
    let inactiveProductCount = 0;

    for (const mapping of mappings) {
      if (mapping.target_type === "option") {
        skippedCount += 1;
        needsReviewCount += 1;
        pushSample(samples.needsReview, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          reason: "Option mappings are not auto-reconciled in this phase.",
        });
        continue;
      }

      if (mapping.pos_product_id) {
        const product = productsById.get(Number(mapping.pos_product_id));

        if (product) {
          const snapshotCode = getCatalogCode(
            mapping.pos_product_code_snapshot
          );
          const currentCode = getCatalogCode(product.item_code);

          if (snapshotCode && snapshotCode !== currentCode) {
            skippedCount += 1;
            needsReviewCount += 1;
            pushSample(samples.needsReview, {
              mappingId: mapping.id,
              posItemCode: mapping.pos_item_code,
              posProductId: Number(product.id),
              productName: product.item_name,
              reason:
                "POS product code changed after the previous reconciliation.",
            });

            if (product.is_active !== true) {
              inactiveProductCount += 1;
              pushSample(samples.inactiveProducts, {
                mappingId: mapping.id,
                posItemCode: mapping.pos_item_code,
                posProductId: Number(product.id),
                productName: product.item_name,
              });
            }
            continue;
          }

          const { error } = await supabaseServer
            .from("pos_item_mappings")
            .update({
              pos_product_code_snapshot: product.item_code,
              pos_product_name_snapshot: product.item_name,
              last_reconciled_at: now,
              updated_at: now,
              updated_by: actor.username,
            })
            .eq("id", mapping.id);

          if (error) throw error;
          skippedCount += 1;

          if (product.is_active !== true) {
            inactiveProductCount += 1;
            pushSample(samples.inactiveProducts, {
              mappingId: mapping.id,
              posItemCode: mapping.pos_item_code,
              posProductId: Number(product.id),
              productName: product.item_name,
            });
          }
          continue;
        }
      }

      const code = getCatalogCode(mapping.pos_item_code);

      if (!code) {
        skippedCount += 1;
        orphanedCount += 1;
        pushSample(samples.orphaned, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          reason: "Mapping has no POS item code.",
        });
        continue;
      }

      const candidates = productsByCode.get(code) ?? [];

      if (candidates.length === 0) {
        skippedCount += 1;
        orphanedCount += 1;
        pushSample(samples.orphaned, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          reason: "No current CUKCUK product has this exact item code.",
        });
        continue;
      }

      if (candidates.length !== 1) {
        skippedCount += 1;
        needsReviewCount += 1;
        pushSample(samples.needsReview, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          reason:
            "Multiple CUKCUK products or branches share this exact item code.",
        });
        continue;
      }

      const product = candidates[0];
      const conflictingMappings =
        mappingsByProductId.get(Number(product.id)) ?? [];

      if (conflictingMappings.length > 0) {
        skippedCount += 1;
        needsReviewCount += 1;
        pushSample(samples.needsReview, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          posProductId: Number(product.id),
          productName: product.item_name,
          reason:
            "The matching POS product is already linked to another mapping.",
        });
        continue;
      }

      if (
        mapping.pos_product_code_snapshot &&
        getCatalogCode(mapping.pos_product_code_snapshot) !==
          getCatalogCode(product.item_code)
      ) {
        skippedCount += 1;
        needsReviewCount += 1;
        pushSample(samples.needsReview, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          posProductId: Number(product.id),
          productName: product.item_name,
          reason:
            "The stored POS product code snapshot conflicts with the exact code match.",
        });
        continue;
      }

      if (
        !hasValidInventoryRule({
          mapping,
          recipes: recipesByMappingId.get(Number(mapping.id)) ?? [],
          inventoryIds,
        })
      ) {
        skippedCount += 1;
        needsReviewCount += 1;
        pushSample(samples.needsReview, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          posProductId: Number(product.id),
          productName: product.item_name,
          reason:
            "The mapping inventory rule is inactive, incomplete, or references a missing inventory item.",
        });
        continue;
      }

      let updateQuery = supabaseServer
        .from("pos_item_mappings")
        .update({
          pos_product_id: product.id,
          target_type: "product",
          pos_product_code_snapshot: product.item_code,
          pos_product_name_snapshot: product.item_name,
          last_reconciled_at: now,
          updated_at: now,
          updated_by: actor.username,
        })
        .eq("id", mapping.id);

      updateQuery = mapping.pos_product_id
        ? updateQuery.eq("pos_product_id", mapping.pos_product_id)
        : updateQuery.is("pos_product_id", null);

      const { data, error } = await updateQuery.select("id").maybeSingle();

      if (error) throw error;

      if (!data) {
        skippedCount += 1;
        needsReviewCount += 1;
        pushSample(samples.needsReview, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          reason: "Mapping changed while reconciliation was running.",
        });
        continue;
      }

      linkedCount += 1;
      pushSample(samples.linked, {
        mappingId: mapping.id,
        posItemCode: mapping.pos_item_code,
        posProductId: Number(product.id),
        productName: product.item_name,
      });

      if (product.is_active !== true) {
        inactiveProductCount += 1;
        pushSample(samples.inactiveProducts, {
          mappingId: mapping.id,
          posItemCode: mapping.pos_item_code,
          posProductId: Number(product.id),
          productName: product.item_name,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      linkedCount,
      skippedCount,
      needsReviewCount,
      orphanedCount,
      inactiveProductCount,
      duplicateCodeCount: duplicateCodes.size,
      samples,
      reconciledAt: now,
    });
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

    console.error("[ADMIN_POS_MAPPINGS_RECONCILE_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to reconcile POS mappings.",
      },
      { status: 500 }
    );
  }
}
