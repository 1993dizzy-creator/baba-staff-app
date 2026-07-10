import { NextResponse } from "next/server";
import { getMappingAdminActor } from "@/lib/pos/mapping-admin";
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
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername = getOptionalString(body.actorUsername) ?? "";
    const actor = await getMappingAdminActor(actorUsername);

    if (
      !actor ||
      (actor.role !== "owner" &&
        actor.role !== "master" &&
        actor.role !== "manager")
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Only owner, master, or manager can reprocess deductions.",
        },
        { status: 403 }
      );
    }

    const receiptId = getPositiveInteger(body.receiptId);
    if (!receiptId) {
      return NextResponse.json(
        { ok: false, error: "Invalid receipt id." },
        { status: 400 }
      );
    }

    const result = await prepareAndApplyReprocessInventoryDeduction({
      receiptId,
      actorUsername: actor.username,
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
        error:
          error instanceof Error
            ? error.message
            : "Failed to reprocess inventory deduction.",
      },
      { status: 500 }
    );
  }
}
