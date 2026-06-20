import { NextResponse } from "next/server";
import {
  getMappingAdminActor,
  getPositiveInteger,
} from "@/lib/pos/mapping-admin";
import { validateInventoryDeductionBatch } from "@/lib/sales/inventory-deduction-batch-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const batchId = getPositiveInteger(id);
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
    if (!batchId) {
      return NextResponse.json(
        { ok: false, error: "Invalid batch id." },
        { status: 400 }
      );
    }

    const validation = await validateInventoryDeductionBatch(batchId);
    if (!validation.found) {
      return NextResponse.json(
        { ok: false, error: "Batch was not found." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      validation: {
        ...validation,
        validatedBy: actor.username,
      },
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_BATCH_VALIDATE_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to validate inventory deduction batch.",
      },
      { status: 500 }
    );
  }
}
