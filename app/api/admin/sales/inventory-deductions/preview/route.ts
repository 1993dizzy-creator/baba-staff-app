import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

function isBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getReceiptIds(value: unknown) {
  if (value === undefined || value === null) return [] as number[];
  if (!Array.isArray(value)) return null;

  const ids = Array.from(
    new Set(
      value
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  return ids.length === value.length ? ids : null;
}

export async function POST(req: Request) {
  try {
    const auth = await requireRole(["owner", "master", "manager", "leader"]);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = (await req.json().catch(() => ({}))) as JsonObject;
    if (body.saveBatch === true) {
      return NextResponse.json(
        {
          ok: false,
          error: "Batch saving through preview is no longer supported.",
        },
        { status: 400 }
      );
    }

    const receiptIds = getReceiptIds(body.receiptIds);
    const businessDateFrom = body.businessDateFrom;
    const businessDateTo = body.businessDateTo;

    if (receiptIds === null) {
      return NextResponse.json(
        { ok: false, error: "receiptIds must contain positive integer ids." },
        { status: 400 }
      );
    }

    if (
      receiptIds.length === 0 &&
      (!isBusinessDate(businessDateFrom) || !isBusinessDate(businessDateTo))
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "businessDateFrom and businessDateTo must use YYYY-MM-DD format.",
        },
        { status: 400 }
      );
    }

    const dateFrom = isBusinessDate(businessDateFrom)
      ? businessDateFrom
      : "1970-01-01";
    const dateTo = isBusinessDate(businessDateTo)
      ? businessDateTo
      : "2999-12-31";

    if (dateFrom > dateTo) {
      return NextResponse.json(
        {
          ok: false,
          error: "businessDateFrom cannot be later than businessDateTo.",
        },
        { status: 400 }
      );
    }

    const preview = await buildInventoryDeductionPreview({
      businessDateFrom: dateFrom,
      businessDateTo: dateTo,
      receiptIds,
    });
    return NextResponse.json({
      ok: true,
      preview,
      batch: null,
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_PREVIEW_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to build inventory deduction preview.",
      },
      { status: 500 }
    );
  }
}
