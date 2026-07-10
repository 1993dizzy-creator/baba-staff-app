import "server-only";

import { randomUUID } from "node:crypto";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";
import { saveInventoryDeductionPreviewBatch } from "@/lib/sales/inventory-deduction-batches";
import { validateInventoryDeductionBatch } from "@/lib/sales/inventory-deduction-batch-validation";
import { prepareAndApplyReprocessInventoryDeduction } from "@/lib/sales/inventory-deduction-reprocess";
import {
  buildUnifiedInventoryDeductionPreview,
  type UnifiedInventoryDeductionOperationType,
} from "@/lib/sales/inventory-deduction-unified-preview";
import { supabaseServer } from "@/lib/supabase/server";

export const MAX_UNIFIED_EXECUTE_ITEMS = 30;

type ExecuteResultCode =
  | "applied"
  | "already_processed"
  | "stale_preview"
  | "needs_check"
  | "no_op"
  | "failed"
  | "not_supported";

export type UnifiedExecuteItemInput = {
  receiptId: number;
  expectedOperationType: UnifiedInventoryDeductionOperationType;
  expectedFingerprint?: string | null;
  expectedInventoryAffectingHash?: string | null;
  expectedReceiptUpdatedAt?: string | null;
};

export type UnifiedExecuteReceiptResult = {
  receiptId: number;
  expectedOperationType: UnifiedInventoryDeductionOperationType;
  actualOperationType: UnifiedInventoryDeductionOperationType | null;
  result: ExecuteResultCode;
  fingerprint: string | null;
  batchId: number | null;
  deductionReceiptId: number | null;
  reversedDeductionCount: number;
  appliedDeductionCount: number;
  rollbackOnly: boolean;
  failureReason: string | null;
  durationMs: number;
};

export type UnifiedExecuteResponse = {
  success: boolean;
  executionId: string;
  summary: {
    requestedCount: number;
    appliedCount: number;
    initialAppliedCount: number;
    reprocessedCount: number;
    rollbackOnlyCount: number;
    alreadyProcessedCount: number;
    staleCount: number;
    needsCheckCount: number;
    noOpCount: number;
    failedCount: number;
    notSupportedCount: number;
  };
  results: UnifiedExecuteReceiptResult[];
  processedReceiptIds: number[];
  staleReceiptIds: number[];
  needsCheckReceiptIds: number[];
  shouldRefreshPreview: boolean;
};

type CurrentReceipt = Awaited<
  ReturnType<typeof buildUnifiedInventoryDeductionPreview>
>["receipts"][number];

function countPreviewDeductions(
  previewReceipt: Awaited<
    ReturnType<typeof buildInventoryDeductionPreview>
  >["receipts"][number]
) {
  return previewReceipt.lines.reduce(
    (count, line) => count + line.deductions.length,
    0
  );
}

function makeResult(params: {
  item: UnifiedExecuteItemInput;
  actualOperationType: UnifiedInventoryDeductionOperationType | null;
  result: ExecuteResultCode;
  fingerprint?: string | null;
  batchId?: number | null;
  deductionReceiptId?: number | null;
  reversedDeductionCount?: number;
  appliedDeductionCount?: number;
  rollbackOnly?: boolean;
  failureReason?: string | null;
  startedAt: number;
}): UnifiedExecuteReceiptResult {
  return {
    receiptId: params.item.receiptId,
    expectedOperationType: params.item.expectedOperationType,
    actualOperationType: params.actualOperationType,
    result: params.result,
    fingerprint: params.fingerprint ?? null,
    batchId: params.batchId ?? null,
    deductionReceiptId: params.deductionReceiptId ?? null,
    reversedDeductionCount: params.reversedDeductionCount ?? 0,
    appliedDeductionCount: params.appliedDeductionCount ?? 0,
    rollbackOnly: params.rollbackOnly ?? false,
    failureReason: params.failureReason ?? null,
    durationMs: Date.now() - params.startedAt,
  };
}

async function hasAppliedWorkflowReceipt(params: {
  receiptId: number;
  workflowType: "initial_apply" | "reprocess_modified";
  fingerprint: string;
}) {
  const { data, error } = await supabaseServer
    .from("pos_inventory_deduction_receipts")
    .select("id")
    .eq("receipt_id", params.receiptId)
    .eq("workflow_type", params.workflowType)
    .eq("receipt_content_fingerprint", params.fingerprint)
    .eq("status", "applied")
    .limit(1);

  if (error) throw new Error(error.message);
  return Boolean(data?.[0]);
}

