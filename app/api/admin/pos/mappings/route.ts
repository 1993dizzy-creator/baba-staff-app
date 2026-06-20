import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  extractProductChildren,
  extractProductOptions,
  findLegacyProductCandidates,
  findProductForChild,
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

type MappingStatus =
  | "unmapped"
  | "mapped"
  | "recipe_mapped"
  | "combo_mapped"
  | "ignored"
  | "manual"
  | "inactive_product"
  | "orphaned"
  | "archived"
  | "needs_review";
type OptionMappingStatus = Exclude<
  MappingStatus,
  "inactive_product" | "orphaned" | "archived"
>;

type JsonObject = Record<string, unknown>;
type MappingType = "direct" | "recipe" | "combo" | "manual" | "ignore";
type TargetType = "product" | "option";
type ValidationStatus = "normal" | "needs_review" | "incomplete" | "error";
type InventorySummary = {
  id: number;
  item_name: string | null;
  item_name_vi: string | null;
  code: string | null;
  unit: string | null;
};
type ComboChildSummary = {
  childId: string;
  childCode: string | null;
  childName: string;
  quantity: number;
  posProductId: number | null;
  mappingType: string | null;
  status: MappingStatus;
  validationStatus: ValidationStatus;
  blockedReason: string | null;
};

const MAPPING_TYPES = new Set<MappingType>([
  "direct",
  "recipe",
  "combo",
  "manual",
  "ignore",
]);
const TARGET_TYPES = new Set<TargetType>(["product", "option"]);

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

