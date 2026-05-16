import { NextResponse } from "next/server";
import { CukcukAuthError } from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";
import {
  DEFAULT_CUKCUK_BRANCH_ID,
  fetchCukcukProductDetail,
  fetchCukcukProductsPage,
  findTaxCandidateFields,
  getPresentProductFields,
  getProductFieldCandidates,
} from "@/lib/pos/cukcuk/products";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guardResponse = requirePosAdminSecret(req);
  if (guardResponse) return guardResponse;

  const { searchParams } = new URL(req.url);
  const branchId = searchParams.get("branchId") || DEFAULT_CUKCUK_BRANCH_ID;
  const page = Math.max(Number(searchParams.get("page") || 1), 1);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 20), 1), 100);
  const includeInactive = searchParams.get("includeInactive") === "true";
  const includeDebug = searchParams.get("includeDebug") !== "false";
  const includeDetail = searchParams.get("includeDetail") === "true";
  const detailLimit = Math.min(
    Math.max(Number(searchParams.get("detailLimit") || 3), 1),
    5
  );
  const keySearch = searchParams.get("query") || undefined;

  try {
    const result = await fetchCukcukProductsPage({
      branchId,
      page,
      limit,
      includeInactive,
      keySearch,
    });

    const detailResults = includeDetail
      ? await Promise.all(
          result.normalized
            .filter((product) => Boolean(product.posItemId))
            .slice(0, detailLimit)
            .map((product) =>
              fetchCukcukProductDetail({
                posItemId: product.posItemId as string,
              })
            )
        )
      : [];

    return NextResponse.json({
      ok: true,
      request: {
        endpoint: result.endpoint,
        branchId,
        page,
        limit,
        includeInactive,
        includeDetail,
        detailLimit: includeDetail ? detailLimit : null,
        keySearch: keySearch || null,
      },
      summary: {
        totalFromApi: result.total,
        returnedCount: result.items.length,
        normalizedCount: result.normalized.length,
      },
      sample: result.normalized.slice(0, 5),
      ...(includeDebug
        ? {
            rawSample: result.items.slice(0, 5),
            presentFieldMap: getPresentProductFields(result.items),
            taxCandidateFields: findTaxCandidateFields({
              pagingItems: result.items,
              detailItems: detailResults.map((detail) => detail.item),
            }),
            detailSample: detailResults.map((detail) => detail.item),
            detailPresentFieldMap: getPresentProductFields(
              detailResults.map((detail) => detail.item)
            ),
            candidateFieldMap: getProductFieldCandidates(),
          }
        : {}),
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

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
