import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";
import {
  getReceiptContentFingerprint,
  type ReceiptContentFingerprintLineInput,
} from "@/lib/sales/inventory-deduction-fingerprint";

type InventoryDeductionPreview = Awaited<
  ReturnType<typeof buildInventoryDeductionPreview>
>;
type PreviewReceipt = InventoryDeductionPreview["receipts"][number];
type PreviewLine = PreviewReceipt["lines"][number];

export type UnifiedInventoryDeductionOperationType =
  | "initial_apply"
  | "reprocess_modified"
  | "needs_check"
  | "no_op";

type ReceiptRow = {
  id: number;
  ref_id: string | null;
  ref_no: string | null;
  business_date: string | null;
  source: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
  is_modified: boolean | null;
  updated_at: string | null;
};

type LineRow = ReceiptContentFingerprintLineInput & {
  receipt_id: number | null;
};

type DeductionRow = {
  id: number;
  receipt_id: number | null;
  status: string | null;
  operation_type: string | null;
  applied_at: string | null;
  updated_at: string | null;
  inventory_log_id: number | string | null;
  reversal_of_deduction_id: number | string | null;
  batch_receipt_id: number | string | null;
};

type DeductionReceiptRow = {
  id: number;
  receipt_id: number | null;
  status: string | null;
  workflow_type: string | null;
  receipt_content_fingerprint: string | null;
  applied_at: string | null;
  updated_at: string | null;
  created_at: string | null;
};

type AppliedReceiptHistory = {
  activeAppliedDeductionIds: number[];
  activeAppliedDeductionCount: number;
  lastAppliedAt: string | null;
  lastProcessedAt: string | null;
  lastProcessedFingerprint: string | null;
  hasSuccessfulCurrentFingerprint: boolean;
  hasSuccessfulInventoryProcessingHistory: boolean;
  isLegacyApplied: boolean;
};

export type UnifiedInventoryDeductionPreviewReceipt = {
  operationType: UnifiedInventoryDeductionOperationType;
  receiptId: number;
  source: string | null;
  refNo: string | null;
  currentFingerprint: string;
  lastProcessedFingerprint: string | null;
  activeDeductionCount: number;
  activeDeductionIds: number[];
  actionableLineCount: number;
  neutralLineCount: number;
  blockingReasons: string[];
  rawPreviewStatus: string | null;
  canExecute: boolean;
  isLegacyApplied: boolean;
  inventoryAffectingHash: string | null;
  updatedAt: string | null;
};

export type UnifiedInventoryDeductionPreview = {
  generatedAt: string;
  businessDateFrom: string;
  businessDateTo: string;
  summary: {
    totalReceiptCount: number;
    initialApplyCount: number;
    reprocessModifiedCount: number;
    needsCheckCount: number;
    noOpCount: number;
    executableCount: number;
  };
  receipts: UnifiedInventoryDeductionPreviewReceipt[];
};

const RECEIPT_SELECT =
  "id, ref_id, ref_no, business_date, source, payment_status, is_canceled, is_modified, updated_at";
const LINE_SELECT =
  "receipt_id, ref_detail_id, parent_ref_detail_id, item_id, item_code, quantity, ref_detail_type, inventory_item_type, is_option, is_excluded";
const DEDUCTION_SELECT =
  "id, receipt_id, status, operation_type, applied_at, updated_at, inventory_log_id, reversal_of_deduction_id, batch_receipt_id";
const DEDUCTION_RECEIPT_SELECT =
  "id, receipt_id, status, workflow_type, receipt_content_fingerprint, applied_at, updated_at, created_at";

const SUCCESS_DEDUCTION_STATUSES = new Set(["applied", "success"]);
const SUCCESS_DEDUCTION_RECEIPT_STATUSES = new Set(["applied"]);
const NEUTRAL_STATUSES = new Set([
  "keg_tracked",
  "incomplete_recipe",
  "combo_incomplete_recipe",
  "ignore",
  "ignored",
  "skipped",
]);
const NEUTRAL_LINE_TYPES = new Set([
  "combo_ignore",
  "combo_incomplete_recipe",
  "ignore",
  "incomplete_recipe",
]);
const BLOCKING_STATUSES = new Set([
  "missing_mapping",
  "invalid_mapping",
  "manual_review",
  "review_required",
  "insufficient_stock",
]);
const BLOCKING_LINE_TYPES = new Set([
  "combo_missing_mapping",
  "combo_invalid_mapping",
  "missing_mapping",
  "invalid_mapping",
  "manual",
]);

function isBusinessDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function compareIso(left: string | null, right: string | null) {
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  return new Date(left).getTime() - new Date(right).getTime();
}

function isAfter(left: string | null, right: string | null) {
  return compareIso(left, right) > 0;
}