function getPositiveNumber(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getSupabaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function mappingWriteError(error: unknown) {
  const code = getSupabaseErrorCode(error);

  if (code === "23505") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "A mapping already exists for this POS product, option, or item code.",
      },
      { status: 409 }
    );
  }

  if (code === "23503") {
    return NextResponse.json(
      {
        ok: false,
        error: "The selected POS product or inventory item does not exist.",
      },
      { status: 400 }
    );
  }

  return null;
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
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...((data || []) as PosItemMappingRow[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function fetchRecipes(mappingIds: number[]) {
  if (mappingIds.length === 0) return [] as PosItemMappingRecipeRow[];

  const rows: PosItemMappingRecipeRow[] = [];

  for (let offset = 0; offset < mappingIds.length; offset += 500) {
    const { data, error } = await supabaseServer
      .from("pos_item_mapping_recipes")
      .select(RECIPE_SELECT)
      .in("mapping_id", mappingIds.slice(offset, offset + 500))
      .order("id", { ascending: true });

    if (error) throw error;
    rows.push(...((data || []) as PosItemMappingRecipeRow[]));
  }

  return rows;
}

async function fetchInventorySummaries(inventoryIds: number[]) {
  if (inventoryIds.length === 0) return new Map<number, InventorySummary>();

  const { data, error } = await supabaseServer
    .from("inventory")
    .select("id, item_name, item_name_vi, code, unit")
    .in("id", inventoryIds);

  if (error) throw error;
  return new Map(
    ((data || []) as InventorySummary[]).map((item) => [Number(item.id), item])
  );
}

async function fetchReferenceCounts(mappingIds: number[]) {
  const counts = new Map<
    number,
    { recipeCount: number; deductionCount: number; processedLineCount: number }
  >(
    mappingIds.map((id) => [
      id,
      { recipeCount: 0, deductionCount: 0, processedLineCount: 0 },
    ])
  );
  if (mappingIds.length === 0) return counts;

  for (let offset = 0; offset < mappingIds.length; offset += 500) {
    const ids = mappingIds.slice(offset, offset + 500);
    const [recipeResult, deductionResult, processedResult] = await Promise.all([
      supabaseServer
        .from("pos_item_mapping_recipes")
        .select("mapping_id")
        .in("mapping_id", ids),
      supabaseServer
        .from("pos_inventory_deductions")
        .select("mapping_id")
        .in("mapping_id", ids),
      supabaseServer
        .from("pos_processed_invoice_lines")
        .select("mapping_id")
        .in("mapping_id", ids),
    ]);

    if (recipeResult.error) throw recipeResult.error;
    if (deductionResult.error) throw deductionResult.error;
    if (processedResult.error) throw processedResult.error;

    for (const row of recipeResult.data || []) {
      const value = counts.get(Number(row.mapping_id));
      if (value) value.recipeCount += 1;
    }
    for (const row of deductionResult.data || []) {
      const value = counts.get(Number(row.mapping_id));
      if (value) value.deductionCount += 1;
    }
    for (const row of processedResult.data || []) {
      const value = counts.get(Number(row.mapping_id));
      if (value) value.processedLineCount += 1;
    }
  }

  return counts;
}

function serializeMapping(
  mapping: PosItemMappingRow | null,
  recipes: PosItemMappingRecipeRow[],
  inventoryById: Map<number, InventorySummary>
) {
  if (!mapping) return null;

  return {
    id: mapping.id,
    mappingType: mapping.mapping_type,
    inventoryItemId: mapping.inventory_item_id,
    inventoryItem: mapping.inventory_item_id
      ? inventoryById.get(Number(mapping.inventory_item_id)) ?? null
      : null,
    quantityMultiplier: Number(mapping.quantity_multiplier ?? 1),
    isActive: mapping.is_active === true,
    targetType: mapping.target_type,
    posOptionId: mapping.pos_option_id,
    mappingVersion: Number(mapping.mapping_version ?? 1),
    posItemCode: mapping.pos_item_code,
    posItemName: mapping.pos_item_name,
    productCodeSnapshot: mapping.pos_product_code_snapshot,
    productNameSnapshot: mapping.pos_product_name_snapshot,
    lastReconciledAt: mapping.last_reconciled_at,
    archivedAt: mapping.archived_at,
    archivedBy: mapping.archived_by,
    archiveReason: mapping.archive_reason,
    recipes: recipes.map((recipe) => ({
      id: recipe.id,
      inventoryItemId: recipe.inventory_item_id,
      inventoryItem:
        inventoryById.get(Number(recipe.inventory_item_id)) ?? null,
      quantityPerPosUnit: Number(recipe.quantity_per_pos_unit ?? 0),
      isActive: recipe.is_active === true,
      isRequired: recipe.is_required !== false,
      version: Number(recipe.version ?? 1),
    })),
  };
}

function getRuleStatus(params: {
  mapping: PosItemMappingRow | null;
  candidates: PosItemMappingRow[];
  recipes: PosItemMappingRecipeRow[];
  inventoryById: Map<number, InventorySummary>;
  linkedByCode?: boolean;
  comboChildren?: ComboChildSummary[];
}) {
  if (params.candidates.length > 1) {
    return {
      status: "needs_review" as const,
      validationStatus: "error" as ValidationStatus,
      blockedReason: "Multiple mappings match this POS catalog target.",
    };
  }

  if (!params.mapping) {
    return {
      status: "unmapped" as const,
      validationStatus: "incomplete" as ValidationStatus,
      blockedReason: "Inventory deduction mapping has not been configured.",
    };
  }

  if (params.linkedByCode) {
    return {
      status: getMappingTypeStatus(params.mapping.mapping_type),
      validationStatus: "needs_review" as ValidationStatus,
      blockedReason:
        "Mapping matches by item code but has not been linked to pos_product_id.",
    };
  }

  if (params.mapping.is_active !== true) {
    return {
      status: "unmapped" as const,
      validationStatus: "incomplete" as ValidationStatus,
      blockedReason: "The linked mapping is inactive.",
    };
  }

  if (params.mapping.mapping_type === "direct") {
    if (!params.mapping.inventory_item_id) {
      return {
        status: "mapped" as const,
        validationStatus: "incomplete" as ValidationStatus,
        blockedReason: "Direct mapping has no inventory item.",
      };
    }
    if (!params.inventoryById.has(Number(params.mapping.inventory_item_id))) {
      return {
        status: "mapped" as const,
        validationStatus: "error" as ValidationStatus,
        blockedReason: "Direct mapping references a missing inventory item.",
      };
    }
    return {
      status: "mapped" as const,
      validationStatus: "normal" as ValidationStatus,
      blockedReason: null,
    };
  }

  if (params.mapping.mapping_type === "recipe") {
    if (params.recipes.length === 0) {
      return {
        status: "recipe_mapped" as const,
        validationStatus: "incomplete" as ValidationStatus,
        blockedReason: "Recipe ingredients have not been configured.",
      };
    }
    if (!params.recipes.some((recipe) => recipe.is_required !== false)) {
      return {
        status: "recipe_mapped" as const,
        validationStatus: "incomplete" as ValidationStatus,
        blockedReason: "Recipe has no required ingredients.",
      };
    }
    if (
      params.recipes.some(
        (recipe) =>
          !params.inventoryById.has(Number(recipe.inventory_item_id))
      )
    ) {
      return {
        status: "recipe_mapped" as const,
        validationStatus: "error" as ValidationStatus,
        blockedReason: "Recipe references a missing inventory item.",
      };
    }
    if (
      params.recipes.some(
        (recipe) => Number(recipe.quantity_per_pos_unit ?? 0) <= 0
      )
    ) {
      return {
        status: "recipe_mapped" as const,
        validationStatus: "error" as ValidationStatus,
        blockedReason: "Recipe contains an invalid deduction quantity.",
      };
    }
    const inventoryIds = params.recipes.map((recipe) =>
      Number(recipe.inventory_item_id)
    );
    if (new Set(inventoryIds).size !== inventoryIds.length) {
      return {
        status: "recipe_mapped" as const,
        validationStatus: "error" as ValidationStatus,
        blockedReason: "Recipe contains duplicate inventory ingredients.",
      };
    }
    if (
      params.recipes.some(
        (recipe) =>
          recipe.is_required !== false && recipe.is_active !== true
      )
    ) {
      return {
        status: "recipe_mapped" as const,
        validationStatus: "incomplete" as ValidationStatus,
        blockedReason: "A required recipe ingredient is inactive.",
      };
    }
    return {
      status: "recipe_mapped" as const,
      validationStatus: "normal" as ValidationStatus,
      blockedReason: null,
    };
  }

  if (params.mapping.mapping_type === "combo") {
    if (!params.comboChildren || params.comboChildren.length === 0) {
      return {
        status: "combo_mapped" as const,
        validationStatus: "incomplete" as ValidationStatus,
        blockedReason: "Combo has no active child products.",
      };
    }
    const blockingChild = params.comboChildren.find(
      (child) => child.validationStatus !== "normal"
    );
    return {
      status: "combo_mapped" as const,
      validationStatus: blockingChild
        ? blockingChild.validationStatus
        : ("normal" as ValidationStatus),
      blockedReason: blockingChild?.blockedReason ?? null,
    };
  }

  if (params.mapping.mapping_type === "ignore") {
    return {
      status: "ignored" as const,
      validationStatus: "normal" as ValidationStatus,
      blockedReason: null,
    };
  }

  if (params.mapping.mapping_type === "manual") {
    return {
      status: "manual" as const,
      validationStatus: "needs_review" as ValidationStatus,
      blockedReason: "Manual mapping requires administrator review.",
    };
  }

  return {
    status: "needs_review" as const,
    validationStatus: "error" as ValidationStatus,
    blockedReason: "Mapping type is not supported.",
  };
}

function getMappingTypeStatus(mappingType: string | null) {
  if (mappingType === "direct") return "mapped" as const;
  if (mappingType === "recipe") return "recipe_mapped" as const;
  if (mappingType === "combo") return "combo_mapped" as const;
  if (mappingType === "manual") return "manual" as const;
  if (mappingType === "ignore") return "ignored" as const;
  return "needs_review" as const;
}

function getMappedStatus(params: {
  product: PosProductRow;
  mapping: PosItemMappingRow | null;
  candidates: PosItemMappingRow[];
  recipes: PosItemMappingRecipeRow[];
  inventoryById: Map<number, InventorySummary>;
  linkedByCode: boolean;
  comboChildren?: ComboChildSummary[];
}) {
  if (params.product.is_active !== true) {
    return {
      status: "inactive_product" as const,
      validationStatus: "normal" as ValidationStatus,
      blockedReason: "POS product is inactive.",
    };
  }

  if (
    params.mapping &&
    params.mapping.pos_product_code_snapshot &&
    getCatalogCode(params.mapping.pos_product_code_snapshot) !==
      getCatalogCode(params.product.item_code)
  ) {
    return {
      status: getMappingTypeStatus(params.mapping.mapping_type),
      validationStatus: "needs_review" as ValidationStatus,
      blockedReason: "POS product code changed after the last reconciliation.",
    };
  }

  return getRuleStatus(params);
}

export async function GET(req: Request) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const actorUsername = (searchParams.get("actorUsername") || "").trim();
    const statusFilter = (searchParams.get("status") || "all").trim();
    const search = (searchParams.get("search") || "").trim().toLowerCase();
    const includeOptions = searchParams.get("includeOptions") !== "false";
    const limit = Math.min(
      Math.max(Number(searchParams.get("limit") || 100), 1),
      500
    );
    const offset = Math.max(Number(searchParams.get("offset") || 0), 0);
    const actor = await getAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const [products, mappings] = await Promise.all([
      fetchAllProducts(),
      fetchAllMappings(),
    ]);
    const recipes = await fetchRecipes(mappings.map((mapping) => mapping.id));
    const inventoryById = await fetchInventorySummaries(
      Array.from(
        new Set(
          [
            ...mappings.map((mapping) => mapping.inventory_item_id),
            ...recipes.map((recipe) => recipe.inventory_item_id),
          ]
            .map(Number)
            .filter((id) => Number.isInteger(id) && id > 0)
        )
      )
    );
    const productsById = new Map(
      products.map((product) => [Number(product.id), product])
    );
    const productsByCode = groupProductsByCode(products);
    const recipesByMappingId = new Map<number, PosItemMappingRecipeRow[]>();

    for (const recipe of recipes) {
      const rows = recipesByMappingId.get(Number(recipe.mapping_id)) ?? [];
      rows.push(recipe);
      recipesByMappingId.set(Number(recipe.mapping_id), rows);
    }

    const currentMappings = mappings.filter((mapping) => !mapping.archived_at);
    const archivedMappings = mappings.filter((mapping) => mapping.archived_at);
    const productMappings = currentMappings.filter(
      (mapping) => mapping.target_type === "product"
    );
    const optionMappings = currentMappings.filter(
      (mapping) => mapping.target_type === "option"
    );
    const mappingsByProductId = new Map<number, PosItemMappingRow[]>();
    const unlinkedMappingsByCode = new Map<string, PosItemMappingRow[]>();
    const mappingsByOptionKey = new Map<string, PosItemMappingRow[]>();

    for (const mapping of productMappings) {
      if (
        mapping.pos_product_id &&
        productsById.has(Number(mapping.pos_product_id))
      ) {
        const rows =
          mappingsByProductId.get(Number(mapping.pos_product_id)) ?? [];
        rows.push(mapping);
        mappingsByProductId.set(Number(mapping.pos_product_id), rows);
        continue;
      }

      const code = getCatalogCode(mapping.pos_item_code);
      if (!code) continue;
      const rows = unlinkedMappingsByCode.get(code) ?? [];
      rows.push(mapping);
      unlinkedMappingsByCode.set(code, rows);
    }

    for (const mapping of optionMappings) {
      if (!mapping.pos_product_id || !mapping.pos_option_id) continue;
      const key = `${Number(mapping.pos_product_id)}:${mapping.pos_option_id}`;
      const rows = mappingsByOptionKey.get(key) ?? [];
      rows.push(mapping);
      mappingsByOptionKey.set(key, rows);
    }

    const serializeComboChildren = (
      product: PosProductRow
    ): ComboChildSummary[] =>
      extractProductChildren(product)
        .filter((child) => child.isActive)
        .map((child) => {
          const childProducts = findProductForChild(child, products);
          const childProduct =
            childProducts.length === 1 ? childProducts[0] : null;
          const childCandidates = childProduct
            ? mappingsByProductId.get(Number(childProduct.id)) ?? []
            : [];
          const childMapping =
            childCandidates.length === 1 ? childCandidates[0] : null;
          const childRecipes = childMapping
            ? recipesByMappingId.get(Number(childMapping.id)) ?? []
            : [];
          const state =
            childMapping?.mapping_type === "combo"
              ? {
                  status: "needs_review" as const,
                  validationStatus: "error" as ValidationStatus,
                  blockedReason: "Combo inside combo is not supported.",
                }
              : childProducts.length !== 1 || childCandidates.length > 1
                ? {
                    status: "needs_review" as const,
                    validationStatus: "error" as ValidationStatus,
                    blockedReason:
                      childProducts.length > 1 || childCandidates.length > 1
                        ? "Combo child matches multiple products or mappings."
                        : "Combo child is not linked to an active POS product.",
                  }
                : getRuleStatus({
                    mapping: childMapping,
                    candidates: childCandidates,
                    recipes: childRecipes,
                    inventoryById,
                  });

          return {
            childId: child.id,
            childCode: child.code,
            childName: child.name,
            quantity: child.quantity,
            posProductId: childProduct ? Number(childProduct.id) : null,
            mappingType: childMapping?.mapping_type ?? null,
            status: state.status,
            validationStatus: state.validationStatus,
            blockedReason: state.blockedReason,
          };
        });

    const orphanedMappings = productMappings.filter((mapping) => {
      if (
        mapping.pos_product_id &&
        productsById.has(Number(mapping.pos_product_id))
      ) {
        return false;
      }
      const code = getCatalogCode(mapping.pos_item_code);
      return !code || (productsByCode.get(code)?.length ?? 0) === 0;
    });
    const referenceCounts = await fetchReferenceCounts(
      orphanedMappings.map((mapping) => Number(mapping.id))
    );

    const productItems = products.map((product) => {
      const linkedCandidates =
        mappingsByProductId.get(Number(product.id)) ?? [];
      const codeCandidates =
        linkedCandidates.length === 0
          ? unlinkedMappingsByCode.get(getCatalogCode(product.item_code)) ?? []
          : [];
      const candidates = [...linkedCandidates, ...codeCandidates];
      const mapping = candidates.length === 1 ? candidates[0] : null;
      const mappingRecipes = mapping
        ? recipesByMappingId.get(Number(mapping.id)) ?? []
        : [];
      const comboChildren =
        mapping?.mapping_type === "combo"
          ? serializeComboChildren(product)
          : [];
      const state = getMappedStatus({
        product,
        mapping,
        candidates,
        recipes: mappingRecipes,
        inventoryById,
        linkedByCode: linkedCandidates.length === 0 && codeCandidates.length > 0,
        comboChildren,
      });
      const options = includeOptions
        ? extractProductOptions(product).map((option) => {
            const optionCandidates =
              mappingsByOptionKey.get(`${Number(product.id)}:${option.id}`) ??
              [];
            const optionMapping =
              optionCandidates.length === 1 ? optionCandidates[0] : null;
            const optionRecipes = optionMapping
              ? recipesByMappingId.get(Number(optionMapping.id)) ?? []
              : [];
            const optionState = getRuleStatus({
              mapping: optionMapping,
              candidates: optionCandidates,
              recipes: optionRecipes,
              inventoryById,
            });

            return {
              ...option,
              optionId: option.id,
              optionName: option.name,
              status: optionState.status as OptionMappingStatus,
              validationStatus: optionState.validationStatus,
              blockedReason: optionState.blockedReason,
              mappingType: optionMapping?.mapping_type ?? null,
              inventoryItemId: optionMapping?.inventory_item_id ?? null,
              quantityMultiplier: optionMapping
                ? Number(optionMapping.quantity_multiplier ?? 1)
                : null,
              inventoryItem: optionMapping?.inventory_item_id
                ? inventoryById.get(Number(optionMapping.inventory_item_id)) ??
                  null
                : null,
              mapping: serializeMapping(
                optionMapping,
                optionRecipes,
                inventoryById
              ),
            };
          })
        : undefined;

      return {
        status: state.status,
        mappingType: mapping?.mapping_type ?? null,
        validationStatus: state.validationStatus,
        blockedReason: state.blockedReason,
        needsReviewReason:
          state.validationStatus !== "normal" ? state.blockedReason : null,
        posProduct: {
          id: product.id,
          branchId: product.branch_id,
          posItemId: product.pos_item_id,
          itemCode: product.item_code,
          itemName: product.item_name,
          itemNameVi: product.item_name_vi,
          categoryName: product.category_name,
          unitName: product.unit_name,
          isActive: product.is_active === true,
          isSold: product.is_sold,
        },
        mapping: serializeMapping(mapping, mappingRecipes, inventoryById),
        comboChildren,
        options,
      };
    });

    const orphanedItems = orphanedMappings.map((mapping) => {
        const legacyCandidates = findLegacyProductCandidates(
          mapping.pos_item_code,
          products
        );
        const references = referenceCounts.get(Number(mapping.id)) ?? {
          recipeCount: 0,
          deductionCount: 0,
          processedLineCount: 0,
        };
        return {
            status: "orphaned" as const,
            mappingType: mapping.mapping_type,
            validationStatus: "error" as const,
            blockedReason:
              "The mapping record remains, but no matching product exists in the current POS catalog.",
            needsReviewReason: null,
            posProduct: null,
            mapping: serializeMapping(
              mapping,
              recipesByMappingId.get(Number(mapping.id)) ?? [],
              inventoryById
            ),
            legacyCandidates: legacyCandidates.map((product) => ({
              id: product.id,
              itemCode: product.item_code,
              itemName: product.item_name,
              isActive: product.is_active === true,
            })),
            referenceCounts: references,
            canHardDelete:
              legacyCandidates.length === 0 &&
              references.recipeCount === 0 &&
              references.deductionCount === 0 &&
              references.processedLineCount === 0,
            options: includeOptions ? [] : undefined,
          };
      });

    const archivedItems = archivedMappings.map((mapping) => ({
      status: "archived" as const,
      mappingType: mapping.mapping_type,
      validationStatus: "normal" as const,
      blockedReason: null,
      needsReviewReason: null,
      posProduct: null,
      mapping: serializeMapping(
        mapping,
        recipesByMappingId.get(Number(mapping.id)) ?? [],
        inventoryById
      ),
      options: includeOptions ? [] : undefined,
    }));

    const activeProductItems = productItems.filter(
      (item) => item.posProduct?.isActive === true
    );
    const itemHasMappingType = (
      item: (typeof productItems)[number],
      mappingType: MappingType
    ) =>
      item.mappingType === mappingType ||
      (item.options || []).some(
        (option) => option.mappingType === mappingType
      );
    const itemUsesOptionBasedDeduction = (
      item: (typeof productItems)[number]
    ) =>
      item.mappingType === "ignore" &&
      (item.options || []).some(
        (option) =>
          option.mappingType === "direct" ||
          option.mappingType === "recipe"
      );
    const itemNeedsReview = (item: (typeof productItems)[number]) =>
      item.validationStatus !== "normal" ||
      (item.options || []).some(
        (option) => option.validationStatus !== "normal"
      );
    const allItems =
      statusFilter === "archived"
        ? archivedItems
        : statusFilter === "orphaned"
        ? orphanedItems
        : statusFilter === "all"
          ? productItems
          : statusFilter === "mapped"
            ? activeProductItems.filter((item) =>
                itemHasMappingType(item, "direct")
              )
            : statusFilter === "recipe_mapped"
              ? activeProductItems.filter((item) =>
                  itemHasMappingType(item, "recipe")
                )
            : statusFilter === "combo_mapped"
              ? activeProductItems.filter((item) =>
                  itemHasMappingType(item, "combo")
                )
              : statusFilter === "manual"
                ? activeProductItems.filter((item) =>
                    itemHasMappingType(item, "manual")
                  )
                : statusFilter === "option_based"
                  ? activeProductItems.filter(itemUsesOptionBasedDeduction)
                : statusFilter === "ignored"
                  ? activeProductItems.filter((item) =>
                      itemHasMappingType(item, "ignore") &&
                      !itemUsesOptionBasedDeduction(item)
                    )
                  : statusFilter === "needs_review"
                    ? activeProductItems.filter(itemNeedsReview)
                    : productItems.filter(
                        (item) => item.status === statusFilter
                      );
    const searchedItems = search
      ? allItems.filter((item) =>
          [
            item.posProduct?.itemCode,
            item.posProduct?.itemName,
            item.posProduct?.itemNameVi,
            item.mapping?.posItemCode,
            item.mapping?.posItemName,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(search)
        )
      : allItems;
    const summary: Record<MappingStatus, number> & {
      option_based: number;
    } = {
      unmapped: activeProductItems.filter((item) => !item.mapping).length,
      mapped: activeProductItems.filter((item) =>
        itemHasMappingType(item, "direct")
      ).length,
      recipe_mapped: activeProductItems.filter((item) =>
        itemHasMappingType(item, "recipe")
      ).length,
      combo_mapped: activeProductItems.filter((item) =>
        itemHasMappingType(item, "combo")
      ).length,
      ignored: activeProductItems.filter((item) =>
        itemHasMappingType(item, "ignore") &&
        !itemUsesOptionBasedDeduction(item)
      ).length,
      option_based: activeProductItems.filter(itemUsesOptionBasedDeduction)
        .length,
      manual: activeProductItems.filter((item) =>
        itemHasMappingType(item, "manual")
      ).length,
      inactive_product: productItems.filter(
        (item) => item.posProduct?.isActive === false
      ).length,
      orphaned: orphanedItems.length,
      archived: archivedItems.length,
      needs_review: activeProductItems.filter(itemNeedsReview).length,
    };

    return NextResponse.json({
      ok: true,
      summary,
      total: searchedItems.length,
      limit,
      offset,
      items: searchedItems.slice(offset, offset + limit),
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

    console.error("[ADMIN_POS_MAPPINGS_GET_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load POS mappings.",
      },
      { status: 500 }
    );
  }
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

    const posProductId = getPositiveInteger(body.posProductId);
    const mappingType =
      typeof body.mappingType === "string" &&
      MAPPING_TYPES.has(body.mappingType as MappingType)
        ? (body.mappingType as MappingType)
        : null;
    const targetType =
      typeof body.targetType === "string" &&
      TARGET_TYPES.has(body.targetType as TargetType)
        ? (body.targetType as TargetType)
        : "product";
    const posOptionId =
      typeof body.posOptionId === "string" && body.posOptionId.trim()
        ? body.posOptionId.trim()
        : null;
    const quantityMultiplier = getPositiveNumber(body.quantityMultiplier, 1);
    const inventoryItemId =
      body.inventoryItemId === undefined ||
      body.inventoryItemId === null ||
      body.inventoryItemId === ""
        ? null
        : getPositiveInteger(body.inventoryItemId);
    const isActive = body.isActive !== false;

    if (!posProductId || !mappingType) {
      return NextResponse.json(
        { ok: false, error: "posProductId and mappingType are required." },
        { status: 400 }
      );
    }

    if (!quantityMultiplier) {
      return NextResponse.json(
        { ok: false, error: "quantityMultiplier must be greater than zero." },
        { status: 400 }
      );
    }

    if (mappingType === "direct" && !inventoryItemId) {
      return NextResponse.json(
        { ok: false, error: "Direct mappings require an inventory item." },
        { status: 400 }
      );
    }

    if (mappingType === "combo" && targetType !== "product") {
      return NextResponse.json(
        { ok: false, error: "Combo mappings are only supported for products." },
        { status: 400 }
      );
    }

    if (targetType === "option" && !posOptionId) {
      return NextResponse.json(
        { ok: false, error: "Option mappings require posOptionId." },
        { status: 400 }
      );
    }

    const { data: product, error: productError } = await supabaseServer
      .from("pos_products")
      .select(PRODUCT_SELECT)
      .eq("id", posProductId)
      .eq("source", "cukcuk")
      .maybeSingle();

    if (productError) throw productError;
    if (!product) {
      return NextResponse.json(
        { ok: false, error: "CUKCUK POS product was not found." },
        { status: 404 }
      );
    }

    if (inventoryItemId) {
      const { data: inventoryItem, error: inventoryError } =
        await supabaseServer
          .from("inventory")
          .select("id")
          .eq("id", inventoryItemId)
          .maybeSingle();

      if (inventoryError) throw inventoryError;
      if (!inventoryItem) {
        return NextResponse.json(
          { ok: false, error: "Inventory item was not found." },
          { status: 400 }
        );
      }
    }

    const typedProduct = product as PosProductRow;
    const option =
      targetType === "option"
        ? extractProductOptions(typedProduct).find(
            (item) => item.id === posOptionId
          )
        : null;

    if (targetType === "option" && !option) {
      return NextResponse.json(
        { ok: false, error: "POS option was not found in the product catalog." },
        { status: 400 }
      );
    }

    const productCode = getCatalogCode(typedProduct.item_code);
    if (!productCode) {
      return NextResponse.json(
        { ok: false, error: "POS product has no item code." },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const storedInventoryItemId =
      mappingType === "direct" ? inventoryItemId : null;
    const legacyCode =
      targetType === "option"
        ? `${productCode}::option::${posOptionId}`
        : productCode;
    const legacyName =
      targetType === "option"
        ? `${typedProduct.item_name} / ${option?.name || posOptionId}`
        : typedProduct.item_name;
    const { data, error } = await supabaseServer
      .from("pos_item_mappings")
      .insert({
        pos_item_code: legacyCode,
        pos_item_name: legacyName,
        pos_unit_name: typedProduct.unit_name,
        mapping_type: mappingType,
        inventory_item_id: storedInventoryItemId,
        quantity_multiplier: quantityMultiplier,
        is_active: isActive,
        pos_product_id: typedProduct.id,
        target_type: targetType,
        pos_option_id: targetType === "option" ? posOptionId : null,
        pos_product_code_snapshot: typedProduct.item_code,
        pos_product_name_snapshot: typedProduct.item_name,
        pos_option_name_snapshot: option?.name ?? null,
        mapping_version: 1,
        last_reconciled_at: now,
        updated_at: now,
        updated_by: actor.username,
      })
      .select(MAPPING_SELECT)
      .single();

    if (error) {
      const response = mappingWriteError(error);
      if (response) return response;
      throw error;
    }

    return NextResponse.json({ ok: true, mapping: data }, { status: 201 });
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

    console.error("[ADMIN_POS_MAPPINGS_POST_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to create POS mapping.",
      },
      { status: 500 }
    );
  }
}
