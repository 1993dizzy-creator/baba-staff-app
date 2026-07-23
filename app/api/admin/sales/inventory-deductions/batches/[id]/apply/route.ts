import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import {
  getPositiveInteger,
  getSupabaseErrorCode,
} from "@/lib/pos/mapping-admin";
import { validateInventoryDeductionBatch } from "@/lib/sales/inventory-deduction-batch-validation";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

function getApplyErrorStatus(error: unknown) {
  const code = getSupabaseErrorCode(error);

  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "22023") return 400;
  if (code === "P0001" || code === "23505" || code === "23514") return 409;
  return 500;
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireRole(["owner", "master"]);
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
    if (!validation.applyReady) {
      return NextResponse.json(
        {
          ok: false,
          error: "Batch validation failed. Inventory was not changed.",
          validation,
        },
        { status: 409 }
      );
    }

    const validationReceipts = validation.receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      currentInventoryHash: receipt.currentInventoryHash,
      currentReceiptUpdatedAt: receipt.currentReceiptUpdatedAt,
      applyAllowed: receipt.applyAllowed,
    }));
    const { data, error } = await supabaseServer.rpc(
      "apply_sales_inventory_deduction_batch",
      {
        p_batch_id: batchId,
        p_actor_username: auth.actor.username,
        p_validation_receipts: validationReceipts,
      }
    );

    if (error) {
      const failedValidation =
        await validateInventoryDeductionBatch(batchId).catch(() => validation);
      return NextResponse.json(
        {
          ok: false,
          error: "Failed to apply inventory deduction batch.",
          validation: failedValidation,
        },
        { status: getApplyErrorStatus(error) }
      );
    }

    return NextResponse.json({
      ...(data as JsonObject),
      validation,
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_BATCH_APPLY_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to apply inventory deduction batch.",
      },
      { status: 500 }
    );
  }
}
