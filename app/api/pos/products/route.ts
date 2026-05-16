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
};

function toNumber(value: number | string | null | undefined) {
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
      "id, source, branch_id, pos_item_id, item_id, item_code, item_name, item_name_vi, category_name, unit_name, unit_price, price_includes_vat, tax_rate, tax_name, tax_rate_source, tax_rate_updated_at, item_type, is_active"
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

function serializeProduct(product: ProductRow) {
  return {
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
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("query") || "").trim();

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
      products: products.map(serializeProduct),
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