async function findBatchReceiptId(params: {
  batchId: number;
  receiptId: number;
}) {
  const { data, error } = await supabaseServer
    .from("pos_inventory_deduction_receipts")
    .select("id")
    .eq("batch_id", params.batchId)
    .eq("receipt_id", params.receiptId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data?.id == null ? null : Number(data.id);
}

function validateCurrentState(
  item: UnifiedExecuteItemInput,
  current: CurrentReceipt
) {
  if (
    item.expectedFingerprint &&
    item.expectedFingerprint !== current.currentFingerprint
  ) {
    return "fingerprint_changed";
  }
  if (
    item.expectedInventoryAffectingHash &&
    item.expectedInventoryAffectingHash !== current.inventoryAffectingHash
  ) {
    return "inventory_plan_changed";
  }
  if (
    item.expectedReceiptUpdatedAt &&
    item.expectedReceiptUpdatedAt !== current.updatedAt
  ) {
    return "receipt_updated";
  }
  if (item.expectedOperationType !== current.operationType) {
    if (
      current.operationType === "no_op" &&
      current.lastProcessedFingerprint === current.currentFingerprint
    ) {
      return "already_processed";
    }
    return "operation_changed";
  }
  return null;
}

async function applyInitialReceipt(params: {
  item: UnifiedExecuteItemInput;
  current: CurrentReceipt;
  actorUsername: string;
  executionId: string;
  startedAt: number;
}) {
  if (params.current.source !== "manual") {
    return makeResult({
      item: params.item,
      actualOperationType: params.current.operationType,
      result: "no_op",
      fingerprint: params.current.currentFingerprint,
      failureReason: "automatic_cron_candidate",
      startedAt: params.startedAt,
    });
  }

  if (params.current.actionableLineCount <= 0) {
    return makeResult({
      item: params.item,
      actualOperationType: params.current.operationType,
      result: "no_op",
      fingerprint: params.current.currentFingerprint,
      failureReason: "no_inventory_movement",
      startedAt: params.startedAt,
    });
  }

  if (params.current.blockingReasons.length > 0) {
    return makeResult({
      item: params.item,
      actualOperationType: params.current.operationType,
      result: "needs_check",
      fingerprint: params.current.currentFingerprint,
      failureReason: "blocking_status",
      startedAt: params.startedAt,
    });
  }

  const preview = await buildInventoryDeductionPreview({
    businessDateFrom: "1970-01-01",
    businessDateTo: "2999-12-31",
    receiptIds: [params.item.receiptId],
  });
  const previewReceipt = preview.receipts.find(
    (receipt) => receipt.receiptId === params.item.receiptId
  );

  if (!previewReceipt || previewReceipt.status !== "ready") {
    return makeResult({
      item: params.item,
      actualOperationType: params.current.operationType,
      result: "needs_check",
      fingerprint: params.current.currentFingerprint,
      failureReason: previewReceipt
        ? `not_ready:${previewReceipt.status}`
        : "preview_receipt_not_found",
      startedAt: params.startedAt,
    });
  }

  const deductionCount = countPreviewDeductions(previewReceipt);
  if (deductionCount === 0) {
    return makeResult({
      item: params.item,
      actualOperationType: params.current.operationType,
      result: "no_op",
      fingerprint: params.current.currentFingerprint,
      failureReason: "no_inventory_movement",
      startedAt: params.startedAt,
    });
  }

  const savedBatch = await saveInventoryDeductionPreviewBatch({
    preview,
    actorUsername: params.actorUsername,
    note: `unified_execute:${params.executionId}:initial_apply`,
    workflowType: "initial_apply",
    receiptContentFingerprintByReceiptId: new Map([
      [params.item.receiptId, params.current.currentFingerprint],
    ]),
    executionId: params.executionId,
  });
  const validation = await validateInventoryDeductionBatch(savedBatch.batchId);

  if (!validation.found || !validation.applyReady) {
    if (
      await hasAppliedWorkflowReceipt({
        receiptId: params.item.receiptId,
        workflowType: "initial_apply",
        fingerprint: params.current.currentFingerprint,
      })
    ) {
      return makeResult({
        item: params.item,
        actualOperationType: params.current.operationType,
        result: "already_processed",
        fingerprint: params.current.currentFingerprint,
        batchId: savedBatch.batchId,
        startedAt: params.startedAt,
      });
    }

    return makeResult({
      item: params.item,
      actualOperationType: params.current.operationType,
      result: "needs_check",
      fingerprint: params.current.currentFingerprint,
      batchId: savedBatch.batchId,
      failureReason: "validation_not_apply_ready",
      startedAt: params.startedAt,
    });
  }

  const validationReceipts = validation.receipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    currentInventoryHash: receipt.currentInventoryHash,
    currentReceiptUpdatedAt: receipt.currentReceiptUpdatedAt,
    applyAllowed: receipt.applyAllowed,
  }));
  const { error } = await supabaseServer.rpc(
    "apply_sales_inventory_deduction_batch",
    {
      p_batch_id: savedBatch.batchId,
      p_actor_username: params.actorUsername,
      p_validation_receipts: validationReceipts,
    }
  );

  if (error) {
    const deductionReceiptId = await findBatchReceiptId({
      batchId: savedBatch.batchId,
      receiptId: params.item.receiptId,
    });
    if (
      await hasAppliedWorkflowReceipt({
        receiptId: params.item.receiptId,
        workflowType: "initial_apply",
        fingerprint: params.current.currentFingerprint,
      })
    ) {
      return makeResult({
        item: params.item,
        actualOperationType: params.current.operationType,
        result: "already_processed",
        fingerprint: params.current.currentFingerprint,
        batchId: savedBatch.batchId,
        deductionReceiptId,
        startedAt: params.startedAt,
      });
    }

    return makeResult({
      item: params.item,
      actualOperationType: params.current.operationType,
      result: "failed",
      fingerprint: params.current.currentFingerprint,
      batchId: savedBatch.batchId,
      deductionReceiptId,
      appliedDeductionCount: deductionCount,
      failureReason: error.message || "apply_failed",
      startedAt: params.startedAt,
    });
  }

  const deductionReceiptId = await findBatchReceiptId({
    batchId: savedBatch.batchId,
    receiptId: params.item.receiptId,
  });

  return makeResult({
    item: params.item,
    actualOperationType: params.current.operationType,
    result: "applied",
    fingerprint: params.current.currentFingerprint,
    batchId: savedBatch.batchId,
    deductionReceiptId,
    appliedDeductionCount: deductionCount,
    startedAt: params.startedAt,
  });
}