function isSuccessfulDeduction(row: DeductionRow) {
  return (
    SUCCESS_DEDUCTION_STATUSES.has(row.status ?? "") ||
    Boolean(row.applied_at) ||
    Boolean(row.inventory_log_id)
  );
}

function isSuccessfulDeductionReceipt(row: DeductionReceiptRow) {
  return SUCCESS_DEDUCTION_RECEIPT_STATUSES.has(row.status ?? "");
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

function getLineClassification(receipt: PreviewReceipt) {
  const lineByRefDetailId = new Map(
    receipt.lines
      .filter((line) => Boolean(line.refDetailId))
      .map((line) => [line.refDetailId as string, line])
  );
  const blockingReasons = new Set<string>();
  let actionableLineCount = 0;
  let neutralLineCount = 0;

  for (const line of receipt.lines) {
    const neutral =
      isNeutralLine(line) || hasIncompleteRecipeAncestor(line, lineByRefDetailId);
    if (line.deductions.length > 0) actionableLineCount += 1;
    if (neutral) neutralLineCount += 1;

    const blocking =
      !neutral &&
      (BLOCKING_STATUSES.has(line.status) ||
        BLOCKING_LINE_TYPES.has(line.lineType) ||
        line.deductions.some(
          (deduction) => deduction.status === "insufficient_stock"
        ));
    if (blocking) {
      blockingReasons.add(
        line.blockedReason ||
          line.status ||
          line.lineType ||
          "inventory_deduction_blocked"
      );
    }
  }

  for (const reason of receipt.blockedReasons) {
    if (
      receipt.status === "applied_after_modified" ||
      receipt.status === "already_applied"
    ) {
      continue;
    }
    if (receipt.status === "incomplete_recipe") continue;
    blockingReasons.add(reason);
  }

  return {
    actionableLineCount,
    neutralLineCount,
    blockingReasons: Array.from(blockingReasons),
  };
}

function getEmptyLineClassification() {
  return {
    actionableLineCount: 0,
    neutralLineCount: 0,
    blockingReasons: [] as string[],
  };
}

function resolveAppliedHistory(
  receiptId: number,
  deductions: DeductionRow[],
  deductionReceipts: DeductionReceiptRow[],
  currentFingerprint: string
): AppliedReceiptHistory {
  const successfulDeductions = deductions.filter(
    (row) => Number(row.receipt_id) === receiptId && isSuccessfulDeduction(row)
  );
  const revertedDeductionIds = new Set(
    successfulDeductions
      .filter(
        (row) =>
          row.operation_type === "revert" && row.reversal_of_deduction_id != null
      )
      .map((row) => Number(row.reversal_of_deduction_id))
  );
  const activeAppliedDeductions = successfulDeductions.filter(
    (row) =>
      row.operation_type !== "revert" && !revertedDeductionIds.has(Number(row.id))
  );
  const successfulReceiptRows = deductionReceipts
    .filter(
      (row) =>
        Number(row.receipt_id) === receiptId && isSuccessfulDeductionReceipt(row)
    )
    .sort((left, right) =>
      compareIso(
        right.applied_at || right.updated_at || right.created_at,
        left.applied_at || left.updated_at || left.created_at
      )
    );
  const processedReceiptRows = successfulReceiptRows.filter(
    (row) =>
      row.workflow_type === "initial_apply" ||
      row.workflow_type === "reprocess_modified"
  );
  const lastProcessedWithFingerprint = processedReceiptRows.find(
    (row) => Boolean(row.receipt_content_fingerprint)
  );
  const latestReceiptRow = successfulReceiptRows[0] ?? null;
  const lastDeductionAt = successfulDeductions.reduce<string | null>(
    (latest, row) => {
      const timestamp = row.applied_at || row.updated_at;
      return compareIso(timestamp, latest) > 0 ? timestamp : latest;
    },
    null
  );
  const lastReceiptAt =
    latestReceiptRow?.applied_at ||
    latestReceiptRow?.updated_at ||
    latestReceiptRow?.created_at ||
    null;

  return {
    activeAppliedDeductionIds: activeAppliedDeductions.map((row) =>
      Number(row.id)
    ),
    activeAppliedDeductionCount: activeAppliedDeductions.length,
    lastAppliedAt: lastDeductionAt,
    lastProcessedAt: compareIso(lastReceiptAt, lastDeductionAt) > 0
      ? lastReceiptAt
      : lastDeductionAt,
    lastProcessedFingerprint:
      lastProcessedWithFingerprint?.receipt_content_fingerprint ?? null,
    hasSuccessfulCurrentFingerprint: processedReceiptRows.some(
      (row) => row.receipt_content_fingerprint === currentFingerprint
    ),
    hasSuccessfulInventoryProcessingHistory:
      processedReceiptRows.length > 0 || successfulDeductions.length > 0,
    isLegacyApplied:
      successfulDeductions.length > 0 &&
      !processedReceiptRows.some((row) =>
        Boolean(row.receipt_content_fingerprint)
      ),
  };
}

async function fetchReceipts(input: {
  businessDateFrom: string;
  businessDateTo: string;
  receiptIds: number[];
}) {
  let query = supabaseServer
    .from("pos_sales_receipts")
    .select(RECEIPT_SELECT)
    .order("business_date", { ascending: true })
    .order("id", { ascending: true });

  if (input.receiptIds.length > 0) {
    query = query.in("id", input.receiptIds);
  } else {
    query = query
      .eq("payment_status", 3)
      .gte("business_date", input.businessDateFrom)
      .lte("business_date", input.businessDateTo);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []) as ReceiptRow[];
}

async function fetchLines(receiptIds: number[]) {
  if (receiptIds.length === 0) return [] as LineRow[];
  const { data, error } = await supabaseServer
    .from("pos_sales_receipt_lines")
    .select(LINE_SELECT)
    .in("receipt_id", receiptIds);
  if (error) throw new Error(error.message);
  return (data || []).map((line) => ({
    receipt_id: line.receipt_id == null ? null : Number(line.receipt_id),
    itemId: line.item_id,
    itemCode: line.item_code,
    refDetailId: line.ref_detail_id,
    parentRefDetailId: line.parent_ref_detail_id,
    quantity: line.quantity,
    isOption: line.is_option,
    isExcluded: line.is_excluded,
    refDetailType: line.ref_detail_type,
    inventoryItemType: line.inventory_item_type,
  })) as LineRow[];
}

async function fetchDeductions(receiptIds: number[]) {
  if (receiptIds.length === 0) return [] as DeductionRow[];
  const { data, error } = await supabaseServer
    .from("pos_inventory_deductions")
    .select(DEDUCTION_SELECT)
    .in("receipt_id", receiptIds);
  if (error) throw new Error(error.message);
  return (data || []) as DeductionRow[];
}

async function fetchDeductionReceipts(receiptIds: number[]) {
  if (receiptIds.length === 0) return [] as DeductionReceiptRow[];
  const { data, error } = await supabaseServer
    .from("pos_inventory_deduction_receipts")
    .select(DEDUCTION_RECEIPT_SELECT)
    .in("receipt_id", receiptIds);
  if (error) throw new Error(error.message);
  return (data || []) as DeductionReceiptRow[];
}

function classifyReceipt(params: {
  receipt: ReceiptRow;
  previewReceipt: PreviewReceipt | null;
  currentFingerprint: string;
  history: AppliedReceiptHistory;
}) {
  const { receipt, previewReceipt, currentFingerprint, history } = params;
  const previewClassification = previewReceipt
    ? getLineClassification(previewReceipt)
    : getEmptyLineClassification();
  const blockingReasons = [...previewClassification.blockingReasons];
  const hasActiveDeduction = history.activeAppliedDeductionCount > 0;
  const hasProcessingHistory =
    history.hasSuccessfulInventoryProcessingHistory;
  const isCanceled = receipt.is_canceled === true;

  if (hasProcessingHistory && isCanceled) {
    return {
      ...previewClassification,
      operationType: "needs_check" as const,
      canExecute: false,
      blockingReasons: [...blockingReasons, "canceled_after_applied"],
    };
  }

  const modifiedAfterLegacyApply =
    history.lastProcessedFingerprint === null &&
    receipt.is_modified === true &&
    isAfter(receipt.updated_at, history.lastProcessedAt);
  const modifiedAfterFingerprintApply =
    history.lastProcessedFingerprint !== null &&
    history.lastProcessedFingerprint !== currentFingerprint;
  const needsReprocess =
    hasProcessingHistory &&
    !history.hasSuccessfulCurrentFingerprint &&
    (modifiedAfterLegacyApply || modifiedAfterFingerprintApply) &&
    (hasActiveDeduction || previewClassification.actionableLineCount > 0);

  if (needsReprocess) {
    if (blockingReasons.length > 0) {
      return {
        ...previewClassification,
        operationType: "needs_check" as const,
        canExecute: false,
        blockingReasons,
      };
    }
    return {
      ...previewClassification,
      operationType: "reprocess_modified" as const,
      canExecute: true,
      blockingReasons,
    };
  }

  const isManualInitialCandidate =
    receipt.source === "manual" &&
    receipt.payment_status === 3 &&
    !isCanceled &&
    !hasProcessingHistory;

  if (isManualInitialCandidate) {
    if (blockingReasons.length > 0) {
      return {
        ...previewClassification,
        operationType: "needs_check" as const,
        canExecute: false,
        blockingReasons,
      };
    }
    if (previewClassification.actionableLineCount > 0) {
      return {
        ...previewClassification,
        operationType: "initial_apply" as const,
        canExecute: true,
        blockingReasons,
      };
    }
  }

  return {
    ...previewClassification,
    operationType: "no_op" as const,
    canExecute: false,
    blockingReasons,
  };
}

export async function buildUnifiedInventoryDeductionPreview(input: {
  businessDateFrom: string;
  businessDateTo: string;
  receiptIds?: number[];
}) {
  if (!isBusinessDate(input.businessDateFrom) || !isBusinessDate(input.businessDateTo)) {
    throw new Error("businessDateFrom and businessDateTo must use YYYY-MM-DD format.");
  }
  if (input.businessDateFrom > input.businessDateTo) {
    throw new Error("businessDateFrom cannot be later than businessDateTo.");
  }

  const receiptIds = Array.from(new Set(input.receiptIds ?? []));
  const receipts = await fetchReceipts({
    businessDateFrom: input.businessDateFrom,
    businessDateTo: input.businessDateTo,
    receiptIds,
  });
  const fetchedReceiptIds = receipts.map((receipt) => Number(receipt.id));
  const previewPromise =
    fetchedReceiptIds.length > 0
      ? buildInventoryDeductionPreview({
          businessDateFrom: input.businessDateFrom,
          businessDateTo: input.businessDateTo,
          receiptIds: fetchedReceiptIds,
        })
      : Promise.resolve({ receipts: [] } as unknown as InventoryDeductionPreview);
  const [lines, preview, deductions, deductionReceipts] = await Promise.all([
    fetchLines(fetchedReceiptIds),
    previewPromise,
    fetchDeductions(fetchedReceiptIds),
    fetchDeductionReceipts(fetchedReceiptIds),
  ]);

  const linesByReceiptId = new Map<number, LineRow[]>();
  for (const line of lines) {
    if (line.receipt_id == null) continue;
    const grouped = linesByReceiptId.get(line.receipt_id) ?? [];
    grouped.push(line);
    linesByReceiptId.set(line.receipt_id, grouped);
  }
  const previewReceiptById = new Map(
    preview.receipts.map((receipt) => [receipt.receiptId, receipt])
  );

  const resultReceipts = receipts.map((receipt) => {
    const currentFingerprint = getReceiptContentFingerprint({
      receiptId: Number(receipt.id),
      refId: receipt.ref_id,
      source: receipt.source,
      paymentStatus: receipt.payment_status,
      isCanceled: receipt.is_canceled,
      lines: linesByReceiptId.get(Number(receipt.id)) ?? [],
    });
    const history = resolveAppliedHistory(
      Number(receipt.id),
      deductions,
      deductionReceipts,
      currentFingerprint
    );
    const previewReceipt = previewReceiptById.get(Number(receipt.id)) ?? null;
    const classified = classifyReceipt({
      receipt,
      previewReceipt,
      currentFingerprint,
      history,
    });

    return {
      operationType: classified.operationType,
      receiptId: Number(receipt.id),
      source: receipt.source,
      refNo: receipt.ref_no,
      currentFingerprint,
      lastProcessedFingerprint: history.lastProcessedFingerprint,
      activeDeductionCount: history.activeAppliedDeductionCount,
      activeDeductionIds: history.activeAppliedDeductionIds,
      actionableLineCount: classified.actionableLineCount,
      neutralLineCount: classified.neutralLineCount,
      blockingReasons: classified.blockingReasons,
      rawPreviewStatus: previewReceipt?.status ?? null,
      canExecute: classified.canExecute,
      isLegacyApplied: history.isLegacyApplied,
      inventoryAffectingHash: previewReceipt?.inventoryAffectingHash ?? null,
      updatedAt: receipt.updated_at,
    };
  });

  const summary = resultReceipts.reduce(
    (counts, receipt) => {
      counts.totalReceiptCount += 1;
      if (receipt.operationType === "initial_apply") counts.initialApplyCount += 1;
      if (receipt.operationType === "reprocess_modified") {
        counts.reprocessModifiedCount += 1;
      }
      if (receipt.operationType === "needs_check") counts.needsCheckCount += 1;
      if (receipt.operationType === "no_op") counts.noOpCount += 1;
      if (receipt.canExecute) counts.executableCount += 1;
      return counts;
    },
    {
      totalReceiptCount: 0,
      initialApplyCount: 0,
      reprocessModifiedCount: 0,
      needsCheckCount: 0,
      noOpCount: 0,
      executableCount: 0,
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    businessDateFrom: input.businessDateFrom,
    businessDateTo: input.businessDateTo,
    summary,
    receipts: resultReceipts,
  } satisfies UnifiedInventoryDeductionPreview;
}
