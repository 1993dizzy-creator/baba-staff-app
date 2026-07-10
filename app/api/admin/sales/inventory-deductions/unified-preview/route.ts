import { NextResponse } from "next/server";
import { getMappingAdminActor } from "@/lib/pos/mapping-admin";
import { buildUnifiedInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-unified-preview";

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
      value.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  return ids.length === value.length ? ids : null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const actor = await getMappingAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const receiptIds = getReceiptIds(body.receiptIds);
    const businessDate = body.businessDate;
    const businessDateFrom = isBusinessDate(body.businessDateFrom)
      ? body.businessDateFrom
      : isBusinessDate(businessDate)
        ? businessDate
        : null;
    const businessDateTo = isBusinessDate(body.businessDateTo)
      ? body.businessDateTo
      : isBusinessDate(businessDate)
        ? businessDate
        : null;

    if (receiptIds === null) {
      return NextResponse.json(
        { ok: false, error: "receiptIds must contain positive integer ids." },
        { status: 400 }
      );
    }

    if (receiptIds.length === 0 && (!businessDateFrom || !businessDateTo)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "businessDate, or businessDateFrom and businessDateTo, must use YYYY-MM-DD format.",
        },
        { status: 400 }
      );
    }

    const dateFrom = businessDateFrom ?? "1970-01-01";
    const dateTo = businessDateTo ?? "2999-12-31";

    const preview = await buildUnifiedInventoryDeductionPreview({
      businessDateFrom: dateFrom,
      businessDateTo: dateTo,
      receiptIds,
    });

    return NextResponse.json({
      ok: true,
      preview,
    });
  } catch (error) {
    console.error("[ADMIN_SALES_UNIFIED_INVENTORY_PREVIEW_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to build unified inventory deduction preview.",
      },
      { status: 500 }
    );
  }
}
