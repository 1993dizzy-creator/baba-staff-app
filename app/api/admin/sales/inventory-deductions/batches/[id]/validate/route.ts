import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import {
  getPositiveInteger,
} from "@/lib/pos/mapping-admin";
import { validateInventoryDeductionBatch } from "@/lib/sales/inventory-deduction-batch-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireRole(["owner", "master", "manager", "leader"]);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const { id } = await context.params;
    const batchId = getPositiveInteger(id);
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
        validatedBy: auth.actor.username,
      },
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_BATCH_VALIDATE_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to validate inventory deduction batch.",
      },
      { status: 500 }
    );
  }
}
