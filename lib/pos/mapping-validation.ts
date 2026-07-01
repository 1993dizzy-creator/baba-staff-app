import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  extractProductChildren,
  extractProductOptions,
  findProductForChild,
  getCatalogCode,
  groupProductsByCode,
  type PosItemMappingRecipeRow,
  type PosItemMappingRow,
  type PosProductRow,
} from "@/lib/pos/mapping-catalog";

const PRODUCT_SELECT =
  "id, source, branch_id, pos_item_id, item_code, item_name, item_name_vi, category_name, unit_name, is_active, is_sold, raw_json";
const MAPPING_SELECT =
  "id, pos_item_code, pos_item_name, pos_unit_name, mapping_type, inventory_item_id, quantity_multiplier, is_active, pos_product_id, target_type, pos_option_id, pos_product_code_snapshot, pos_product_name_snapshot, pos_option_name_snapshot, mapping_version, last_reconciled_at, updated_at, updated_by, archived_at, archived_by, archive_reason";
const RECIPE_SELECT =
  "id, mapping_id, inventory_item_id, quantity_per_pos_unit, is_active, is_required, version";
const PAGE_SIZE = 1000;

export type MappingValidationSeverity = "error" | "warning" | "info";
export type MappingValidationIssueType =
  | "unmapped_product"
  | "unmapped_option"
  | "invalid_direct"
  | "invalid_recipe"
  | "manual_review"
  | "orphaned_mapping"
  | "inactive_product_mapping"
  | "duplicate_mapping"
  | "missing_pos_product"
  | "missing_option_id"
  | "invalid_combo";

export type MappingValidationIssue = {
  severity: MappingValidationSeverity;
  type: MappingValidationIssueType;
  message: string;
  posProductId: number | null;
  posProductName: string | null;
  posItemCode: string | null;
  optionId: string | null;
  optionName: string | null;
  mappingId: number | null;
  recipeId: number | null;
};

export type MappingValidationSummary = {
  totalProducts: number;
  activeProducts: number;
  mappedCount: number;
  recipeMappedCount: number;
  ignoredCount: number;
  manualCount: number;
  comboMappedCount: number;
  unmappedCount: number;
  optionUnmappedCount: number;
  invalidDirectCount: number;
  invalidRecipeCount: number;
  orphanedCount: number;
  inactiveProductMappingCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  readyForPreview: boolean;
};

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

