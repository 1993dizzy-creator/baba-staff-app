import "server-only";

import { createHash } from "node:crypto";
import { supabaseServer } from "@/lib/supabase/server";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";

export type InventoryDeductionPreview = Awaited<
  ReturnType<typeof buildInventoryDeductionPreview>
>;

function idempotencyKey(parts: Array<string | number | null>) {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function getBatchCounts(preview: InventoryDeductionPreview) {
  return {
    receipt_count: preview.summary.totalReceiptCount,
    ready_receipt_count: preview.summary.readyCount,
    blocked_receipt_count: preview.summary.blockedCount,
    skipped_receipt_count: preview.summary.skippedCount,
    already_applied_receipt_count: preview.summary.alreadyAppliedCount,
    missing_mapping_count: preview.summary.missingMappingCount,
    manual_review_count: preview.summary.manualReviewCount,
    invalid_mapping_count: preview.summary.invalidMappingCount,
    incomplete_recipe_count: preview.summary.incompleteRecipeCount,
    insufficient_stock_count: preview.summary.insufficientStockCount,
    review_required_count: preview.summary.reviewRequiredCount,
  };
}

export async function saveInventoryDeductionPreviewBatch(params: {
  preview: InventoryDeductionPreview;
  actorUsername: string;
  note?: string | null;
  workflowType?: "initial_apply" | "reprocess_modified" | null;
  receiptContentFingerprintByReceiptId?: Map<number, string> | null;
  executionId?: string | null;
}) {
  const now = new Date().toISOString();
  const workflowType = params.workflowType ?? null;
  const receiptContentFingerprintByReceiptId =
    params.receiptContentFingerprintByReceiptId ?? null;
  const { data: batch, error: batchError } = await supabaseServer
    .from("pos_inventory_deduction_batches")
    .insert({
      flow_version: "sales_db_v1",
      business_date_from: params.preview.businessDateFrom,
      business_date_to: params.preview.businessDateTo,
      source: "manual_preview",
      status: "previewed",
      ...getBatchCounts(params.preview),
      created_by: params.actorUsername,
      created_at: now,
      previewed_at: params.preview.generatedAt,
      note: params.note?.trim() || null,
      metadata: {
        validationSummary: params.preview.validationSummary,
        inventoryTotals: params.preview.inventoryTotals,
        generatedAt: params.preview.generatedAt,
        hashVersion: params.preview.receipts[0]?.hashVersion ?? 1,
        ...(workflowType ? { workflowType } : {}),
        ...(params.executionId ? { executionId: params.executionId } : {}),
      },
      updated_at: now,
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    throw new Error(
      batchError?.message || "Failed to create inventory deduction batch."
    );
  }

  const batchId = Number(batch.id);

  try {
    const receiptRows = params.preview.receipts.map((receipt) => {
      const receiptContentFingerprint =
        receiptContentFingerprintByReceiptId?.get(receipt.receiptId) ?? null;

      return {
        batch_id: batchId,
        receipt_id: receipt.receiptId,
        receipt_ref_no: receipt.refNo,
        business_date: receipt.businessDate,
        status: receipt.status,
        inventory_affecting_hash: receipt.inventoryAffectingHash,
        amount_hash: receipt.amountHash,
        previewed_receipt_updated_at: receipt.previewedReceiptUpdatedAt,
        blocked_reasons: receipt.blockedReasons,
        line_summary: {
          refId: receipt.refId,
          refDate: receipt.refDate,
          hashVersion: receipt.hashVersion,
          ...(workflowType ? { workflowType } : {}),
          ...(receiptContentFingerprint
            ? { receiptContentFingerprint }
            : {}),
          lines: receipt.lines,
        },
        selected_for_apply: receipt.status === "ready",
        review_required_at:
          receipt.status === "review_required" ? now : null,
        review_reason:
          receipt.status === "review_required"
            ? receipt.blockedReasons.join(" ")
            : null,
        workflow_type: workflowType,
        receipt_content_fingerprint: receiptContentFingerprint,
        supersedes_deduction_receipt_id: null,
        created_at: now,
        updated_at: now,
      };
    });

    const savedReceipts =
      receiptRows.length > 0
        ? await supabaseServer
            .from("pos_inventory_deduction_receipts")
            .insert(receiptRows)
            .select("id, receipt_id")
        : { data: [], error: null };

    if (savedReceipts.error) throw new Error(savedReceipts.error.message);

    const batchReceiptIdByReceiptId = new Map(
      (savedReceipts.data || []).map((row) => [
        Number(row.receipt_id),
        Number(row.id),
      ])
    );
    const candidateRows = params.preview.receipts.flatMap((receipt) => {
      if (receipt.status === "already_applied") return [];

      const batchReceiptId = batchReceiptIdByReceiptId.get(receipt.receiptId);
      if (!batchReceiptId) {
        throw new Error(
          `Batch receipt row was not saved for receipt ${receipt.receiptId}.`
        );
      }

      return receipt.lines.flatMap((line) =>
        line.deductions.map((deduction) => {
          const candidateStatus =
            receipt.status === "ready"
              ? "selected"
              : receipt.status === "skipped"
                ? "skipped"
                : "blocked";
          const key = idempotencyKey([
            "sales_db_v1",
            batchId,
            receipt.receiptId,
            line.receiptLineId,
            deduction.inventoryItemId,
            line.mappingId,
            deduction.recipeId,
            typeof line.mappingSnapshot?.comboChildIndex === "number"
              ? line.mappingSnapshot.comboChildIndex
              : null,
          ]);

          return {
            processed_line_id: null,
            invoice_ref_id: receipt.refId,
            ref_detail_id: line.refDetailId,
            pos_item_code: line.posItemCode,
            pos_item_name: line.itemName,
            pos_quantity: line.quantitySold,
            mapping_type: line.mappingType,
            inventory_item_id: deduction.inventoryItemId,
            deduct_quantity: deduction.deductQuantity,
            status: candidateStatus,
            error_message: line.blockedReason,
            applied_at: null,
            flow_version: "sales_db_v1",
            batch_id: batchId,
            batch_receipt_id: batchReceiptId,
            receipt_id: receipt.receiptId,
            receipt_line_id: line.receiptLineId,
            receipt_ref_no: receipt.refNo,
            business_date: receipt.businessDate,
            mapping_id: line.mappingId,
            recipe_id: deduction.recipeId,
            operation_type: "preview",
            mapping_snapshot: {
              ...line.mappingSnapshot,
              recipeId: deduction.recipeId,
              recipeVersion: deduction.recipeVersion,
              inventoryItemId: deduction.inventoryItemId,
              deductQuantityPerUnit: deduction.deductQuantityPerUnit,
            },
            inventory_affecting_hash: receipt.inventoryAffectingHash,
            amount_hash: receipt.amountHash,
            idempotency_key: key,
            quantity_sold: line.quantitySold,
            deduct_quantity_per_unit: deduction.deductQuantityPerUnit,
            deduct_quantity_total: deduction.deductQuantity,
            current_quantity_snapshot: deduction.currentQuantity,
            after_quantity_snapshot: deduction.afterQuantity,
            blocked_reason:
              candidateStatus === "blocked"
                ? receipt.blockedReasons.join(" ") ||
                  line.blockedReason ||
                  "Receipt is blocked."
                : null,
            updated_at: now,
          };
        })
      );
    });

    for (let offset = 0; offset < candidateRows.length; offset += 500) {
      const { error } = await supabaseServer
        .from("pos_inventory_deductions")
        .insert(candidateRows.slice(offset, offset + 500));
      if (error) throw new Error(error.message);
    }

    return {
      batchId,
      savedReceiptCount: receiptRows.length,
      savedCandidateCount: candidateRows.length,
    };
  } catch (error) {
    await supabaseServer
      .from("pos_inventory_deduction_batches")
      .update({
        status: "failed",
        error_message:
          error instanceof Error ? error.message : "Batch save failed.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId);
    throw error;
  }
}

export function calculateStoredInventoryTotals(
  deductions: Array<{
    inventory_item_id: number | null;
    deduct_quantity_total: number | string | null;
    current_quantity_snapshot: number | string | null;
    status: string | null;
    receipt_id: number | null;
    receipt_line_id: number | null;
  }>
) {
  const totals = new Map<
    number,
    {
      inventoryItemId: number;
      currentQuantity: number;
      deductQuantity: number;
      receiptIds: Set<number>;
      lineIds: Set<number>;
    }
  >();

  for (const row of deductions) {
    const inventoryItemId = Number(row.inventory_item_id);
    if (!Number.isInteger(inventoryItemId) || inventoryItemId <= 0) continue;

    const current = totals.get(inventoryItemId) ?? {
      inventoryItemId,
      currentQuantity: Number(row.current_quantity_snapshot ?? 0),
      deductQuantity: 0,
      receiptIds: new Set<number>(),
      lineIds: new Set<number>(),
    };
    current.deductQuantity += Number(row.deduct_quantity_total ?? 0);
    if (row.receipt_id) current.receiptIds.add(Number(row.receipt_id));
    if (row.receipt_line_id) current.lineIds.add(Number(row.receipt_line_id));
    totals.set(inventoryItemId, current);
  }

  return Array.from(totals.values()).map((total) => ({
    inventoryItemId: total.inventoryItemId,
    currentQuantity: total.currentQuantity,
    deductQuantity: total.deductQuantity,
    afterQuantity: total.currentQuantity - total.deductQuantity,
    receiptCount: total.receiptIds.size,
    lineCount: total.lineIds.size,
    status:
      total.currentQuantity - total.deductQuantity < 0
        ? "insufficient_stock"
        : "ok",
  }));
}
