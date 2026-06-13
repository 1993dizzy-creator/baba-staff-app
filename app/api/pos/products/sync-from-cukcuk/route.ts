import { NextResponse } from "next/server";
import { CukcukAuthError, loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";
import { supabaseServer } from "@/lib/supabase/server";
import {
  DEFAULT_CUKCUK_BRANCH_ID,
  fetchCukcukProductDetail,
  fetchCukcukProductsPage,
  getPresentProductFields,
  normalizeCukcukProduct,
  type CukcukProductRaw,
  type NormalizedCukcukProduct,
} from "@/lib/pos/cukcuk/products";

export const runtime = "nodejs";

type RequestBody = {
  actorUsername?: unknown;
  branchId?: unknown;
  page?: unknown;
  limit?: unknown;
  syncAll?: unknown;
  maxPages?: unknown;
  includeInactive?: unknown;
  includeDebug?: unknown;
  includeDetails?: unknown;
  forceDetailRefresh?: unknown;
};

type ExistingProductRow = {
  id: number;
  branch_id: string | null;
  pos_item_id: string | null;
  item_code: string | null;
  price_includes_vat: boolean | null;
  tax_rate: number | string | null;
  tax_name: string | null;
  tax_amount: number | string | null;
  raw_json: unknown;
};

async function getAdminActor(actorUsername: unknown) {
  if (typeof actorUsername !== "string" || !actorUsername.trim()) return null;

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername.trim())
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify admin actor: ${error.message}`);
  }

  if (
    data?.role !== "owner" &&
    data?.role !== "master" &&
    data?.role !== "manager"
  ) {
    return null;
  }
  return data;
}

function toPositiveInteger(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function buildProductPayload(
  product: NormalizedCukcukProduct,
  now: string,
  existing?: ExistingProductRow | null
) {
  const productRaw = product.rawJson;
  const existingRaw =
    existing?.raw_json &&
    typeof existing.raw_json === "object" &&
    !Array.isArray(existing.raw_json)
      ? (existing.raw_json as CukcukProductRaw)
      : null;
  const hasDetailSnapshot =
    Object.prototype.hasOwnProperty.call(productRaw, "Detail") ||
    Object.prototype.hasOwnProperty.call(productRaw, "AdditionCategories") ||
    Object.prototype.hasOwnProperty.call(productRaw, "Children");

  return {
    source: product.source,
    branch_id: product.branchId,
    pos_item_id: product.posItemId,
    item_id: product.posItemId,
    item_code: product.itemCode,
    item_name: product.itemName,
    item_name_vi: product.itemNameVi,
    category_id: product.categoryId,
    category_name: product.categoryName,
    category_name_vi: product.categoryNameVi,
    unit_id: product.unitId,
    unit_name: product.unitName,
    unit_price: product.unitPrice,
    price_includes_vat:
      product.priceIncludesVat ?? existing?.price_includes_vat ?? null,
    tax_rate: product.taxRate ?? existing?.tax_rate ?? null,
    tax_name: product.taxName ?? existing?.tax_name ?? null,
    tax_amount: product.taxAmount ?? existing?.tax_amount ?? null,
    item_type: product.itemType,
    is_active: product.isActive,
    is_sold: product.isSold,
    raw_json:
      !hasDetailSnapshot && existingRaw
        ? { ...existingRaw, ...productRaw }
        : productRaw,
    last_seen_at: now,
    synced_at: now,
    updated_at: now,
  };
}

function getObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is CukcukProductRaw =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function buildProductWithDetail(params: {
  product: NormalizedCukcukProduct;
  detail: CukcukProductRaw | null;
}) {
  const detail = params.detail;
  const normalized = detail
    ? normalizeCukcukProduct({
        branchId: params.product.branchId,
        item: {
          ...params.product.rawJson,
          ...detail,
        },
      }) || params.product
    : params.product;

  return {
    ...normalized,
    rawJson: {
      ...params.product.rawJson,
      Detail: detail,
      AdditionCategories: getObjectArray(detail?.AdditionCategories),
      Children: getObjectArray(detail?.Children),
    },
  } satisfies NormalizedCukcukProduct;
}

function getExistingMatch(params: {
  product: NormalizedCukcukProduct;
  byPosItemId: Map<string, ExistingProductRow>;
  byItemCode: Map<string, ExistingProductRow>;
}) {
  const branchId = params.product.branchId;
  if (params.product.posItemId) {
    const match = params.byPosItemId.get(`${branchId}::${params.product.posItemId}`);
    if (match) return match;
  }

  if (params.product.itemCode) {
    return params.byItemCode.get(`${branchId}::${params.product.itemCode}`) || null;
  }

  return null;
}

async function fetchExistingProducts(branchId: string) {
  const { data, error } = await supabaseServer
    .from("pos_products")
    .select(
      "id, branch_id, pos_item_id, item_code, price_includes_vat, tax_rate, tax_name, tax_amount, raw_json"
    )
    .eq("source", "cukcuk")
    .eq("branch_id", branchId);

  if (error) {
    throw new Error(`Failed to fetch existing POS products: ${error.message}`);
  }

  const byPosItemId = new Map<string, ExistingProductRow>();
  const byItemCode = new Map<string, ExistingProductRow>();

  ((data || []) as ExistingProductRow[]).forEach((row) => {
    if (row.branch_id && row.pos_item_id) {
      byPosItemId.set(`${row.branch_id}::${row.pos_item_id}`, row);
    }
    if (row.branch_id && row.item_code) {
      byItemCode.set(`${row.branch_id}::${row.item_code}`, row);
    }
  });

  return { byPosItemId, byItemCode };
}

export async function POST(req: Request) {
  const guardResponse = requirePosAdminSecret(req);
  if (guardResponse) return guardResponse;

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const actor = await getAdminActor(body.actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const branchId =
      typeof body.branchId === "string" && body.branchId.trim()
        ? body.branchId.trim()
        : DEFAULT_CUKCUK_BRANCH_ID;
    const firstPage = toPositiveInteger(body.page, 1, 100000);
    const limit = toPositiveInteger(body.limit, 100, 100);
    const syncAll = body.syncAll === true;
    const maxPages = toPositiveInteger(body.maxPages, syncAll ? 20 : 1, 100);
    const includeInactive = body.includeInactive === true;
    const includeDebug = body.includeDebug === true;
    const includeDetails =
      body.includeDetails === true || body.forceDetailRefresh === true;
    const now = new Date().toISOString();
    const auth = await loginCukcuk();

    const existing = await fetchExistingProducts(branchId);
    const allProducts: NormalizedCukcukProduct[] = [];
    const rawSamples: CukcukProductRaw[] = [];
    let totalFromApi = 0;
    let lastPage = firstPage;

    for (let offset = 0; offset < maxPages; offset += 1) {
      const page = firstPage + offset;
      const pageResult = await fetchCukcukProductsPage({
        branchId,
        page,
        limit,
        includeInactive,
        auth,
      });

      totalFromApi = pageResult.total;
      lastPage = page;
      allProducts.push(...pageResult.normalized);
      rawSamples.push(...pageResult.items.slice(0, Math.max(0, 5 - rawSamples.length)));

      if (!syncAll) break;
      if (pageResult.items.length < limit) break;
      if (allProducts.length >= totalFromApi) break;
    }

    const failedDetails: {
      posItemId: string | null;
      itemCode: string | null;
      itemName: string;
      error: string;
    }[] = [];
    const productsToSave: NormalizedCukcukProduct[] = [];

    for (const product of allProducts) {
      if (!includeDetails || !product.posItemId) {
        productsToSave.push(product);
        continue;
      }

      try {
        const detailResult = await fetchCukcukProductDetail({
          posItemId: product.posItemId,
          auth,
        });
        productsToSave.push(
          buildProductWithDetail({
            product,
            detail: detailResult.item,
          })
        );
      } catch (error) {
        failedDetails.push({
          posItemId: product.posItemId,
          itemCode: product.itemCode,
          itemName: product.itemName,
          error: error instanceof Error ? error.message : "Unknown detail error",
        });
        productsToSave.push(
          buildProductWithDetail({
            product,
            detail: null,
          })
        );
      }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const product of productsToSave) {
      if (!product.posItemId && !product.itemCode) {
        skippedCount += 1;
        continue;
      }

      const match = getExistingMatch({
        product,
        byPosItemId: existing.byPosItemId,
        byItemCode: existing.byItemCode,
      });
      const payload = buildProductPayload(product, now, match);

      if (match) {
        const { error } = await supabaseServer
          .from("pos_products")
          .update(payload)
          .eq("id", match.id);

        if (error) {
          throw new Error(`Failed to update POS product ${match.id}: ${error.message}`);
        }

        updatedCount += 1;
        continue;
      }

      const { data, error } = await supabaseServer
        .from("pos_products")
        .insert(payload)
        .select(
          "id, branch_id, pos_item_id, item_code, price_includes_vat, tax_rate, tax_name, tax_amount, raw_json"
        )
        .single();

      if (error) {
        throw new Error(`Failed to insert POS product: ${error.message}`);
      }

      const inserted = data as ExistingProductRow;
      if (inserted.branch_id && inserted.pos_item_id) {
        existing.byPosItemId.set(
          `${inserted.branch_id}::${inserted.pos_item_id}`,
          inserted
        );
      }
      if (inserted.branch_id && inserted.item_code) {
        existing.byItemCode.set(`${inserted.branch_id}::${inserted.item_code}`, inserted);
      }
      insertedCount += 1;
    }

    return NextResponse.json({
      ok: true,
      request: {
        branchId,
        firstPage,
        lastPage,
        limit,
        syncAll,
        maxPages,
        includeInactive,
        includeDetails,
        actorUsername: actor.username,
      },
      result: {
        totalFromApi,
        fetchedCount: productsToSave.length,
        detailRequestedCount: includeDetails
          ? allProducts.filter((product) => Boolean(product.posItemId)).length
          : 0,
        detailFailedCount: failedDetails.length,
        failedDetails,
        insertedCount,
        updatedCount,
        upsertedCount: insertedCount + updatedCount,
        skippedCount,
        sample: productsToSave.slice(0, 5),
        fieldMap: includeDebug ? getPresentProductFields(rawSamples) : undefined,
        rawSample: includeDebug ? rawSamples : undefined,
        taxInfoStatus:
          productsToSave.some(
            (product) =>
              product.taxRate !== null ||
              product.taxName !== null ||
              product.taxAmount !== null
          )
            ? "tax fields found in API response candidates"
            : "tax fields not found in sampled inventoryitems/paging response candidates",
      },
    });
  } catch (error) {
    if (error instanceof CukcukAuthError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          status: error.status ?? 500,
          data: error.raw,
        },
        { status: 500 }
      );
    }

    console.error("[POS_PRODUCTS_SYNC_FROM_CUKCUK_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
