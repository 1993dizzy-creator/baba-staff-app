import { NextResponse } from "next/server";
import {
  getMappingAdminActor,
  getPositiveInteger,
} from "@/lib/pos/mapping-admin";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

export async function PATCH(
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
    if (!batchId || !Array.isArray(body.receiptIds)) {
      return NextResponse.json(
        { ok: false, error: "batch id and receiptIds are required." },
        { status: 400 }
      );
    }

    const receiptIds = Array.from(
      new Set(
        body.receiptIds
          .map(Number)
          .filter((receiptId) => Number.isInteger(receiptId) && receiptId > 0)
      )
    );
    const selectedForApply = body.selectedForApply === true;

    if (receiptIds.length !== body.receiptIds.length || receiptIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "receiptIds must contain unique positive ids." },
        { status: 400 }
      );
    }

    const { data: batch, error: batchError } = await supabaseServer
      .from("pos_inventory_deduction_batches")
      .select("id, status")
      .eq("id", batchId)
      .maybeSingle();
    if (batchError) throw batchError;
    if (!batch) {
      return NextResponse.json(
        { ok: false, error: "Batch was not found." },
        { status: 404 }
      );
    }
    if (batch.status !== "previewed") {
      return NextResponse.json(
        {
          ok: false,
          error: "Receipt selection can only change on previewed batches.",
        },
        { status: 409 }
      );
    }

    const { data: receipts, error: receiptError } = await supabaseServer
      .from("pos_inventory_deduction_receipts")
      .select("id, receipt_id, status, selected_for_apply")
      .eq("batch_id", batchId)
      .in("receipt_id", receiptIds);
    if (receiptError) throw receiptError;
    if ((receipts || []).length !== receiptIds.length) {
      return NextResponse.json(
        { ok: false, error: "One or more receipts are not in this batch." },
        { status: 400 }
      );
    }
    if (
      selectedForApply &&
      (receipts || []).some((receipt) => receipt.status !== "ready")
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Only ready receipts can be selected for apply.",
        },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabaseServer
      .from("pos_inventory_deduction_receipts")
      .update({
        selected_for_apply: selectedForApply,
        updated_at: now,
      })
      .eq("batch_id", batchId)
      .in("receipt_id", receiptIds);
    if (updateError) throw updateError;

    const { error: deductionError } = await supabaseServer
      .from("pos_inventory_deductions")
      .update({
        status: selectedForApply ? "selected" : "previewed",
        updated_at: now,
      })
      .eq("batch_id", batchId)
      .in("receipt_id", receiptIds)
      .in("status", ["selected", "previewed"]);
    if (deductionError) throw deductionError;

    return NextResponse.json({
      ok: true,
      batchId,
      receiptIds,
      selectedForApply,
      updatedBy: actor.username,
      updatedAt: now,
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_BATCH_RECEIPTS_PATCH_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update receipt selection.",
      },
      { status: 500 }
    );
  }
}
