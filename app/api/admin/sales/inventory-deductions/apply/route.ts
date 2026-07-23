import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { getSupabaseErrorCode } from "@/lib/pos/mapping-admin";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";
import { saveInventoryDeductionPreviewBatch } from "@/lib/sales/inventory-deduction-batches";
import { validateInventoryDeductionBatch } from "@/lib/sales/inventory-deduction-batch-validation";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

function getReceiptIds(value: unknown) {
  if (!Array.isArray(value)) return null;

  const ids = Array.from(
    new Set(
      value.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  return ids.length === value.length ? ids : null;
}

function getApplyErrorStatus(error: unknown) {
  const code = getSupabaseErrorCode(error);

  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "22023") return 400;
  if (code === "P0001" || code === "23505" || code === "23514") return 409;
  return 500;
}

export async function POST(req: Request) {
  try {
    const auth = await requireRole(["owner", "master"]);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = (await req.json().catch(() => ({}))) as JsonObject;

    const receiptIds = getReceiptIds(body.receiptIds);
    if (!receiptIds || receiptIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "차감 확정할 영수증을 선택해 주세요." },
        { status: 400 }
      );
    }

    const preview = await buildInventoryDeductionPreview({
      businessDateFrom: "1970-01-01",
      businessDateTo: "2999-12-31",
      receiptIds,
    });
    const readyReceipts = preview.receipts.filter(
      (receipt) => receipt.status === "ready"
    );

    // TODO(sales-inventory-adjustment):
    // applied_after_modified receipts are intentionally excluded from standard apply here.
    // Do NOT relax the status === "ready" check without a separate delta adjustment flow.
    // The RPC also enforces applied.receipt_id = candidate.receipt_id duplicate prevention.
    // Future adjustment path must use a dedicated delta batch + separate RPC that checks
    // only (receipt_line_id, inventory_item_id, mapping_id, recipe_id) for duplicates.
    // See docs/sales-inventory-deduction-adjustment.md.
    if (readyReceipts.length !== receiptIds.length) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "선택한 영수증 중 차감 확정할 수 없는 항목이 있습니다. 최신 미리보기를 확인해 주세요.",
          preview,
        },
        { status: 409 }
      );
    }
    if (
      readyReceipts.every((receipt) =>
        receipt.lines.every((line) => line.deductions.length === 0)
      )
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "적용 가능한 재고 차감 후보가 없습니다.",
          preview,
        },
        { status: 409 }
      );
    }

    const savedBatch = await saveInventoryDeductionPreviewBatch({
      preview,
      actorUsername: auth.actor.username,
      note: "direct_apply_from_sales_receipts",
    });
    const validation = await validateInventoryDeductionBatch(savedBatch.batchId);

    if (!validation.found || !validation.applyReady) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "차감 확정 직전 재검증에 실패했습니다. 최신 미리보기를 확인해 주세요.",
          preview,
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
        p_batch_id: savedBatch.batchId,
        p_actor_username: auth.actor.username,
        p_validation_receipts: validationReceipts,
      }
    );

    if (error) {
      const failedValidation = await validateInventoryDeductionBatch(
        savedBatch.batchId
      ).catch(() => validation);
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          preview,
          validation: failedValidation,
        },
        { status: getApplyErrorStatus(error) }
      );
    }

    const appliedPreview = await buildInventoryDeductionPreview({
      businessDateFrom: "1970-01-01",
      businessDateTo: "2999-12-31",
      receiptIds,
    });

    return NextResponse.json({
      ...(data as JsonObject),
      preview: appliedPreview,
      validation,
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_DIRECT_APPLY_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to apply inventory deductions.",
      },
      { status: 500 }
    );
  }
}