async function applyReprocessReceipt(params: {
  item: UnifiedExecuteItemInput;
  current: CurrentReceipt;
  actorUsername: string;
  startedAt: number;
}) {
  const result = await prepareAndApplyReprocessInventoryDeduction({
    receiptId: params.item.receiptId,
    actorUsername: params.actorUsername,
    expectedFingerprint:
      params.item.expectedFingerprint ?? params.current.currentFingerprint,
    expectedInventoryAffectingHash:
      params.item.expectedInventoryAffectingHash ??
      params.current.inventoryAffectingHash,
    expectedReceiptUpdatedAt:
      params.item.expectedReceiptUpdatedAt ?? params.current.updatedAt,
  });

  return makeResult({
    item: params.item,
    actualOperationType: params.current.operationType,
    result: result.result,
    fingerprint: result.fingerprint,
    batchId: result.batchId,
    deductionReceiptId: result.deductionReceiptId,
    reversedDeductionCount: result.reversedDeductionCount,
    appliedDeductionCount: result.appliedDeductionCount,
    rollbackOnly: result.rollbackOnly,
    failureReason: result.failureReason,
    startedAt: params.startedAt,
  });
}

async function executeOne(params: {
  item: UnifiedExecuteItemInput;
  current: CurrentReceipt | null;
  actorUsername: string;
  executionId: string;
}) {
  const startedAt = Date.now();
  const { item, current } = params;

  if (!current) {
    return makeResult({
      item,
      actualOperationType: null,
      result: "needs_check",
      failureReason: "receipt_not_found",
      startedAt,
    });
  }

  const staleReason = validateCurrentState(item, current);
  if (staleReason === "already_processed") {
    return makeResult({
      item,
      actualOperationType: current.operationType,
      result: "already_processed",
      fingerprint: current.currentFingerprint,
      failureReason: null,
      startedAt,
    });
  }
  if (staleReason) {
    return makeResult({
      item,
      actualOperationType: current.operationType,
      result: "stale_preview",
      fingerprint: current.currentFingerprint,
      failureReason: staleReason,
      startedAt,
    });
  }

  if (current.blockingReasons.includes("canceled_after_applied")) {
    return makeResult({
      item,
      actualOperationType: current.operationType,
      result: "not_supported",
      fingerprint: current.currentFingerprint,
      failureReason: "canceled_after_applied_not_supported",
      startedAt,
    });
  }

  if (current.operationType === "initial_apply") {
    return applyInitialReceipt({
      item,
      current,
      actorUsername: params.actorUsername,
      executionId: params.executionId,
      startedAt,
    });
  }

  if (current.operationType === "reprocess_modified") {
    return applyReprocessReceipt({
      item,
      current,
      actorUsername: params.actorUsername,
      startedAt,
    });
  }

  if (current.operationType === "needs_check") {
    return makeResult({
      item,
      actualOperationType: current.operationType,
      result: "needs_check",
      fingerprint: current.currentFingerprint,
      failureReason: current.blockingReasons.join("; ") || "blocking_status",
      startedAt,
    });
  }

  return makeResult({
    item,
    actualOperationType: current.operationType,
    result: "no_op",
    fingerprint: current.currentFingerprint,
    failureReason:
      current.source === "manual" ? "no_inventory_movement" : "automatic_cron_candidate",
    startedAt,
  });
}

