import "server-only";

export type PosProductRow = {
  id: number;
  source: string;
  branch_id: string | null;
  pos_item_id: string | null;
  item_code: string | null;
  item_name: string;
  item_name_vi: string | null;
  category_name: string | null;
  unit_name: string | null;
  is_active: boolean | null;
  is_sold: boolean | null;
  raw_json: unknown;
};

export type PosItemMappingRow = {
  id: number;
  pos_item_code: string | null;
  pos_item_name: string | null;
  pos_unit_name: string | null;
  mapping_type: string | null;
  inventory_item_id: number | null;
  quantity_multiplier: number | string | null;
  source_quantity?: number | string | null;
  source_unit?: string | null;
  source_package_content_quantity?: number | string | null;
  source_package_content_unit?: string | null;
  is_active: boolean | null;
  pos_product_id: number | null;
  target_type: "product" | "option";
  pos_option_id: string | null;
  pos_product_code_snapshot: string | null;
  pos_product_name_snapshot: string | null;
  pos_option_name_snapshot: string | null;
  mapping_version: number | null;
  last_reconciled_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
};

export type PosItemMappingRecipeRow = {
  id: number;
  mapping_id: number;
  inventory_item_id: number;
  quantity_per_pos_unit: number | string | null;
  source_quantity?: number | string | null;
  source_unit?: string | null;
  source_package_content_quantity?: number | string | null;
  source_package_content_unit?: string | null;
  is_active: boolean | null;
  is_required: boolean | null;
  version: number | null;
};

export type PosProductChild = {
  id: string;
  code: string | null;
  name: string;
  quantity: number;
  index: number;
  unitPrice: number;
  isActive: boolean;
};

type JsonObject = Record<string, unknown>;

export function getCatalogCode(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(asObject).filter((item): item is JsonObject => Boolean(item))
    : [];
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function getNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function extractProductChildren(product: PosProductRow) {
  const raw = asObject(product.raw_json);
  const detail = asObject(raw?.Detail);
  const children = asObjectArray(raw?.Children ?? detail?.Children);

  return children.map((child, childIndex) => {
    const quantity = getNumber(
      child.Quantity ?? child.QuantityByParent ?? child.Amount
    );

    return {
      id:
        getString(child.Id) ||
        getString(child.InventoryItemID) ||
        `child-${childIndex}`,
      code: getString(child.Code),
      name: getString(child.Name) || "Child item",
      quantity: quantity > 0 ? quantity : 1,
      index: childIndex,
      unitPrice: getNumber(child.Price ?? child.UnitPrice),
      isActive:
        getBoolean(child.InActive) !== true &&
        getBoolean(child.Inactive) !== true,
    } satisfies PosProductChild;
  });
}

export function findProductForChild(
  child: PosProductChild,
  products: PosProductRow[]
) {
  const matches = products.filter((product) => {
    const idMatches = child.id && product.pos_item_id === child.id;
    const codeMatches =
      child.code &&
      getCatalogCode(product.item_code) === getCatalogCode(child.code);
    return product.is_active === true && (idMatches || codeMatches);
  });

  return matches;
}

export function extractProductOptions(product: PosProductRow) {
  const raw = asObject(product.raw_json);
  const detail = asObject(raw?.Detail);
  const additionCategories = asObjectArray(
    raw?.AdditionCategories ?? detail?.AdditionCategories
  );

  const additions = additionCategories.flatMap((category, categoryIndex) => {
    const categoryId =
      getString(category.Id) ||
      getString(category.Name) ||
      `addition-group-${categoryIndex}`;
    const categoryName =
      getString(category.Name) ||
      getString(category.Description) ||
      "Options";

    return asObjectArray(category.Additions).map((option, optionIndex) => ({
      id:
        getString(option.Id) ||
        getString(option.InventoryItemAdditionID) ||
        `addition-${categoryIndex}-${optionIndex}`,
      code: getString(option.Code),
      name:
        getString(option.Description) ||
        getString(option.Name) ||
        "Option",
      groupId: categoryId,
      groupName: categoryName,
      optionType: "addition" as const,
      unitPrice: getNumber(option.Price ?? option.UnitPrice),
      isActive:
        getBoolean(option.InActive) !== true &&
        getBoolean(option.Inactive) !== true,
    }));
  });

  const childOptions = extractProductChildren(product).map((child) => ({
    id: child.id,
    code: child.code,
    name: child.name,
    groupId: "children",
    groupName: "Children",
    optionType: "child" as const,
    unitPrice: child.unitPrice,
    isActive: child.isActive,
  }));

  return [...additions, ...childOptions];
}

export function groupProductsByCode(products: PosProductRow[]) {
  const map = new Map<string, PosProductRow[]>();

  for (const product of products) {
    const code = getCatalogCode(product.item_code);
    if (!code) continue;
    const rows = map.get(code) ?? [];
    rows.push(product);
    map.set(code, rows);
  }

  return map;
}

export function findLegacyProductCandidates(
  mappingCode: unknown,
  products: PosProductRow[]
) {
  const code = getCatalogCode(mappingCode);
  if (!code) return [];

  const normalizedCode = code.toLocaleLowerCase("en-US");
  return products.filter((product) => {
    const productCode = getCatalogCode(product.item_code).toLocaleLowerCase(
      "en-US"
    );
    const productName = product.item_name.toLocaleLowerCase("en-US");

    return (
      productCode.startsWith(`${normalizedCode}-`) ||
      productName.includes(`[${normalizedCode}]`)
    );
  });
}

export function isMissingMappingSchemaError(error: unknown) {
  if (!error || typeof error !== "object") return false;

  const value = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  const code = typeof value.code === "string" ? value.code : "";
  const message = [value.message, value.details, value.hint]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();

  return (
    code === "PGRST204" ||
    code === "42703" ||
    message.includes("pos_product_id") ||
    message.includes("target_type") ||
    message.includes("is_required") ||
    message.includes("archived_at")
  );
}
