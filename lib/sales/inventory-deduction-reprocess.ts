import "server-only";

import { createHash } from "node:crypto";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";
import { buildUnifiedInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-unified-preview";
import { supabaseServer } from "@/lib/supabase/server";

type InventoryDeductionPreview = Awaited<
  ReturnType<typeof buildInventoryDeductionPreview>
>;
type PreviewReceipt = InventoryDeductionPreview["receipts"][number];
type PreviewLine = PreviewReceipt["lines"][number];

export type ReprocessInventoryDeductionResult = {
  ok: boolean;
  result:
    | "applied"
    | "already_processed"
    | "stale_preview"
    | "needs_check"
    | "not_supported"
    | "failed";
  receiptId: number;
  batchId: number | null;
  deductionReceiptId: number | null;
  fingerprint: string | null;
  reversedDeductionCount: number;
  appliedDeductionCount: number;
  affectedInventoryCount: number;
  rollbackOnly: boolean;
  failureReason: string | null;
  rpcResult?: unknown;
};

type PrepareReprocessParams = {
  receiptId: number;
  actorUsername: string;
  expectedFingerprint?: string | null;
  expectedInventoryAffectingHash?: string | null;
  expectedReceiptUpdatedAt?: string | null;
};

const HARD_BLOCKING_STATUSES = new Set([
  "missing_mapping",
  "invalid_mapping",
  "review_required",
  "incomplete_recipe",
  "combo_incomplete_recipe",
]);
const HARD_BLOCKING_LINE_TYPES = new Set([
  "combo_missing_mapping",
  "combo_invalid_mapping",
  "missing_mapping",
  "invalid_mapping",
  "incomplete_recipe",
  "combo_incomplete_recipe",
]);
const NEUTRAL_STATUSES = new Set([
  "keg_tracked",
  "ignore",
  "ignored",
  "skipped",
  "manual_review",
]);
const NEUTRAL_LINE_TYPES = new Set([
  "combo_ignore",
  "ignore",
  "manual",
]);

function idempotencyKey(parts: Array<string | number | null>) {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function getHardBlockingReasons(receipt: PreviewReceipt) {
  const reasons = new Set<string>();
  const lineByRefDetailId = new Map(
    receipt.lines
      .filter((line) => Boolean(line.refDetailId))
      .map((line) => [line.refDetailId as string, line])
  );

  for (const line of receipt.lines) {
    if (isNeutralLine(line) || line.blocksReceipt !== true) {
      continue;
    }

    const hasIncompleteAncestor = hasIncompleteRecipeAncestor(
      line,
      lineByRefDetailId
    );

    if (
      hasIncompleteAncestor ||
      HARD_BLOCKING_STATUSES.has(line.status) ||
      HARD_BLOCKING_LINE_TYPES.has(line.lineType)
    ) {
      reasons.add(
        line.blockedReason ||
          (hasIncompleteAncestor ? "incomplete_recipe" : null) ||
          line.status ||
          line.lineType ||
          "inventory_deduction_blocked"
      );
    }
  }

  return Array.from(reasons);
}

function isIncompleteRecipeLine(line: PreviewLine) {
  return (
    line.status === "incomplete_recipe" ||
    line.status === "combo_incomplete_recipe" ||
    line.lineType === "incomplete_recipe" ||
    line.lineType === "combo_incomplete_recipe"
  );
}

function isNeutralLine(line: PreviewLine) {
  return (
    line.isKegTracked === true ||
    NEUTRAL_STATUSES.has(line.status) ||
    NEUTRAL_LINE_TYPES.has(line.lineType)
  );
}

function hasIncompleteRecipeAncestor(
  line: PreviewLine,
  lineByRefDetailId: Map<string, PreviewLine>
) {
  const visited = new Set<string>();
  let parentRefDetailId = line.parentRefDetailId;

  while (parentRefDetailId) {
    if (visited.has(parentRefDetailId)) return false;
    visited.add(parentRefDetailId);

    const parent = lineByRefDetailId.get(parentRefDetailId);
    if (!parent) return false;
    if (isIncompleteRecipeLine(parent)) return true;
    parentRefDetailId = parent.parentRefDetailId;
  }

  return false;
}

async function findSupersededDeductionReceiptId(receiptId: number) {
  const { data, error } = await supabaseServer
    .from("pos_inventory_deduction_receipts")
    .select("id")
    .eq("receipt_id", receiptId)
    .eq("status", "applied")
    .order("applied_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  return data?.[0]?.id ? Number(data[0].id) : null;
}

async function saveReprocessBatch(params: {
  previewReceipt: PreviewReceipt;
  currentFingerprint: string;
  actorUsername: string;
  supersedesDeductionReceiptId: number | null;
}) {
  const now = new Date().toISOString();
  const deductionCount = params.previewReceipt.lines.reduce(
    (count, line) => count + line.deductions.length,
    0
  );
  const { data: batch, error: batchError } = await supabaseServer
    .from("pos_inventory_deduction_batches")
    .insert({
      flow_version: "sales_db_v1",
      business_date_from: params.previewReceipt.businessDate,
      business_date_to: params.previewReceipt.businessDate,
      source: "reprocess_modified",
      status: "previewed",
      receipt_count: 1,
      ready_receipt_count: 1,
      blocked_receipt_count: 0,
      skipped_receipt_count: 0,
      already_applied_receipt_count: 0,
      created_by: params.actorUsername,
      created_at: now,
      previewed_at: now,
      note: "reprocess_modified_receipt",
      metadata: {
        workflowType: "reprocess_modified",
        receiptId: params.previewReceipt.receiptId,
        currentFingerprint: params.currentFingerprint,
        inventoryAffectingHash: params.previewReceipt.inventoryAffectingHash,
        rollbackOnly: deductionCount === 0,
      },
      updated_at: now,
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    throw new Error(
      batchError?.message || "Failed to create reprocess batch."
    );
  }

  const batchId = Number(batch.id);

  try {
    const { data: batchReceipt, error: receiptError } = await supabaseServer
      .from("pos_inventory_deduction_receipts")
      .insert({
        batch_id: batchId,
        receipt_id: params.previewReceipt.receiptId,
        receipt_ref_no: params.previewReceipt.refNo,
        business_date: params.previewReceipt.businessDate,
        status: "ready",
        inventory_affecting_hash: params.previewReceipt.inventoryAffectingHash,
        amount_hash: params.previewReceipt.amountHash,
        previewed_receipt_updated_at:
          params.previewReceipt.previewedReceiptUpdatedAt,
        blocked_reasons: [],
        line_summary: {
          refId: params.previewReceipt.refId,
          refDate: params.previewReceipt.refDate,
          hashVersion: params.previewReceipt.hashVersion,
          workflowType: "reprocess_modified",
          currentFingerprint: params.currentFingerprint,
          lines: params.previewReceipt.lines,
        },
        selected_for_apply: true,
        workflow_type: "reprocess_modified",
        receipt_content_fingerprint: params.currentFingerprint,
        supersedes_deduction_receipt_id:
          params.supersedesDeductionReceiptId,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();

    if (receiptError || !batchReceipt) {
      throw new Error(
        receiptError?.message || "Failed to create reprocess receipt row."
      );
    }

    const batchReceiptId = Number(batchReceipt.id);
    const candidateRows = params.previewReceipt.lines.flatMap(
      (line: PreviewLine) =>
        line.deductions.map((deduction) => {
          const key = idempotencyKey([
            "reprocess",
            batchId,
            params.previewReceipt.receiptId,
            params.currentFingerprint,
            "deduction",
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
            invoice_ref_id: params.previewReceipt.refId,
            ref_detail_id: line.refDetailId,
            pos_item_code: line.posItemCode,
            pos_item_name: line.itemName,
            pos_quantity: line.quantitySold,
            mapping_type: line.mappingType,
            inventory_item_id: deduction.inventoryItemId,
            deduct_quantity: deduction.deductQuantity,
            status: "selected",
            error_message: null,
            applied_at: null,
            flow_version: "sales_db_v1",
            batch_id: batchId,
            batch_receipt_id: batchReceiptId,
            receipt_id: params.previewReceipt.receiptId,
            receipt_line_id: line.receiptLineId,
            receipt_ref_no: params.previewReceipt.refNo,
            business_date: params.previewReceipt.businessDate,
            mapping_id: line.mappingId,
            recipe_id: deduction.recipeId,
            operation_type: "preview",
            mapping_snapshot: {
              ...line.mappingSnapshot,
              recipeId: deduction.recipeId,
              recipeVersion: deduction.recipeVersion,
              inventoryItemId: deduction.inventoryItemId,
              deductQuantityPerUnit: deduction.deductQuantityPerUnit,
              workflowType: "reprocess_modified",
              receiptContentFingerprint: params.currentFingerprint,
            },
            inventory_affecting_hash:
              params.previewReceipt.inventoryAffectingHash,
            amount_hash: params.previewReceipt.amountHash,
            idempotency_key: key,
            quantity_sold: line.quantitySold,
            deduct_quantity_per_unit: deduction.deductQuantityPerUnit,
            deduct_quantity_total: deduction.deductQuantity,
            current_quantity_snapshot: deduction.currentQuantity,
            after_quantity_snapshot: deduction.afterQuantity,
            blocked_reason: null,
            updated_at: now,
          };
        })
    );

    for (let offset = 0; offset < candidateRows.length; offset += 500) {
      const { error } = await supabaseServer
        .from("pos_inventory_deductions")
        .insert(candidateRows.slice(offset, offset + 500));
      if (error) throw new Error(error.message);
    }

    return {
      batchId,
      batchReceiptId,
      candidateCount: candidateRows.length,
    };
  } catch (error) {
    await supabaseServer
      .from("pos_inventory_deduction_batches")
      .update({
        status: "failed",
        error_message:
          error instanceof Error ? error.message : "Reprocess batch save failed.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId);
    throw error;
  }
}

export async function prepareAndApplyReprocessInventoryDeduction(
  params: PrepareReprocessParams
): Promise<ReprocessInventoryDeductionResult> {
  const unified = await buildUnifiedInventoryDeductionPreview({
    businessDateFrom: "1970-01-01",
    businessDateTo: "2999-12-31",
    receiptIds: [params.receiptId],
  });
  const unifiedReceipt = unified.receipts.find(
    (receipt) => receipt.receiptId === params.receiptId
  );

  if (!unifiedReceipt) {
    return {
      ok: false,
      result: "needs_check",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: null,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: false,
      failureReason: "receipt_not_found",
    };
  }

  if (
    params.expectedFingerprint &&
    params.expectedFingerprint !== unifiedReceipt.currentFingerprint
  ) {
    return {
      ok: false,
      result: "stale_preview",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: false,
      failureReason: "fingerprint_changed",
    };
  }

  const preview = await buildInventoryDeductionPreview({
    businessDateFrom: "1970-01-01",
    businessDateTo: "2999-12-31",
    receiptIds: [params.receiptId],
  });
  const previewReceipt = preview.receipts.find(
    (receipt) => receipt.receiptId === params.receiptId
  );

  if (!previewReceipt) {
    return {
      ok: false,
      result: "not_supported",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: false,
      failureReason: "receipt_not_previewable",
    };
  }

  if (
    params.expectedInventoryAffectingHash &&
    params.expectedInventoryAffectingHash !==
      previewReceipt.inventoryAffectingHash
  ) {
    return {
      ok: false,
      result: "stale_preview",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: false,
      failureReason: "inventory_affecting_hash_changed",
    };
  }

  if (
    params.expectedReceiptUpdatedAt &&
    params.expectedReceiptUpdatedAt !== previewReceipt.previewedReceiptUpdatedAt
  ) {
    return {
      ok: false,
      result: "stale_preview",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: false,
      failureReason: "receipt_updated_at_changed",
    };
  }

  const hardBlockingReasons = getHardBlockingReasons(previewReceipt);
  if (hardBlockingReasons.length > 0) {
    return {
      ok: false,
      result: "needs_check",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: false,
      failureReason: hardBlockingReasons.join("; "),
    };
  }

  const canAttemptReprocess =
    unifiedReceipt.operationType === "reprocess_modified" ||
    (unifiedReceipt.operationType === "needs_check" &&
      unifiedReceipt.activeDeductionCount > 0 &&
      hardBlockingReasons.length === 0);

  if (!canAttemptReprocess) {
    return {
      ok: false,
      result:
        unifiedReceipt.operationType === "no_op" &&
        unifiedReceipt.lastProcessedFingerprint ===
          unifiedReceipt.currentFingerprint
          ? "already_processed"
          : "needs_check",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: false,
      failureReason:
        unifiedReceipt.activeDeductionCount === 0
          ? "initial_apply_required_or_not_reprocess"
          : "not_reprocess_modified",
    };
  }

  const supersedesDeductionReceiptId =
    await findSupersededDeductionReceiptId(params.receiptId);
  const saved = await saveReprocessBatch({
    previewReceipt,
    currentFingerprint: unifiedReceipt.currentFingerprint,
    actorUsername: params.actorUsername,
    supersedesDeductionReceiptId,
  });

  const { data, error } = await supabaseServer.rpc(
    "reprocess_modified_sales_inventory_deduction_receipt",
    {
      p_batch_receipt_id: saved.batchReceiptId,
      p_actor_username: params.actorUsername,
      p_expected_receipt_updated_at: previewReceipt.previewedReceiptUpdatedAt,
      p_expected_receipt_content_fingerprint:
        unifiedReceipt.currentFingerprint,
      p_expected_inventory_affecting_hash:
        previewReceipt.inventoryAffectingHash,
    }
  );

  if (error) {
    return {
      ok: false,
      result: "failed",
      receiptId: params.receiptId,
      batchId: saved.batchId,
      deductionReceiptId: saved.batchReceiptId,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: saved.candidateCount,
      affectedInventoryCount: 0,
      rollbackOnly: saved.candidateCount === 0,
      failureReason: error.message,
    };
  }

  const rpcResult = data as Partial<ReprocessInventoryDeductionResult> | null;
  return {
    ok: rpcResult?.result === "applied",
    result:
      (rpcResult?.result as ReprocessInventoryDeductionResult["result"]) ??
      "failed",
    receiptId: Number(rpcResult?.receiptId ?? params.receiptId),
    batchId: rpcResult?.batchId == null ? saved.batchId : Number(rpcResult.batchId),
    deductionReceiptId:
      rpcResult?.deductionReceiptId == null
        ? saved.batchReceiptId
        : Number(rpcResult.deductionReceiptId),
    fingerprint:
      typeof rpcResult?.fingerprint === "string"
        ? rpcResult.fingerprint
        : unifiedReceipt.currentFingerprint,
    reversedDeductionCount: Number(rpcResult?.reversedDeductionCount ?? 0),
    appliedDeductionCount: Number(rpcResult?.appliedDeductionCount ?? 0),
    affectedInventoryCount: Number(rpcResult?.affectedInventoryCount ?? 0),
    rollbackOnly: Boolean(rpcResult?.rollbackOnly ?? saved.candidateCount === 0),
    failureReason:
      typeof rpcResult?.failureReason === "string"
        ? rpcResult.failureReason
        : null,
    rpcResult: data,
  };
}