function buildSummary(results: UnifiedExecuteReceiptResult[]) {
  return results.reduce(
    (summary, result) => {
      summary.requestedCount += 1;
      if (result.result === "applied") summary.appliedCount += 1;
      if (
        result.result === "applied" &&
        result.expectedOperationType === "initial_apply"
      ) {
        summary.initialAppliedCount += 1;
      }
      if (
        result.result === "applied" &&
        result.expectedOperationType === "reprocess_modified"
      ) {
        summary.reprocessedCount += 1;
      }
      if (result.rollbackOnly) summary.rollbackOnlyCount += 1;
      if (result.result === "already_processed") {
        summary.alreadyProcessedCount += 1;
      }
      if (result.result === "stale_preview") summary.staleCount += 1;
      if (result.result === "needs_check") summary.needsCheckCount += 1;
      if (result.result === "no_op") summary.noOpCount += 1;
      if (result.result === "failed") summary.failedCount += 1;
      if (result.result === "not_supported") summary.notSupportedCount += 1;
      return summary;
    },
    {
      requestedCount: 0,
      appliedCount: 0,
      initialAppliedCount: 0,
      reprocessedCount: 0,
      rollbackOnlyCount: 0,
      alreadyProcessedCount: 0,
      staleCount: 0,
      needsCheckCount: 0,
      noOpCount: 0,
      failedCount: 0,
      notSupportedCount: 0,
    }
  );
}

export async function executeUnifiedInventoryDeductions(params: {
  actorUsername: string;
  items: UnifiedExecuteItemInput[];
  executionId?: string;
}): Promise<UnifiedExecuteResponse> {
  const executionId = params.executionId ?? randomUUID();
  const results: UnifiedExecuteReceiptResult[] = [];

  console.info(
    "[SALES_INVENTORY_UNIFIED_EXECUTE_START]",
    JSON.stringify({ executionId, requestedCount: params.items.length })
  );

  for (const item of params.items) {
    const unified = await buildUnifiedInventoryDeductionPreview({
      businessDateFrom: "1970-01-01",
      businessDateTo: "2999-12-31",
      receiptIds: [item.receiptId],
    });
    const result = await executeOne({
      item,
      current:
        unified.receipts.find((receipt) => receipt.receiptId === item.receiptId) ??
        null,
      actorUsername: params.actorUsername,
      executionId,
    });
    results.push(result);
    console.info(
      "[SALES_INVENTORY_UNIFIED_EXECUTE_RECEIPT]",
      JSON.stringify({
        executionId,
        receiptId: result.receiptId,
        operationType: result.actualOperationType,
        result: result.result,
        batchId: result.batchId,
        durationMs: result.durationMs,
      })
    );
  }

  const summary = buildSummary(results);
  return {
    success: true,
    executionId,
    summary,
    results,
    processedReceiptIds: results
      .filter(
        (result) =>
          result.result === "applied" ||
          result.result === "already_processed" ||
          result.result === "no_op"
      )
      .map((result) => result.receiptId),
    staleReceiptIds: results
      .filter((result) => result.result === "stale_preview")
      .map((result) => result.receiptId),
    needsCheckReceiptIds: results
      .filter(
        (result) =>
          result.result === "needs_check" ||
          result.result === "failed" ||
          result.result === "not_supported"
      )
      .map((result) => result.receiptId),
    shouldRefreshPreview: true,
  };
}