async function fetchAllRecipes(mappingIds: number[]) {
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

async function fetchInventoryIds(inventoryIds: number[]) {
  if (inventoryIds.length === 0) return new Set<number>();

  const { data, error } = await supabaseServer
    .from("inventory")
    .select("id")
    .in("id", inventoryIds);

  if (error) throw error;
  return new Set((data || []).map((item) => Number(item.id)));
}

function issue(
  issues: MappingValidationIssue[],
  value: MappingValidationIssue
) {
  issues.push(value);
}

function issueFor(params: {
  severity: MappingValidationSeverity;
  type: MappingValidationIssueType;
  message: string;
  product?: PosProductRow | null;
  mapping?: PosItemMappingRow | null;
  recipe?: PosItemMappingRecipeRow | null;
  option?: { id: string; name: string } | null;
}) {
  return {
    severity: params.severity,
    type: params.type,
    message: params.message,
    posProductId: params.product ? Number(params.product.id) : null,
    posProductName:
      params.product?.item_name ??
      params.mapping?.pos_product_name_snapshot ??
      params.mapping?.pos_item_name ??
      null,
    posItemCode:
      params.product?.item_code ?? params.mapping?.pos_item_code ?? null,
    optionId: params.option?.id ?? params.mapping?.pos_option_id ?? null,
    optionName:
      params.option?.name ?? params.mapping?.pos_option_name_snapshot ?? null,
    mappingId: params.mapping ? Number(params.mapping.id) : null,
    recipeId: params.recipe ? Number(params.recipe.id) : null,
  } satisfies MappingValidationIssue;
}

function validateRecipe(params: {
  issues: MappingValidationIssue[];
  invalidRecipeIds: Set<number>;
  product: PosProductRow | null;
  option: { id: string; name: string } | null;
  mapping: PosItemMappingRow;
  recipes: PosItemMappingRecipeRow[];
  inventoryIds: Set<number>;
}) {
  const activeRecipes = params.recipes.filter(
    (recipe) => recipe.is_active === true
  );
  let invalid = false;

  if (activeRecipes.length === 0) {
    invalid = true;
    issue(
      params.issues,
      issueFor({
        severity: "error",
        type: "invalid_recipe",
        message: "Recipe mapping에 활성 재료가 없습니다.",
        ...params,
      })
    );
  }

  const inventoryCounts = new Map<number, number>();
  for (const recipe of activeRecipes) {
    const inventoryItemId = Number(recipe.inventory_item_id);
    if (
      !Number.isInteger(inventoryItemId) ||
      inventoryItemId <= 0 ||
      !params.inventoryIds.has(inventoryItemId)
    ) {
      invalid = true;
      issue(
        params.issues,
        issueFor({
          severity: "error",
          type: "invalid_recipe",
          message: "Recipe 재료에 inventory 품목이 없습니다.",
          recipe,
          ...params,
        })
      );
    }

    const quantityPerPosUnit = Number(recipe.quantity_per_pos_unit);
    if (!Number.isFinite(quantityPerPosUnit) || quantityPerPosUnit <= 0) {
      invalid = true;
      issue(
        params.issues,
        issueFor({
          severity: "error",
          type: "invalid_recipe",
          message: "Recipe 재료 차감 수량은 0보다 커야 합니다.",
          recipe,
          ...params,
        })
      );
    }

    if (inventoryItemId > 0) {
      inventoryCounts.set(
        inventoryItemId,
        (inventoryCounts.get(inventoryItemId) ?? 0) + 1
      );
    }
  }

  if (Array.from(inventoryCounts.values()).some((count) => count > 1)) {
    invalid = true;
    issue(
      params.issues,
      issueFor({
        severity: "error",
        type: "invalid_recipe",
        message: "Recipe에 동일한 inventory 품목이 중복 등록되어 있습니다.",
        ...params,
      })
    );
  }

  if (invalid) params.invalidRecipeIds.add(Number(params.mapping.id));
  return !invalid;
}

function validateDirect(params: {
  issues: MappingValidationIssue[];
  invalidDirectIds: Set<number>;
  product: PosProductRow | null;
  option: { id: string; name: string } | null;
  mapping: PosItemMappingRow;
}) {
  const messages: string[] = [];

  if (!params.mapping.inventory_item_id) {
    messages.push("inventory 품목이 없습니다.");
  }
  if (Number(params.mapping.quantity_multiplier) <= 0) {
    messages.push("차감 배수는 0보다 커야 합니다.");
  }
  if (!params.mapping.pos_product_id) {
    messages.push("pos_product_id 연결이 없습니다.");
  }
  if (
    params.mapping.target_type !== "product" &&
    params.mapping.target_type !== "option"
  ) {
    messages.push("target_type이 올바르지 않습니다.");
  }

  for (const message of messages) {
    issue(
      params.issues,
      issueFor({
        severity: "error",
        type: "invalid_direct",
        message: `Direct mapping에 ${message}`,
        ...params,
      })
    );
  }

  if (messages.length > 0) {
    params.invalidDirectIds.add(Number(params.mapping.id));
  }
  return messages.length === 0;
}

function validateCombo(params: {
  issues: MappingValidationIssue[];
  product: PosProductRow;
  mapping: PosItemMappingRow;
  products: PosProductRow[];
  productMappingsByProductId: Map<number, PosItemMappingRow[]>;
  recipesByMappingId: Map<number, PosItemMappingRecipeRow[]>;
  inventoryIds: Set<number>;
  invalidComboIds: Set<number>;
  invalidRecipeIds: Set<number>;
}) {
  let invalid = false;

  if (params.mapping.target_type !== "product") {
    invalid = true;
    issue(
      params.issues,
      issueFor({
        severity: "error",
        type: "invalid_combo",
        message: "Combo mapping is only supported for product mappings.",
        product: params.product,
        mapping: params.mapping,
      })
    );
  }

  const children = extractProductChildren(params.product).filter(
    (child) => child.isActive
  );

  if (children.length === 0) {
    invalid = true;
    issue(
      params.issues,
      issueFor({
        severity: "error",
        type: "invalid_combo",
        message: "Combo mapping has no active Children in POS catalog data.",
        product: params.product,
        mapping: params.mapping,
      })
    );
  }

  for (const child of children) {
    const childProducts = findProductForChild(child, params.products);
    if (childProducts.length !== 1) {
      invalid = true;
      issue(
        params.issues,
        issueFor({
          severity: "error",
          type: "invalid_combo",
          message:
            childProducts.length > 1
              ? "Combo child matches multiple active POS products."
              : "Combo child is not linked to an active POS product.",
          product: params.product,
          mapping: params.mapping,
          option: { id: child.id, name: child.name },
        })
      );
      continue;
    }

    const childProduct = childProducts[0];
    const childMappings =
      params.productMappingsByProductId.get(Number(childProduct.id)) ?? [];
    if (childMappings.length !== 1) {
      invalid = true;
      issue(
        params.issues,
        issueFor({
          severity: "error",
          type: "invalid_combo",
          message:
            childMappings.length > 1
              ? "Combo child has multiple active product mappings."
              : "Combo child product has no active product mapping.",
          product: childProduct,
          mapping: params.mapping,
          option: { id: child.id, name: child.name },
        })
      );
      continue;
    }

    const childMapping = childMappings[0];
    if (childMapping.mapping_type === "combo") {
      invalid = true;
      issue(
        params.issues,
        issueFor({
          severity: "error",
          type: "invalid_combo",
          message: "Combo inside combo is not supported.",
          product: childProduct,
          mapping: childMapping,
          option: { id: child.id, name: child.name },
        })
      );
      continue;
    }

    if (childMapping.mapping_type === "direct") {
      if (!childMapping.inventory_item_id) invalid = true;
      validateDirect({
        issues: params.issues,
        invalidDirectIds: params.invalidComboIds,
        product: childProduct,
        option: null,
        mapping: childMapping,
      });
      continue;
    }

    if (childMapping.mapping_type === "recipe") {
      const valid = validateRecipe({
        issues: params.issues,
        invalidRecipeIds: params.invalidRecipeIds,
        product: childProduct,
        option: null,
        mapping: childMapping,
        recipes: params.recipesByMappingId.get(Number(childMapping.id)) ?? [],
        inventoryIds: params.inventoryIds,
      });
      if (!valid) invalid = true;
    }
  }

  if (invalid) params.invalidComboIds.add(Number(params.mapping.id));
  return !invalid;
}

export async function validatePosMappings() {
  const [products, mappings] = await Promise.all([
    fetchAllProducts(),
    fetchAllMappings(),
  ]);
  const recipes = await fetchAllRecipes(mappings.map((mapping) => mapping.id));
  const inventoryIds = await fetchInventoryIds(
    Array.from(
      new Set(
        [
          ...mappings.map((mapping) => Number(mapping.inventory_item_id)),
          ...recipes.map((recipe) => Number(recipe.inventory_item_id)),
        ].filter((id) => Number.isInteger(id) && id > 0)
      )
    )
  );
  const issues: MappingValidationIssue[] = [];
  const invalidDirectIds = new Set<number>();
  const invalidRecipeIds = new Set<number>();
  const invalidComboIds = new Set<number>();
  const orphanedIds = new Set<number>();
  const inactiveProductMappingIds = new Set<number>();
  const recipesByMappingId = new Map<number, PosItemMappingRecipeRow[]>();
  const productsById = new Map(
    products.map((product) => [Number(product.id), product])
  );
  const productsByCode = groupProductsByCode(products);
  const activeMappings = mappings.filter(
    (mapping) => mapping.is_active === true
  );
  const productMappingsByProductId = new Map<number, PosItemMappingRow[]>();
  const optionMappingsByKey = new Map<string, PosItemMappingRow[]>();

  for (const recipe of recipes) {
    const rows = recipesByMappingId.get(Number(recipe.mapping_id)) ?? [];
    rows.push(recipe);
    recipesByMappingId.set(Number(recipe.mapping_id), rows);
  }

  for (const mapping of activeMappings) {
    if (mapping.target_type === "product" && mapping.pos_product_id) {
      const rows =
        productMappingsByProductId.get(Number(mapping.pos_product_id)) ?? [];
      rows.push(mapping);
      productMappingsByProductId.set(Number(mapping.pos_product_id), rows);
    }
    if (
      mapping.target_type === "option" &&
      mapping.pos_product_id &&
      mapping.pos_option_id
    ) {
      const key = `${Number(mapping.pos_product_id)}:${mapping.pos_option_id}`;
      const rows = optionMappingsByKey.get(key) ?? [];
      rows.push(mapping);
      optionMappingsByKey.set(key, rows);
    }
  }

  let mappedCount = 0;
  let recipeMappedCount = 0;
  let ignoredCount = 0;
  let manualCount = 0;
  let unmappedCount = 0;
  let optionUnmappedCount = 0;

  const validateMappingRule = (params: {
    product: PosProductRow;
    option: { id: string; name: string } | null;
    mapping: PosItemMappingRow;
  }) => {
    if (params.mapping.mapping_type === "direct") {
      return validateDirect({
        issues,
        invalidDirectIds,
        ...params,
      });
    }
    if (params.mapping.mapping_type === "recipe") {
      return validateRecipe({
        issues,
        invalidRecipeIds,
        recipes:
          recipesByMappingId.get(Number(params.mapping.id)) ?? [],
        inventoryIds,
        ...params,
      });
    }
    if (params.mapping.mapping_type === "combo") {
      if (params.option) {
        invalidComboIds.add(Number(params.mapping.id));
        issue(
          issues,
          issueFor({
            severity: "error",
            type: "invalid_combo",
            message: "Combo mapping is not supported on POS options.",
            ...params,
          })
        );
        return false;
      }
      return validateCombo({
        issues,
        product: params.product,
        mapping: params.mapping,
        products,
        productMappingsByProductId,
        recipesByMappingId,
        inventoryIds,
        invalidComboIds,
        invalidRecipeIds,
      });
    }
    if (params.mapping.mapping_type === "manual") {
      manualCount += 1;
      issue(
        issues,
        issueFor({
          severity: "warning",
          type: "manual_review",
          message: params.option
            ? "옵션 mapping이 manual 검토 대상으로 설정되어 있습니다."
            : "상품 mapping이 manual 검토 대상으로 설정되어 있습니다.",
          ...params,
        })
      );
      return true;
    }
    if (params.mapping.mapping_type === "ignore") {
      ignoredCount += 1;
      return true;
    }

    issue(
      issues,
      issueFor({
        severity: "error",
        type: "invalid_direct",
        message: "지원하지 않는 mapping_type입니다.",
        ...params,
      })
    );
    invalidDirectIds.add(Number(params.mapping.id));
    return false;
  };

  for (const product of products.filter(
    (candidate) => candidate.is_active === true
  )) {
    const productCandidates =
      productMappingsByProductId.get(Number(product.id)) ?? [];

    if (productCandidates.length === 0) {
      unmappedCount += 1;
      const codeCandidates = activeMappings.filter(
        (mapping) =>
          mapping.target_type === "product" &&
          !mapping.pos_product_id &&
          getCatalogCode(mapping.pos_item_code) ===
            getCatalogCode(product.item_code)
      );

      if (codeCandidates.length > 0) {
        for (const mapping of codeCandidates) {
          issue(
            issues,
            issueFor({
              severity: "error",
              type: "missing_pos_product",
              message:
                "상품 code는 일치하지만 mapping에 pos_product_id 연결이 없습니다.",
              product,
              mapping,
            })
          );
        }
      } else {
        issue(
          issues,
          issueFor({
            severity: "error",
            type: "unmapped_product",
            message: "활성 POS 상품에 재고 차감 mapping이 없습니다.",
            product,
          })
        );
      }
    } else if (productCandidates.length > 1) {
      issue(
        issues,
        issueFor({
          severity: "error",
          type: "duplicate_mapping",
          message: "활성 POS 상품에 active mapping이 여러 개 연결되어 있습니다.",
          product,
          mapping: productCandidates[0],
        })
      );
    } else {
      const mapping = productCandidates[0];
      const valid = validateMappingRule({ product, option: null, mapping });
      if (valid && mapping.mapping_type === "direct") mappedCount += 1;
      if (valid && mapping.mapping_type === "recipe") recipeMappedCount += 1;
      if (valid && mapping.mapping_type === "combo") mappedCount += 1;
    }

    const activeOptions = extractProductOptions(product).filter(
      (candidate) => candidate.isActive
    );
    let unmappedActiveOptionCount = 0;

    for (const option of activeOptions) {
      const optionCandidates =
        optionMappingsByKey.get(`${Number(product.id)}:${option.id}`) ?? [];

      if (optionCandidates.length === 0) {
        unmappedActiveOptionCount += 1;
        optionUnmappedCount += 1;
        issue(
          issues,
          issueFor({
            severity: "error",
            type: "unmapped_option",
            message: "활성 POS 옵션에 mapping이 없습니다.",
            product,
            option,
          })
        );
        continue;
      }

      if (optionCandidates.length > 1) {
        issue(
          issues,
          issueFor({
            severity: "error",
          type: "duplicate_mapping",
          message: "POS 옵션에 active mapping이 여러 개 연결되어 있습니다.",
          product,
          option,
          mapping: optionCandidates[0],
        })
      );
        continue;
      }

      validateMappingRule({
        product,
        option,
        mapping: optionCandidates[0],
      });
    }

    if (
      activeOptions.length > 0 &&
      unmappedActiveOptionCount === activeOptions.length
    ) {
      issue(
        issues,
        issueFor({
          severity: "warning",
          type: "unmapped_option",
          message: "이 활성 POS 상품의 모든 활성 옵션이 미매핑 상태입니다.",
          product,
        })
      );
    }
  }

  for (const mapping of activeMappings) {
    const targetType = String(mapping.target_type || "");
    const product = mapping.pos_product_id
      ? productsById.get(Number(mapping.pos_product_id)) ?? null
      : null;

    if (
      mapping.mapping_type === "direct" &&
      targetType !== "product" &&
      targetType !== "option"
    ) {
      invalidDirectIds.add(Number(mapping.id));
      issue(
        issues,
        issueFor({
          severity: "error",
          type: "invalid_direct",
          message: "Direct mapping의 target_type이 올바르지 않습니다.",
          mapping,
        })
      );
    }

    if (mapping.target_type === "option" && !mapping.pos_option_id) {
      issue(
        issues,
        issueFor({
          severity: "error",
          type: "missing_option_id",
          message: "옵션 mapping에 pos_option_id가 없습니다.",
          product,
          mapping,
        })
      );
    }

    if (!mapping.pos_product_id) {
      if (mapping.target_type === "option") {
        orphanedIds.add(Number(mapping.id));
        issue(
          issues,
          issueFor({
            severity: "error",
            type: "missing_pos_product",
            message: "옵션 mapping에 부모 pos_product_id 연결이 없습니다.",
            mapping,
          })
        );
        continue;
      }

      const code = getCatalogCode(mapping.pos_item_code);
      const codeMatches = code ? productsByCode.get(code) ?? [] : [];

      if (codeMatches.length === 0) {
        orphanedIds.add(Number(mapping.id));
        issue(
          issues,
          issueFor({
            severity: "warning",
            type: "orphaned_mapping",
            message: "현재 POS 카탈로그에서 일치하는 상품을 찾을 수 없습니다.",
            mapping,
          })
        );
      }
      continue;
    }

    if (!product) {
      orphanedIds.add(Number(mapping.id));
      issue(
        issues,
        issueFor({
          severity: "warning",
          type: "orphaned_mapping",
          message: "mapping이 존재하지 않는 POS 상품을 참조합니다.",
          mapping,
        })
      );
      continue;
    }

    if (product.is_active !== true) {
      inactiveProductMappingIds.add(Number(mapping.id));
      issue(
        issues,
        issueFor({
          severity: "warning",
          type: "inactive_product_mapping",
          message: "비활성 POS 상품에 active mapping이 연결되어 있습니다.",
          product,
          mapping,
        })
      );
    }

    if (mapping.target_type === "option") {
      if (!mapping.pos_option_id) {
        continue;
      }

      const option = extractProductOptions(product).find(
        (candidate) => candidate.id === mapping.pos_option_id
      );
      if (!option) {
        orphanedIds.add(Number(mapping.id));
        issue(
          issues,
          issueFor({
            severity: "warning",
            type: "orphaned_mapping",
            message: "현재 POS 상품에서 옵션을 찾을 수 없습니다.",
            product,
            mapping,
          })
        );
      }
    }
  }

  const errorCount = issues.filter(
    (validationIssue) => validationIssue.severity === "error"
  ).length;
  const warningCount = issues.filter(
    (validationIssue) => validationIssue.severity === "warning"
  ).length;
  const infoCount = issues.filter(
    (validationIssue) => validationIssue.severity === "info"
  ).length;
  const summary: MappingValidationSummary = {
    totalProducts: products.length,
    activeProducts: products.filter((product) => product.is_active === true)
      .length,
    mappedCount,
    recipeMappedCount,
    ignoredCount,
    manualCount,
    comboMappedCount: invalidComboIds.size
      ? activeMappings.filter((mapping) => mapping.mapping_type === "combo")
          .length - invalidComboIds.size
      : activeMappings.filter((mapping) => mapping.mapping_type === "combo")
          .length,
    unmappedCount,
    optionUnmappedCount,
    invalidDirectCount: invalidDirectIds.size,
    invalidRecipeCount: invalidRecipeIds.size,
    orphanedCount: orphanedIds.size,
    inactiveProductMappingCount: inactiveProductMappingIds.size,
    errorCount,
    warningCount,
    infoCount,
    readyForPreview: errorCount === 0,
  };

  return {
    summary,
    issues: issues.sort((left, right) => {
      const severityOrder = { error: 0, warning: 1, info: 2 };
      return (
        severityOrder[left.severity] - severityOrder[right.severity] ||
        (left.posProductName || "").localeCompare(
          right.posProductName || "",
          "ko"
        )
      );
    }),
    validatedAt: new Date().toISOString(),
  };
}
