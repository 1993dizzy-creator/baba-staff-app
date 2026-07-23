import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { prepareAndApplyReprocessInventoryDeduction } from "@/lib/sales/inventory-deduction-reprocess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

function getPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getResponseStatus(result: string) {
  if (result === "applied" || result === "already_processed") return 200;
  if (result === "stale_preview") return 409;
  if (result === "needs_check" || result === "not_supported") return 409;
  return 500;
}

export async function POST(req: Request) {
  try {
    const auth = await requireRole(["owner", "master", "manager"]);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, result: "failed", error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = (await req.json().catch(() => ({}))) as JsonObject;

    const receiptId = getPositiveInteger(body.receiptId);
    if (!receiptId) {
      return NextResponse.json(
        { ok: false, error: "Invalid receipt id." },
        { status: 400 }
      );
    }

    const result = await prepareAndApplyReprocessInventoryDeduction({
      receiptId,
      actorUsername: auth.actor.username,
      expectedFingerprint: getOptionalString(body.expectedFingerprint),
      expectedInventoryAffectingHash: getOptionalString(
        body.expectedInventoryAffectingHash
      ),
      expectedReceiptUpdatedAt: getOptionalString(body.expectedReceiptUpdatedAt),
    });

    return NextResponse.json(result, {
      status: getResponseStatus(result.result),
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_REPROCESS_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        result: "failed",
        error: "Failed to reprocess inventory deduction.",
      },
      { status: 500 }
    );
  }
}
