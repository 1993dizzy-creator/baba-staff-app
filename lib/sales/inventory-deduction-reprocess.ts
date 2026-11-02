import "server-only";
import { isInventoryDeductionBusy } from "@/lib/sales/inventory-deduction-lock";

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
  retryable?: boolean;
  requiresRefresh?: boolean;
  retryCondition?: string;
  outcomeUnknown?: boolean;
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

async function executeReprocessPlan(params: {
  previewReceipt: PreviewReceipt;
  currentFingerprint: string;
  actorUsername: string;
}) {
  const candidateRows = params.previewReceipt.lines.flatMap(
    (line: PreviewLine) =>
      line.deductions.map((deduction) => {
        return {
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
          quantity_sold: line.quantitySold,
          deduct_quantity_per_unit: deduction.deductQuantityPerUnit,
          deduct_quantity_total: deduction.deductQuantity,
          current_quantity_snapshot: deduction.currentQuantity,
          after_quantity_snapshot: deduction.afterQuantity,
          blocked_reason: null,
        };
      })
  );


  // Candidate creation, deduplication and stock application share one DB transaction.
  // A repeated failure reuses its result; changed dependencies permit a new attempt.
  const { data, error } = await supabaseServer.rpc(
    "prepare_and_apply_sales_inventory_reprocess",
    {
      p_receipt_id: params.previewReceipt.receiptId,
      p_actor_username: params.actorUsername,
      p_expected_receipt_updated_at: params.previewReceipt.previewedReceiptUpdatedAt,
      p_expected_receipt_content_fingerprint: params.currentFingerprint,
      p_expected_inventory_affecting_hash: params.previewReceipt.inventoryAffectingHash,
      p_preview: {
        amount_hash: params.previewReceipt.amountHash,
        line_summary: {
          refId: params.previewReceipt.refId,
          refDate: params.previewReceipt.refDate,
          hashVersion: params.previewReceipt.hashVersion,
          workflowType: "reprocess_modified",
          currentFingerprint: params.currentFingerprint,
          lines: params.previewReceipt.lines,
        },
      },
      p_candidates: candidateRows,
    }
  );
  return { data, error, candidateCount: candidateRows.length };
}

export async function prepareAndApplyReprocessInventoryDeduction(
  params: PrepareReprocessParams
): Promise<ReprocessInventoryDeductionResult> {
  // App-first rollout: do not even probe the new RPC/table contract until its
  // migration and schema cache have been separately approved and verified.
  if (process.env.POS_REPROCESS_P1_ENABLED !== "enabled") {
    return {
      ok: false, result: "needs_check", receiptId: params.receiptId,
      batchId: null, deductionReceiptId: null, fingerprint: params.expectedFingerprint ?? null,
      reversedDeductionCount: 0, appliedDeductionCount: 0, affectedInventoryCount: 0,
      rollbackOnly: false, failureReason: "pos_reprocess_migration_required",
      retryable: false, requiresRefresh: false,
      retryCondition: "p1_installed_cache_verified_and_reprocess_enabled",
    };
  }
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

  const { data, error, candidateCount } = await executeReprocessPlan({
    previewReceipt,
    currentFingerprint: unifiedReceipt.currentFingerprint,
    actorUsername: params.actorUsername,
  });

  if (error) {
    const busy = isInventoryDeductionBusy(error) || error.code === "40001";
    const notInstalled = ["PGRST202", "42883"].includes(error.code ?? "");
    const unknown = ["08000", "08006", "PGRST000"].includes(error.code ?? "");
    return {
      ok: false,
      result: busy ? "stale_preview" : notInstalled || error.code === "42501" ? "needs_check" : "failed",
      receiptId: params.receiptId,
      batchId: null,
      deductionReceiptId: null,
      fingerprint: unifiedReceipt.currentFingerprint,
      reversedDeductionCount: 0,
      appliedDeductionCount: 0,
      affectedInventoryCount: 0,
      rollbackOnly: candidateCount === 0,
      failureReason: busy ? "inventory_busy_refresh_required" : notInstalled ? "pos_reprocess_migration_required"
        : error.code === "42501" ? "inventory_writer_permission_review_required" : unknown ? "inventory_reprocess_outcome_unknown" : "inventory_reprocess_rpc_failed",
      retryable: busy,
      requiresRefresh: busy || unknown,
      outcomeUnknown: unknown,
      retryCondition: busy ? "refresh_receipt_mapping_and_stock" : notInstalled ? "p1_rpc_installed_and_schema_cache_ready"
        : unknown ? "reconcile_outcome_then_refresh" : "operator_contract_review",
    };
  }

  const rpcResult = data as Partial<ReprocessInventoryDeductionResult> | null;
  return {
    ok: rpcResult?.result === "applied",
    result:
      (rpcResult?.result as ReprocessInventoryDeductionResult["result"]) ??
      "failed",
    receiptId: Number(rpcResult?.receiptId ?? params.receiptId),
    batchId: rpcResult?.batchId == null ? null : Number(rpcResult.batchId),
    deductionReceiptId:
      rpcResult?.deductionReceiptId == null
        ? null
        : Number(rpcResult.deductionReceiptId),
    fingerprint:
      typeof rpcResult?.fingerprint === "string"
        ? rpcResult.fingerprint
        : unifiedReceipt.currentFingerprint,
    reversedDeductionCount: Number(rpcResult?.reversedDeductionCount ?? 0),
    appliedDeductionCount: Number(rpcResult?.appliedDeductionCount ?? 0),
    affectedInventoryCount: Number(rpcResult?.affectedInventoryCount ?? 0),
    rollbackOnly: Boolean(rpcResult?.rollbackOnly ?? candidateCount === 0),
    failureReason:
      typeof rpcResult?.failureReason === "string"
        ? rpcResult.failureReason
        : null,
    rpcResult: data,
  };
}
