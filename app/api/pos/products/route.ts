import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

type ProductRow = {
  id: number;
  source: string;
  branch_id: string | null;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string;
  item_name_vi: string | null;
  category_name: string | null;
  unit_name: string | null;
  unit_price: number | string | null;
  price_includes_vat: boolean | null;
  tax_rate: number | string | null;
  tax_name: string | null;
  tax_rate_source: string | null;
  tax_rate_updated_at: string | null;
  item_type: number | null;
  is_active: boolean | null;
  raw_json: unknown;
};

type JsonObject = Record<string, unknown>;

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function escapeIlike(value: string) {
  return value.replace(/[%,]/g, " ").trim();
}

async function fetchProducts(params: { search: string; source: "cukcuk" | "receipt_history" }) {
  const { data, error } = await supabaseServer
    .from("pos_products")
    .select(
      "id, source, branch_id, pos_item_id, item_id, item_code, item_name, item_name_vi, category_name, unit_name, unit_price, price_includes_vat, tax_rate, tax_name, tax_rate_source, tax_rate_updated_at, item_type, is_active, raw_json"
    )
    .eq("source", params.source)
    .eq("is_active", true)
    .or(`item_code.ilike.%${params.search}%,item_name.ilike.%${params.search}%`)
    .order("item_name", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to fetch POS products: ${error.message}`);
  }

  return (data || []) as ProductRow[];
}

function asObject(value: unknown): JsonObject | null {
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

function getOptionGroups(product: ProductRow) {
  const raw = asObject(product.raw_json);
  const detail = asObject(raw?.Detail);
  const additionCategories = asObjectArray(
    raw?.AdditionCategories ?? detail?.AdditionCategories
  );
  const children = asObjectArray(raw?.Children ?? detail?.Children);
  const parentTaxRate =
    product.tax_rate === null ? null : toNumber(product.tax_rate);

  const additionGroups = additionCategories
    .map((category, categoryIndex) => {
      const options = asObjectArray(category.Additions)
        .filter(
          (option) =>
            getBoolean(option.InActive) !== true &&
            getBoolean(option.Inactive) !== true
        )
        .map((option, optionIndex) => ({
          id:
            getString(option.Id) ||
            `addition-${categoryIndex}-${optionIndex}`,
          name:
            getString(option.Description) ||
            getString(option.Name) ||
            "Option",
          code: getString(option.Code),
          unitPrice: toNumber(option.Price ?? option.UnitPrice),
          taxRate: parentTaxRate,
          raw: option,
        }));

      return {
        id:
          getString(category.Id) ||
          getString(category.Name) ||
          `addition-${categoryIndex}`,
        name:
          getString(category.Name) ||
          getString(category.Description) ||
          "Options",
        type: "addition" as const,
        options,
      };
    })
    .filter((group) => group.options.length > 0);

  const childOptions = children
    .filter((child) => getBoolean(child.Inactive) !== true)
    .map((child, childIndex) => ({
      id: getString(child.Id) || `child-${childIndex}`,
      name: getString(child.Name) || "Child item",
      code: getString(child.Code),
      unitPrice: toNumber(child.Price),
      taxRate: parentTaxRate,
      raw: child,
    }));

  return [
    ...additionGroups,
    ...(childOptions.length > 0
      ? [
          {
            id: "children",
            name: "Children",
            type: "child" as const,
            options: childOptions,
          },
        ]
      : []),
  ];
}

function serializeProduct(product: ProductRow, includeOptions: boolean) {
  const serialized = {
    id: product.id,
    source: product.source,
    branchId: product.branch_id,
    posItemId: product.pos_item_id || product.item_id,
    itemId: product.pos_item_id || product.item_id,
    itemCode: product.item_code,
    itemName: product.item_name,
    itemNameVi: product.item_name_vi,
    categoryName: product.category_name,
    unitName: product.unit_name,
    unitPrice: toNumber(product.unit_price),
    priceIncludesVat: product.price_includes_vat,
    taxRate: product.tax_rate === null ? null : toNumber(product.tax_rate),
    taxName: product.tax_name,
    taxRateSource: product.tax_rate_source,
    taxRateUpdatedAt: product.tax_rate_updated_at,
    itemType: product.item_type,
    isActive: product.is_active === true,
  };

  return includeOptions
    ? {
        ...serialized,
        optionGroups: getOptionGroups(product),
      }
    : serialized;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("query") || "").trim();
    const includeOptions =
      searchParams.get("includeOptions") === "1" ||
      searchParams.get("includeOptions") === "true";

    if (!query) {
      return NextResponse.json({ ok: true, products: [] });
    }

    const search = escapeIlike(query);
    let products = await fetchProducts({ search, source: "cukcuk" });
    let fallbackUsed = false;

    if (products.length === 0) {
      products = await fetchProducts({ search, source: "receipt_history" });
      fallbackUsed = products.length > 0;
    }

    return NextResponse.json({
      ok: true,
      sourcePriority: ["cukcuk", "receipt_history"],
      fallbackUsed,
      products: products.map((product) =>
        serializeProduct(product, includeOptions)
      ),
    });
  } catch (error) {
    console.error("[POS_PRODUCTS_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch POS products.",
      },
      { status: 500 }
    );
  }
}
