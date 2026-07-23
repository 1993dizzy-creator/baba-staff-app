"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";
import { fetchSalesApi } from "@/lib/sales/client-auth";
import { commonText, salesText } from "@/lib/text";

const salesTabs = [
  { href: "/admin/sales", key: "daily" },
  { href: "/admin/sales/receipts", key: "receipts" },
  { href: "/admin/sales/monthly", key: "monthly" },
] as const;

const manualReceiptTableNameOptions = [
  ...Array.from({ length: 18 }, (_, index) => String(index + 1)),
  ...Array.from({ length: 11 }, (_, index) => `BAR${index + 1}`),
];

type SalesReceiptsText =
  (typeof salesText)[keyof typeof salesText]["receipts"];
type SalesReceiptsEditText =
  (typeof salesText)[keyof typeof salesText]["receiptsEdit"];
type SalesCommonText = (typeof salesText)[keyof typeof salesText]["common"];
type CommonText = (typeof commonText)[keyof typeof commonText];
type SalesReceiptsViewText = SalesCommonText &
  SalesReceiptsText &
  Pick<
    CommonText,
    | "quantity"
    | "total"
    | "loading"
    | "error"
    | "loadFailed"
    | "noSearchResult"
    | "cash"
    | "transfer"
    | "card"
    | "paymentMethod"
    | "vat"
    | "totalTax"
    | "receivedAmount"
    | "changeAmount"
    | "paid"
    | "paymentPending"
    | "canceled"
    | "status"
    | "modified"
    | "table"
  > & {
    other: CommonText["etc"];
  };
type SalesReceiptsEditViewText = SalesCommonText &
  SalesReceiptsEditText &
  Pick<
    CommonText,
    | "quantity"
    | "delete"
    | "save"
    | "saving"
    | "cancel"
    | "reset"
    | "searchLoading"
    | "noSearchResult"
    | "cash"
    | "transfer"
    | "card"
    | "paymentMethod"
    | "vat"
    | "receivedAmount"
    | "changeAmount"
    | "manage"
    | "restore"
    | "add"
    | "productName"
    | "unitPrice"
    | "taxRate"
    | "taxAmount"
  > & {
    other: CommonText["etc"];
  };

type SalesReceiptsResponse = {
  ok: boolean;
  businessDate?: string;
  error?: string;
  receipts?: ReceiptItem[];
};

type ReceiptItem = {
  id: number;
  refId: string;
  refNo: string | null;
  refDate: string | null;
  tableName?: string | null;
  paymentStatus: number | null;
  isCanceled: boolean;
  totalAmount: number;
  finalAmount: number;
  isModified: boolean;
  reviewStatus: string | null;
  adminNote: string | null;
  lineCount: number;
  optionLineCount: number;
  payments?: ReceiptPayment[];
};

type ReceiptPayment = {
  paymentName: string | null;
  cardName: string | null;
  amount: number;
};

type ReceiptDetailResponse = {
  ok: boolean;
  error?: string;
  hasOptionLines?: boolean;
  receipt?: ReceiptDetail;
  payments?: PaymentDetail[];
  taxSummary?: TaxSummary;
  adjustedTaxSummary?: TaxSummary;
  lines?: LineDetail[];
};

type AmountSummarySnapshot = {
  totalAmount: number;
  vatAmount: number;
  finalAmount: number;
  paymentTotalAmount: number;
};

type ReceiptDetail = {
  id: number;
  refId: string;
  refNo: string | null;
  businessDate: string;
  refDate: string | null;
  paymentStatus: number | null;
  isCanceled: boolean;
  totalAmount: number;
  discountAmount: number;
  vatAmount: number;
  finalAmount: number;
  receiveAmount: number | null;
  returnAmount: number | null;
  customerName: string | null;
  tableName: string | null;
  isModified: boolean;
  modifiedAt: string | null;
  modifiedBy: string | null;
  modificationNote: string | null;
  reviewStatus: string | null;
  adminNote: string | null;
  originalAmountSummary: AmountSummarySnapshot | null;
  taxOverrideMode: "apply" | "exclude_all" | null;
  calculatedVatAmount: number | null;
  calculatedFinalAmount: number | null;
  finalAmountOverride: number | null;
  revision: number;
};

type PaymentDetail = {
  id: number;
  paymentType: number | null;
  paymentName: string | null;
  cardName: string | null;
  amount: number;
};

type TaxSummary = {
  totalTaxAmount: number;
  taxSavingAmount?: number;
  amountDifferenceAmount?: number;
  taxByRate: {
    taxRate: number;
    taxAmount: number;
    lineCount: number;
  }[];
};

type LineDetail = {
  id: number;
  refDetailId: string | null;
  parentRefDetailId: string | null;
  sortOrder: number | null;
  itemCode: string | null;
  itemName: string | null;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  discountAmount: number;
  finalAmount: number;
  taxRate: number;
  taxAmount: number;
  preTaxAmount: number;
  taxReductionAmount: number;
  refDetailType: number | null;
  inventoryItemType: number | null;
  isOption: boolean;
  mappingStatus: string | null;
  isExcluded: boolean;
  adminNote: string | null;
};

type ReceiptPatchResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  error?: string;
  receipt?: {
    id: number;
    totalAmount: number;
    finalAmount: number;
    receiveAmount: number | null;
    returnAmount: number | null;
    isModified: boolean;
    modifiedAt: string | null;
    modifiedBy: string | null;
    modificationNote: string | null;
    vatAmount: number;
    calculatedVatAmount: number;
    calculatedFinalAmount: number;
    finalAmountOverride: number | null;
    taxOverrideMode: "apply" | "exclude_all";
    revision: number;
  };
};

type SaveReceiptEditInput = {
  receiptId: number;
  lines: ReceiptEditLine[];
  paymentMethod: PaymentMethod;
  cashReceivedAmount: number | null;
  note: string;
  taxOverrideMode: "apply" | "exclude_all";
  finalAmountOverride: number | null;
  expectedRevision: number;
  requestId: string;
};

type PaymentMethod = "cash" | "other";

type ReceiptEditLine =
  | {
    id: number;
    mode: "update" | "delete";
    quantity?: number;
  }
  | {
    mode: "create";
    clientId: string;
    parentClientId: string | null;
    productId: number | null;
    itemCode: string | null;
    itemName: string;
    unitName: string | null;
    unitPrice: number;
    quantity: number;
    taxRate: number | null;
    taxRateSource: string | null;
    isOption: boolean;
    refDetailType: number;
    inventoryItemType: number | null;
    additionId: string | null;
    optionGroupName: string | null;
    rawJson: Record<string, unknown> | null;
  };

type ReceiptDraftLine = {
  id: number;
  refDetailId: string | null;
  itemName: string;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  finalAmount: number;
  taxRate: number;
  mode: "update" | "delete";
};

type NewDraftLine = {
  mode: "create";
  clientId: string;
  parentClientId: string | null;
  productId: number | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  unitPrice: number;
  quantity: number;
  taxRate: number | null;
  taxRateSource: string | null;
  isOption: boolean;
  refDetailType: number;
  inventoryItemType: number | null;
  additionId: string | null;
  optionGroupName: string | null;
  rawJson: Record<string, unknown> | null;
};

type PosProductOption = {
  id: string;
  name: string;
  code: string | null;
  unitPrice: number;
  taxRate: number | null;
  raw: Record<string, unknown>;
};

type PosProductOptionGroup = {
  id: string;
  name: string;
  type: "addition" | "child";
  options: PosProductOption[];
};

type PosProduct = {
  id: number;
  source: string;
  branchId?: string | null;
  posItemId?: string | null;
  itemId: string | null;
  itemCode: string | null;
  itemName: string;
  itemNameVi?: string | null;
  categoryName?: string | null;
  unitName: string | null;
  unitPrice: number;
  priceIncludesVat?: boolean | null;
  taxRate?: number | null;
  taxName?: string | null;
  taxRateSource?: string | null;
  taxRateUpdatedAt?: string | null;
  itemType?: number | null;
  isActive: boolean;
  optionGroups?: PosProductOptionGroup[];
};

type PosProductsResponse = {
  ok: boolean;
  error?: string;
  products?: PosProduct[];
};

function isExistingOptionLine(
  line: LineDetail,
  receiptLineRefDetailIds: Set<string>
) {
  return Boolean(
    line.parentRefDetailId &&
      receiptLineRefDetailIds.has(line.parentRefDetailId)
  );
}

function getReceiptLineRefDetailIds(lines: LineDetail[]) {
  return new Set(
    lines
      .map((line) => line.refDetailId)
      .filter((id): id is string => Boolean(id))
  );
}

function getLineDisplayName(
  line: Pick<LineDetail, "itemName" | "mappingStatus">,
  text: Pick<SalesReceiptsViewText, "manualAdjustmentLineName">
) {
  if (line.mappingStatus === "manual_adjustment") {
    return text.manualAdjustmentLineName;
  }
  return line.itemName || "-";
}

type PosProductsSyncResponse = {
  ok: boolean;
  error?: string;
  result?: {
    totalFromApi?: number;
    fetchedCount?: number;
    detailRequestedCount?: number;
    detailFailedCount?: number;
    failedDetails?: unknown[];
    insertedCount?: number;
    updatedCount?: number;
    upsertedCount?: number;
    skippedCount?: number;
    taxInfoStatus?: string;
  };
};

type ManualDraftLine = {
  clientId: string;
  parentClientId?: string | null;
  productId: number | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxRate: number | null;
  isOption?: boolean;
  refDetailType?: number;
  inventoryItemType?: number | null;
  additionId?: string | null;
  optionGroupName?: string | null;
  rawJson?: Record<string, unknown> | null;
};

type CreateManualReceiptInput = {
  businessDate: string;
  saleTime: string;
  tableName: string;
  note: string;
  vatEnabled: boolean;
  paymentMethod: "cash" | "other";
  cashReceivedAmount: number;
  manualFinalAmount?: number;
  lines: ManualDraftLine[];
};

type ManualReceiptCreateResponse = {
  ok: boolean;
  error?: string;
  receipt?: { id: number; refId: string; refNo: string; businessDate: string; finalAmount: number };
};

type InventoryPreviewStatus =
  | "ready"
  | "skipped"
  | "missing_mapping"
  | "manual_review"
  | "invalid_mapping"
  | "incomplete_recipe"
  | "insufficient_stock"
  | "already_applied"
  | "applied_after_modified"
  | "review_required";

type InventoryDeductionPreview = {
  generatedAt: string;
  validationSummary: {
    readyForPreview: boolean;
    errorCount: number;
    warningCount: number;
  };
  summary: {
    totalReceiptCount: number;
    readyCount: number;
    partialReadyCount?: number;
    blockedCount: number;
    skippedCount: number;
    missingMappingCount: number;
    manualReviewCount: number;
    invalidMappingCount: number;
    incompleteRecipeCount: number;
    incompleteRecipeLineCount?: number;
    insufficientStockCount: number;
    alreadyAppliedCount: number;
    appliedAfterModifiedCount?: number;
    reviewRequiredCount: number;
    canApply: boolean;
  };
  inventoryTotals: Array<{
    inventoryItemId: number;
    inventoryItemName: string;
    inventoryCode: string | null;
    inventoryUnit: string | null;
    currentQuantity: number;
    deductQuantity: number;
    afterQuantity: number;
    receiptCount: number;
    lineCount: number;
    status: "ok" | "insufficient_stock";
  }>;
  kegTrackingSummary?: {
    products: Array<{
      posProductId: number;
      posItemCode: string | null;
      posItemName: string | null;
      inventoryItemId: number;
      inventoryItemName: string;
      inventoryCode: string | null;
      quantitySold: number;
      quantityPerPosUnit: number;
      expectedUsageMl: number;
      receiptCount: number;
      lineCount: number;
    }>;
    inventoryTotals: Array<{
      inventoryItemId: number;
      inventoryItemName: string;
      inventoryCode: string | null;
      expectedUsageMl: number;
      productCount: number;
      receiptCount: number;
      lineCount: number;
    }>;
  };
  receipts: Array<{
    receiptId: number;
    refNo: string | null;
    refDate: string | null;
    status: InventoryPreviewStatus;
    blocked: boolean;
    blockedReasons: string[];
    inventoryAffectingHash: string;
    amountHash: string;
    lines: Array<{
      receiptLineId: number;
      refDetailId: string | null;
      parentRefDetailId: string | null;
      isOption: boolean;
      lineType: string;
      itemName: string | null;
      posItemCode?: string | null;
      quantitySold: number;
      mappingSnapshot?: Record<string, unknown> | null;
      isKegTracked?: boolean;
      status: string;
      isApplied?: boolean;
      blockedReason: string | null;
      deductions: Array<{
        inventoryItemId: number;
        inventoryItemName: string;
        deductQuantity: number;
        currentQuantity: number;
        afterQuantity: number;
        status: "ok" | "insufficient_stock";
      }>;
    }>;
  }>;
};

type InventoryPreviewResponse = {
  ok: boolean;
  error?: string;
  preview?: InventoryDeductionPreview;
  batch?: {
    batchId: number;
    savedReceiptCount: number;
    savedCandidateCount: number;
  } | null;
};

type BatchApplyResult = {
  batchId: number;
  status: "applied" | "partially_applied";
  summary: {
    appliedReceiptCount: number;
    appliedDeductionCount: number;
    inventoryLogCount: number;
  };
  inventoryTotals: Array<{
    inventoryItemId: number;
    itemName: string | null;
    previousQuantity: number;
    deductQuantity: number;
    newQuantity: number;
  }>;
  receipts: Array<{
    receiptId: number;
    receiptRefNo: string | null;
    status: "applied";
  }>;
};

type UnifiedOperationType =
  | "initial_apply"
  | "reprocess_modified"
  | "rollback_canceled"
  | "needs_check"
  | "no_op";

type UnifiedExecuteResultCode =
  | "applied"
  | "already_processed"
  | "stale_preview"
  | "needs_check"
  | "no_op"
  | "failed"
  | "not_supported";

type UnifiedPreviewReceipt = {
  operationType: UnifiedOperationType;
  receiptId: number;
  source: string | null;
  refNo: string | null;
  currentFingerprint: string;
  lastProcessedFingerprint: string | null;
  activeDeductionCount: number;
  activeDeductionIds?: number[];
  actionableLineCount: number;
  actionableSalesLines: Array<{
    receiptLineId: number;
    posItemCode: string | null;
    itemName: string | null;
    quantitySold: number;
  }>;
  neutralLineCount: number;
  blockingReasons: string[];
  rawPreviewStatus: string | null;
  canExecute: boolean;
  isLegacyApplied: boolean;
  inventoryAffectingHash: string | null;
  updatedAt: string | null;
};

type UnifiedPreview = {
  generatedAt: string;
  businessDateFrom: string;
  businessDateTo: string;
  summary: {
    totalReceiptCount: number;
    initialApplyCount: number;
    reprocessModifiedCount: number;
    rollbackCanceledCount: number;
    needsCheckCount: number;
    noOpCount: number;
    executableCount: number;
  };
  receipts: UnifiedPreviewReceipt[];
};

type UnifiedPreviewResponse = {
  ok: boolean;
  error?: string;
  preview?: UnifiedPreview;
};

type UnifiedExecuteResult = {
  receiptId: number;
  expectedOperationType: UnifiedOperationType;
  actualOperationType: UnifiedOperationType | null;
  result: UnifiedExecuteResultCode;
  fingerprint: string | null;
  batchId: number | null;
  deductionReceiptId: number | null;
  reversedDeductionCount: number;
  appliedDeductionCount: number;
  rollbackOnly: boolean;
  failureReason: string | null;
  durationMs: number;
};

type UnifiedExecuteResponse = {
  success: boolean;
  error?: string;
  executionId?: string;
  summary?: {
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
  results?: UnifiedExecuteResult[];
  processedReceiptIds?: number[];
  staleReceiptIds?: number[];
  needsCheckReceiptIds?: number[];
  shouldRefreshPreview?: boolean;
};

type AppLanguage = keyof typeof salesText;

const inventoryPreviewText = {
  ko: {
    previewButton: "재고차감 처리",
    previewLoading: "미리보기 계산 중...",
    previewFailed: "재고 차감 미리보기를 생성하지 못했습니다.",
    title: "판매 재고차감 미리보기",
    description:
      "아직 재고는 차감되지 않았습니다. 선택한 영수증은 차감 확정 시 최신 기준으로 다시 계산됩니다.",
    mappingReady: "매핑 확인 완료",
    mappingNeedsCheck: "매핑 확인 필요",
    mappingTooltip:
      "Direct/Recipe/Manual/Ignore 설정과 Recipe 재료 상태를 확인합니다. 미완성 Recipe는 차감 대상에서 제외되고, Direct 상품은 차감 가능합니다.",
    applyTitle: "선택 영수증 차감 확정",
    selected: "선택",
    expectedItems: "예상 차감 품목",
    applyProcessing: "차감 처리 중...",
    applyDone: "차감 확정 완료",
    applyButton: "차감 확정",
    ownerMasterOnly: "Owner/Master 전용",
    applyConfirm:
      "선택한 영수증의 재고를 실제로 차감합니다. 계속하시겠습니까?",
    applyConfirmDetailed:
      "선택된 영수증 {receiptCount}건의 차감 가능한 항목 {itemCount}개를 재고에서 차감합니다. 확인필요/차감불가/차감완료 항목은 제외됩니다. 계속하시겠습니까?",
    applyFailed: "판매 재고차감을 확정하지 못했습니다.",
    receipt: "영수증",
    deduction: "차감",
    log: "로그",
    countSuffix: "건",
    unified: {
      executeButton: "처리 가능한 {count}건 실행",
      processing: "처리 중...",
      resultTitle: "재고차감 처리 결과",
      executable: "처리 가능",
      initialApply: "신규 차감",
      reprocessModified: "수정 재처리",
      rollbackCanceled: "취소 차감 복구",
      needsCheck: "확인 필요",
      noOp: "처리 대상 없음",
      restoreAndReapply: "복구 후 재차감",
      restoreOnly: "기존 차감 복구",
      reapplyOnly: "현재 내용 재차감",
      activeDeduction: "기존 차감",
      actionableLine: "처리 라인",
      actionableItems: "차감 가능",
      neutralLine: "제외 라인",
      resultApplied: "처리 완료",
      resultAlreadyProcessed: "이미 처리됨",
      resultStale: "정보가 변경됨",
      resultNeedsCheck: "확인 필요",
      resultNoOp: "처리 대상 없음",
      resultNotSupported: "현재 처리 불가",
      resultFailed: "처리 실패",
      initialAppliedDone: "신규 차감 완료",
      reprocessedDone: "수정 재처리 완료",
      alreadyProcessedDone: "이미 처리됨",
      staleDone: "다시 확인 필요",
      failedDone: "실패",
      noExecutable: "처리 가능한 영수증이 없습니다.",
      limitExceeded: "처리 가능 영수증이 30건을 초과했습니다.",
      retryPreview: "다시 조회",
      details: "상세",
      failureReasons: {
        fingerprint_changed: "영수증 내용이 변경되었습니다",
        inventory_plan_changed: "재고차감 계획이 변경되었습니다",
        inventory_affecting_hash_changed: "재고차감 계획이 변경되었습니다",
        receipt_updated: "영수증이 다시 수정되었습니다",
        receipt_updated_at_changed: "영수증이 다시 수정되었습니다",
        receipt_processing_paused:
          "영수증 수정이 완료되지 않아 자동 차감이 중지되었습니다",
        admin_edit_failed:
          "영수증 수정 저장이 실패했습니다. 내용을 확인한 뒤 다시 저장하세요",
        stale_admin_edit:
          "중단된 영수증 수정이 감지되었습니다. 내용을 확인한 뒤 다시 저장하세요",
        operation_changed: "처리 유형이 변경되었습니다",
        blocking_status: "확인이 필요한 품목이 있습니다",
        insufficient_stock_after_reversal: "재처리 후 재고가 부족합니다",
        legacy_metadata_missing: "과거 차감 정보가 부족합니다",
        canceled_without_active_deduction:
          "취소됐지만 복구할 활성 차감 이력을 찾을 수 없습니다",
        no_inventory_movement: "변경할 재고가 없습니다",
        apply_failed: "신규 차감 처리에 실패했습니다",
        reprocess_failed: "수정 영수증 재처리에 실패했습니다",
        automatic_cron_candidate: "자동 차감 대상입니다",
      },
    },
    itemSuffix: "개",
    total: "전체",
    canApply: "차감가능",
    needsCheck: "확인필요",
    details: "상세보기",
    needsCheckDetails: "확인필요 상세",
    inventoryTotals: "재고품목별 예상합계",
    kegTrackingItems: "Keg 추적 품목",
    expectedUsage: "예상 사용량",
    actualDeductionExcluded: "실제 차감 제외",
    kegTrackingOnly: "Keg 잔량 추적만",
    kegTrackingTotal: "합계",
    current: "현재",
    expectedDeduction: "예상 차감",
    afterDeduction: "차감 후",
    line: "라인",
    noDeductionItems: "차감 대상 품목이 없습니다.",
    receiptResults: "영수증별 결과",
    availableCount: "차감가능",
    checkCount: "확인필요",
    saleQuantity: "판매",
    option: "옵션",
    configureRecipe: "재료 설정 후 자동 차감 가능",
    configureMapping: "POS 상품 매핑을 먼저 설정해주세요",
    manualReviewHelp: "운영 기준 확인 후 매핑 방식을 결정해주세요",
    invalidMappingHelp: "POS 상품 연결 상태를 확인해주세요",
    insufficientStockHelp: "재고 수량을 확인한 뒤 다시 진행해주세요",
    ignoredHelp: "차감 대상에서 제외된 항목입니다",
    combo: "Combo / 묶음상품",
    comboItems: "구성 상품",
    comboDeduction: "구성 상품 기준 차감",
    comboMappingNeedsCheck: "구성 상품 매핑 확인 필요",
    comboNestedUnsupported: "Combo 안에 Combo는 지원하지 않습니다",
    alreadyAppliedHelp: "재고 차감이 완료된 영수증입니다",
    modifiedAfterApplyHelp: "차감 후 수정되어 별도 확인이 필요합니다",
    genericCheckHelp: "내용 확인 후 처리해주세요",
    lineStatusGroup: {
      ready: "차감가능",
      mappingRequired: "매핑 필요",
      operationReview: "운영 확인 필요",
      incompleteRecipe: "레시피 미완성",
      excluded: "차감 제외",
      insufficientStock: "재고 부족",
      alreadyApplied: "차감완료",
      kegTracked: "케그 집계완료",
    },
    lineStatusHelp: {
      ready: "재고 차감 대상입니다.",
      mappingRequired: "재고 품목과 연결이 필요합니다.",
      operationReview: "운영 기준 확인 후 매핑 방식을 결정해주세요.",
      incompleteRecipe: "레시피 재료 설정 후 자동 차감할 수 있습니다.",
      excluded: "차감 제외로 설정된 상품입니다.",
      insufficientStock: "현재 재고가 부족합니다.",
      alreadyApplied: "판매차감이 완료된 항목입니다.",
      kegTracked: "Keg 판매량과 잔량 집계에 반영되는 항목입니다.",
    },
    partialNotice:
      "Recipe 미완성 라인은 차감 대상에서 제외됩니다. Direct 매핑 상품과 완성 Recipe 상품은 계속 차감 가능합니다.",
    selectionNoticeReady:
      "선택된 영수증의 차감 가능한 항목만 재고에서 차감됩니다.",
    selectionNoticeEmpty: "차감할 영수증을 선택해주세요.",
    selectionNoticeNeedsCheck:
      "확인필요 항목은 매핑/운영 기준 정리 후 차감할 수 있습니다.",
    selectionNoticeAlreadyApplied:
      "차감완료 영수증은 중복 차감되지 않습니다.",
    selectionNoticeApplicableOnly: "차감 가능한 항목만 확정됩니다.",
    selectionNoticeExcluded: "는 차감 확정 대상에서 제외됩니다.",
    selectionStatusSelectable: "선택 가능",
    selectionStatusNeedsCheck: "확인필요",
    selectionStatusAlreadyApplied: "차감완료",
    selectionStatusBlocked: "차감 불가",
    status: {
      ready: "차감가능",
      partial: "일부 가능",
      needsCheck: "확인필요",
      skipped: "차감 불필요",
      alreadyApplied: "차감완료",
      modified: "재처리 필요",
    },
    lineType: {
      direct: "직접 차감",
      recipe: "Recipe 차감",
      option_direct: "옵션 기준 차감",
      option_recipe: "옵션 Recipe 차감",
      combo_direct: "Combo 구성 직접 차감",
      combo_recipe: "Combo 구성 Recipe 차감",
      combo_ignore: "Combo 구성 제외",
      combo_incomplete_recipe: "Recipe 미완성 제외",
      combo_missing_mapping: "구성 상품 매핑 확인 필요",
      combo_invalid_mapping: "구성 상품 매핑 확인 필요",
      incomplete_recipe: "Recipe 미완성 제외",
      manual: "확인 필요",
      manual_review: "확인 필요",
      ignore: "차감 제외",
      missing_mapping: "매핑 확인 필요",
      invalid_mapping: "매핑 확인 필요",
      insufficient_stock: "재고 부족",
    },
    detailStatus: {
      missingMapping: "매핑 확인 필요",
      incompleteRecipe: "Recipe 미완성 제외",
      modified: "차감 후 수정됨",
      insufficientStock: "재고 부족",
      manualReview: "운영 확인 필요",
      alreadyApplied: "차감완료",
      skipped: "차감 불필요",
      invalidMapping: "매핑 확인 필요",
      reviewRequired: "영수증 확인 필요",
    },
  },
  vi: {
    previewButton: "Xử lý trừ tồn kho",
    previewLoading: "Đang tính xem trước...",
    previewFailed: "Không tạo được bản xem trước trừ kho.",
    title: "Xem trước trừ kho bán hàng",
    description:
      "Kho chưa bị trừ. Các hóa đơn đã chọn sẽ được tính lại theo dữ liệu mới nhất khi xác nhận.",
    mappingReady: "Đã kiểm tra liên kết",
    mappingNeedsCheck: "Cần kiểm tra liên kết",
    mappingTooltip:
      "Kiểm tra thiết lập Direct/Recipe/Manual/Ignore và nguyên liệu Recipe. Recipe chưa hoàn thiện sẽ bị loại, món Direct vẫn có thể trừ kho.",
    applyTitle: "Xác nhận trừ kho hóa đơn đã chọn",
    selected: "Đã chọn",
    expectedItems: "Mặt hàng dự kiến trừ",
    applyProcessing: "Đang trừ kho...",
    applyDone: "Đã xác nhận trừ kho",
    applyButton: "Xác nhận trừ kho",
    ownerMasterOnly: "Chỉ Owner/Master",
    applyConfirm: "Sẽ trừ kho thực tế cho hóa đơn đã chọn. Tiếp tục?",
    applyConfirmDetailed:
      "Sẽ trừ {itemCount} mục có thể trừ kho trong {receiptCount} hóa đơn đã chọn. Mục cần kiểm tra/không thể trừ/đã trừ sẽ bị loại. Tiếp tục?",
    applyFailed: "Không xác nhận được trừ kho bán hàng.",
    receipt: "Hóa đơn",
    deduction: "Trừ kho",
    log: "Nhật ký",
    countSuffix: " mục",
    unified: {
      executeButton: "Chạy {count} mục có thể xử lý",
      processing: "Đang xử lý...",
      resultTitle: "Kết quả xử lý trừ tồn kho",
      executable: "Có thể xử lý",
      initialApply: "Trừ tồn kho mới",
      reprocessModified: "Xử lý lại sau chỉnh sửa",
      rollbackCanceled: "Hoàn tồn kho hóa đơn hủy",
      needsCheck: "Cần kiểm tra",
      noOp: "Không cần xử lý",
      restoreAndReapply: "Hoàn lại rồi trừ lại",
      restoreOnly: "Hoàn lại lần trừ cũ",
      reapplyOnly: "Trừ lại theo nội dung hiện tại",
      activeDeduction: "Đã trừ trước",
      actionableLine: "Dòng xử lý",
      actionableItems: "Có thể trừ",
      neutralLine: "Dòng bỏ qua",
      resultApplied: "Đã xử lý",
      resultAlreadyProcessed: "Đã xử lý trước đó",
      resultStale: "Thông tin đã thay đổi",
      resultNeedsCheck: "Cần kiểm tra",
      resultNoOp: "Không cần xử lý",
      resultNotSupported: "Chưa hỗ trợ xử lý",
      resultFailed: "Xử lý thất bại",
      initialAppliedDone: "Đã trừ mới",
      reprocessedDone: "Đã xử lý lại",
      alreadyProcessedDone: "Đã xử lý trước đó",
      staleDone: "Cần kiểm tra lại",
      failedDone: "Thất bại",
      noExecutable: "Không có hóa đơn có thể xử lý.",
      limitExceeded: "Số hóa đơn có thể xử lý vượt quá 30 mục.",
      retryPreview: "Tải lại",
      details: "Chi tiết",
      failureReasons: {
        fingerprint_changed: "Nội dung hóa đơn đã thay đổi",
        inventory_plan_changed: "Kế hoạch trừ kho đã thay đổi",
        inventory_affecting_hash_changed: "Kế hoạch trừ kho đã thay đổi",
        receipt_updated: "Hóa đơn đã được chỉnh sửa lại",
        receipt_updated_at_changed: "Hóa đơn đã được chỉnh sửa lại",
        receipt_processing_paused:
          "Chỉnh sửa hóa đơn chưa hoàn tất nên đã tạm dừng trừ kho tự động",
        admin_edit_failed:
          "Lưu chỉnh sửa hóa đơn thất bại. Hãy kiểm tra và lưu lại",
        stale_admin_edit:
          "Phát hiện chỉnh sửa hóa đơn bị gián đoạn. Hãy kiểm tra và lưu lại",
        operation_changed: "Loại xử lý đã thay đổi",
        blocking_status: "Có món cần kiểm tra",
        insufficient_stock_after_reversal: "Không đủ tồn kho sau khi xử lý lại",
        legacy_metadata_missing: "Thiếu dữ liệu trừ kho cũ",
        canceled_without_active_deduction:
          "Không tìm thấy lịch sử trừ kho đang hoạt động để hoàn lại",
        no_inventory_movement: "Không có tồn kho cần thay đổi",
        apply_failed: "Xử lý trừ mới thất bại",
        reprocess_failed: "Xử lý lại hóa đơn đã chỉnh sửa thất bại",
        automatic_cron_candidate: "Hóa đơn do hệ thống tự động xử lý",
      },
    },
    itemSuffix: " món",
    total: "Tổng",
    canApply: "Có thể trừ kho",
    needsCheck: "Cần kiểm tra",
    details: "Chi tiết",
    needsCheckDetails: "Chi tiết cần kiểm tra",
    inventoryTotals: "Tổng dự kiến theo hàng tồn",
    kegTrackingItems: "Mục theo dõi Keg",
    expectedUsage: "Lượng dùng dự kiến",
    actualDeductionExcluded: "Không trừ tồn",
    kegTrackingOnly: "Chỉ theo dõi Keg",
    kegTrackingTotal: "Tổng",
    current: "Hiện tại",
    expectedDeduction: "Dự kiến trừ",
    afterDeduction: "Sau khi trừ",
    line: "Dòng",
    noDeductionItems: "Không có mặt hàng cần trừ kho.",
    receiptResults: "Kết quả theo hóa đơn",
    availableCount: "Có thể trừ",
    checkCount: "Cần kiểm tra",
    saleQuantity: "Bán",
    option: "Tùy chọn",
    configureRecipe: "Có thể tự động trừ sau khi thiết lập nguyên liệu",
    configureMapping: "Vui lòng thiết lập liên kết POS trước",
    manualReviewHelp: "Kiểm tra nghiệp vụ rồi chọn cách liên kết",
    invalidMappingHelp: "Vui lòng kiểm tra liên kết sản phẩm POS",
    insufficientStockHelp: "Kiểm tra số lượng tồn rồi thử lại",
    ignoredHelp: "Mục này được loại khỏi danh sách trừ kho",
    combo: "Combo / Món combo",
    comboItems: "Món trong combo",
    comboDeduction: "Trừ kho theo món trong combo",
    comboMappingNeedsCheck: "Cần kiểm tra liên kết món trong combo",
    comboNestedUnsupported: "Chưa hỗ trợ combo trong combo",
    alreadyAppliedHelp: "Hóa đơn này đã được trừ kho",
    modifiedAfterApplyHelp: "Hóa đơn đã sửa sau khi trừ kho, cần kiểm tra riêng",
    genericCheckHelp: "Vui lòng kiểm tra nội dung trước khi xử lý",
    lineStatusGroup: {
      ready: "Có thể trừ",
      mappingRequired: "Cần liên kết",
      operationReview: "Cần kiểm tra",
      incompleteRecipe: "Thiếu Recipe",
      excluded: "Loại khỏi trừ",
      insufficientStock: "Thiếu tồn kho",
      alreadyApplied: "Đã trừ kho",
      kegTracked: "Đã ghi nhận Keg",
    },
    lineStatusHelp: {
      ready: "Mục này có thể trừ kho.",
      mappingRequired: "Cần liên kết với hàng tồn kho.",
      operationReview: "Kiểm tra nghiệp vụ rồi chọn cách liên kết.",
      incompleteRecipe: "Có thể tự động trừ sau khi thiết lập nguyên liệu Recipe.",
      excluded: "Mục này được thiết lập loại khỏi trừ kho.",
      insufficientStock: "Số lượng tồn kho hiện không đủ.",
      alreadyApplied: "Mục này đã được áp dụng trừ kho.",
      kegTracked: "Mục này được ghi nhận vào theo dõi doanh số và tồn Keg.",
    },
    partialNotice:
      "Dòng Recipe chưa hoàn thiện sẽ bị loại khỏi trừ kho. Món Direct và Recipe hoàn chỉnh vẫn có thể trừ kho.",
    selectionNoticeReady:
      "Chỉ các mục có thể trừ trong hóa đơn đã chọn sẽ bị trừ kho.",
    selectionNoticeEmpty: "Vui lòng chọn hóa đơn cần trừ kho.",
    selectionNoticeNeedsCheck:
      "Mục cần kiểm tra có thể trừ sau khi hoàn tất liên kết/quy tắc vận hành.",
    selectionNoticeAlreadyApplied:
      "Hóa đơn đã trừ kho sẽ không bị trừ lặp lại.",
    selectionNoticeApplicableOnly: "Chỉ các mục có thể trừ kho sẽ được xác nhận.",
    selectionNoticeExcluded: " sẽ bị loại khỏi xác nhận trừ kho.",
    selectionStatusSelectable: "Có thể chọn",
    selectionStatusNeedsCheck: "Cần kiểm tra",
    selectionStatusAlreadyApplied: "Đã trừ kho",
    selectionStatusBlocked: "Không thể trừ",
    status: {
      ready: "Có thể trừ kho",
      partial: "Có thể trừ một phần",
      needsCheck: "Cần kiểm tra",
      skipped: "Không cần trừ",
      alreadyApplied: "Đã trừ kho",
      modified: "Cần xử lý lại",
    },
    lineType: {
      direct: "Trừ trực tiếp",
      recipe: "Trừ theo Recipe",
      option_direct: "Trừ theo tuỳ chọn",
      option_recipe: "Trừ Recipe theo tuỳ chọn",
      combo_direct: "Trừ trực tiếp món trong combo",
      combo_recipe: "Trừ Recipe món trong combo",
      combo_ignore: "Bỏ qua món trong combo",
      combo_incomplete_recipe: "Bỏ qua vì công thức chưa hoàn thiện",
      combo_missing_mapping: "Cần kiểm tra liên kết món trong combo",
      combo_invalid_mapping: "Cần kiểm tra liên kết món trong combo",
      incomplete_recipe: "Bỏ qua vì công thức chưa hoàn thiện",
      manual: "Cần kiểm tra",
      manual_review: "Cần kiểm tra",
      ignore: "Bỏ qua trừ kho",
      missing_mapping: "Cần kiểm tra liên kết",
      invalid_mapping: "Cần kiểm tra liên kết",
      insufficient_stock: "Không đủ tồn kho",
    },
    detailStatus: {
      missingMapping: "Cần kiểm tra liên kết",
      incompleteRecipe: "Bỏ qua vì công thức chưa hoàn thiện",
      modified: "Đã sửa sau khi trừ kho",
      insufficientStock: "Không đủ tồn kho",
      manualReview: "Cần kiểm tra vận hành",
      alreadyApplied: "Đã trừ kho",
      skipped: "Không cần trừ",
      invalidMapping: "Cần kiểm tra liên kết",
      reviewRequired: "Cần kiểm tra hóa đơn",
    },
  },
} satisfies Record<AppLanguage, unknown>;

type InventoryPreviewCopy = (typeof inventoryPreviewText)[AppLanguage];

function getInventoryTotalName(total: {
  inventoryItemName: string;
  inventoryCode: string | null;
}) {
  return total.inventoryCode
    ? `[${total.inventoryCode}] ${total.inventoryItemName}`
    : total.inventoryItemName;
}

function getPosSalesItemName(product: {
  posItemCode: string | null;
  posItemName: string | null;
}) {
  if (
    product.posItemCode &&
    product.posItemName?.startsWith(`[${product.posItemCode}]`)
  ) {
    return product.posItemName;
  }

  if (product.posItemCode && product.posItemName) {
    return `[${product.posItemCode}] ${product.posItemName}`;
  }
  return product.posItemName || product.posItemCode || "-";
}

function getKegTrackingProductName(product: {
  posItemCode: string | null;
  posItemName: string | null;
}) {
  return getPosSalesItemName(product);
}

function getActionableSalesLineLabel(line: {
  receiptLineId: number;
  posItemCode: string | null;
  itemName: string | null;
  quantitySold: number;
}) {
  return `${getPosSalesItemName({
    posItemCode: line.posItemCode,
    posItemName: line.itemName || `#${line.receiptLineId}`,
  })} ×${formatNumber(line.quantitySold)}`;
}

function formatKegUsageMl(value: number) {
  if (Math.abs(value) >= 1000) {
    const liters = value / 1000;
    return `${formatNumber(Number(liters.toFixed(2)))}L`;
  }
  return `${formatNumber(value)}ml`;
}

function hasIncompleteRecipeExclusions(
  receipt: InventoryDeductionPreview["receipts"][number]
) {
  return receipt.lines.some((line) => line.status === "incomplete_recipe");
}

function hasDeductionCandidates(
  receipt: InventoryDeductionPreview["receipts"][number]
) {
  return receipt.lines.some((line) => line.deductions.length > 0);
}

function isPartialDeductionReceipt(
  receipt: InventoryDeductionPreview["receipts"][number]
) {
  return (
    receipt.status === "ready" &&
    hasDeductionCandidates(receipt) &&
    hasIncompleteRecipeExclusions(receipt)
  );
}

function getIncompleteRecipeLineCount(
  receipts: InventoryDeductionPreview["receipts"] | null | undefined
) {
  return (receipts ?? []).reduce(
    (count, receipt) =>
      count +
      receipt.lines.filter((line) => line.status === "incomplete_recipe")
        .length,
    0
  );
}

function getInventoryPreviewStatusLabel(
  receipt: InventoryDeductionPreview["receipts"][number],
  text: InventoryPreviewCopy
) {
  if (isPartialDeductionReceipt(receipt)) return text.status.partial;
  if (receipt.status === "ready") return text.status.ready;
  if (receipt.status === "skipped") return text.status.skipped;
  if (receipt.status === "already_applied") return text.status.alreadyApplied;
  if (receipt.status === "applied_after_modified") return text.status.modified;
  return text.status.needsCheck;
}

function isNeutralReceiptDisplayLine(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number]
) {
  return (
    line.isKegTracked === true ||
    line.status === "keg_tracked" ||
    line.status === "incomplete_recipe" ||
    line.status === "ignored" ||
    line.status === "skipped" ||
    line.lineType === "ignore" ||
    line.lineType === "combo_ignore" ||
    line.lineType === "combo_incomplete_recipe"
  );
}

function isIncompleteRecipeDisplayLine(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number]
) {
  return (
    line.status === "incomplete_recipe" ||
    line.lineType === "incomplete_recipe" ||
    line.lineType === "combo_incomplete_recipe"
  );
}

function hasIncompleteRecipeAncestor(params: {
  line: InventoryDeductionPreview["receipts"][number]["lines"][number];
  lineByRefDetailId: Map<
    string,
    InventoryDeductionPreview["receipts"][number]["lines"][number]
  >;
}) {
  let parentRefDetailId = params.line.parentRefDetailId;
  const visited = new Set<string>();

  while (parentRefDetailId) {
    if (visited.has(parentRefDetailId)) return false;
    visited.add(parentRefDetailId);

    const parent = params.lineByRefDetailId.get(parentRefDetailId);
    if (!parent) return false;
    if (isIncompleteRecipeDisplayLine(parent)) return true;

    parentRefDetailId = parent.parentRefDetailId;
  }

  return false;
}

function isActionableDeductionLine(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number]
) {
  return line.deductions.length > 0;
}

function isReceiptDisplayProblemLine(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number],
  lineByRefDetailId: Map<
    string,
    InventoryDeductionPreview["receipts"][number]["lines"][number]
  >
) {
  if (isNeutralReceiptDisplayLine(line)) return false;
  if (hasIncompleteRecipeAncestor({ line, lineByRefDetailId })) return false;
  if (
    line.deductions.some(
      (deduction) => deduction.status === "insufficient_stock"
    )
  ) {
    return true;
  }

  return (
    line.status === "missing_mapping" ||
    line.status === "invalid_mapping" ||
    line.status === "manual_review" ||
    line.status === "review_required" ||
    line.lineType === "combo_missing_mapping" ||
    line.lineType === "combo_invalid_mapping" ||
    line.lineType === "manual" ||
    line.lineType === "manual_review"
  );
}

function getReceiptListDeductionBadge(
  receipt: InventoryDeductionPreview["receipts"][number] | undefined,
  text: InventoryPreviewCopy,
  workflow?: UnifiedPreviewReceipt
) {
  if (workflow?.operationType === "rollback_canceled") {
    return {
      label: text.unified.rollbackCanceled,
      toneStyle: previewStatusBlockedStyle,
    };
  }
  if (workflow?.operationType === "reprocess_modified") {
    return { label: text.status.modified, toneStyle: previewStatusBlockedStyle };
  }
  if (workflow?.operationType === "needs_check") {
    return { label: text.status.needsCheck, toneStyle: previewStatusBlockedStyle };
  }
  if (workflow?.operationType === "initial_apply") {
    return { label: text.status.ready, toneStyle: previewStatusReadyStyle };
  }
  if (workflow?.activeDeductionCount) {
    return {
      label: text.status.alreadyApplied,
      toneStyle: previewStatusAlreadyAppliedStyle,
    };
  }
  if (!receipt) return null;

  if (receipt.status === "applied_after_modified") {
    return {
      label: text.status.modified,
      toneStyle: previewStatusBlockedStyle,
    };
  }

  const lineByRefDetailId = new Map<
    string,
    InventoryDeductionPreview["receipts"][number]["lines"][number]
  >();
  for (const line of receipt.lines) {
    if (line.refDetailId) lineByRefDetailId.set(line.refDetailId, line);
  }

  if (
    receipt.lines.some((line) =>
      isReceiptDisplayProblemLine(line, lineByRefDetailId)
    )
  ) {
    return {
      label: text.status.needsCheck,
      toneStyle: previewStatusBlockedStyle,
    };
  }

  const actionableLines = receipt.lines.filter(isActionableDeductionLine);
  if (actionableLines.length === 0) return null;

  const appliedActionableCount = actionableLines.filter(
    (line) => line.isApplied === true
  ).length;

  if (appliedActionableCount === actionableLines.length) {
    return {
      label: text.status.alreadyApplied,
      toneStyle: previewStatusAlreadyAppliedStyle,
    };
  }

  if (appliedActionableCount > 0) {
    return {
      label: text.status.partial,
      toneStyle: batchValidationWarningStyle,
    };
  }

  return {
    label: isPartialDeductionReceipt(receipt)
      ? text.status.partial
      : text.status.ready,
    toneStyle: isPartialDeductionReceipt(receipt)
      ? batchValidationWarningStyle
      : previewStatusReadyStyle,
  };
}

function isPreviewLineCheckNeeded(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number]
) {
  return (
    line.status === "missing_mapping" ||
    line.status === "manual_review" ||
    line.status === "invalid_mapping" ||
    line.status === "incomplete_recipe" ||
    line.deductions.some((deduction) => deduction.status === "insufficient_stock")
  );
}

function getReceiptLineCounts(
  receipt: InventoryDeductionPreview["receipts"][number]
) {
  const applicableCount = receipt.lines.filter(
    (line) => line.deductions.length > 0
  ).length;
  const checkCount = receipt.lines.filter(isPreviewLineCheckNeeded).length;

  return {
    applicableCount,
    checkCount:
      checkCount > 0 ||
      receipt.status === "ready" ||
      receipt.status === "skipped"
        ? checkCount
        : Math.max(1, receipt.blockedReasons.length),
  };
}

function getPreviewReceiptSelectionLabel(
  receipt: InventoryDeductionPreview["receipts"][number],
  text: InventoryPreviewCopy
) {
  if (receipt.status === "ready") return text.selectionStatusSelectable;
  if (receipt.status === "already_applied") {
    return text.selectionStatusAlreadyApplied;
  }
  if (receipt.blocked) return text.selectionStatusBlocked;
  return text.selectionStatusNeedsCheck;
}

function getLineHelpText(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number],
  text: InventoryPreviewCopy
) {
  if (line.lineType === "combo_invalid_mapping") {
    const reason = line.blockedReason || "";
    return reason.includes("Combo 안에 Combo") ||
      reason.includes("combo trong combo")
      ? text.comboNestedUnsupported
      : text.comboMappingNeedsCheck;
  }
  if (line.lineType === "combo_missing_mapping") {
    return text.comboMappingNeedsCheck;
  }
  if (line.status === "incomplete_recipe") return text.configureRecipe;
  if (line.status === "missing_mapping") return text.configureMapping;
  if (line.status === "manual_review") return text.manualReviewHelp;
  if (line.status === "invalid_mapping") return text.invalidMappingHelp;
  if (line.deductions.some((deduction) => deduction.status === "insufficient_stock")) {
    return text.insufficientStockHelp;
  }
  if (line.isApplied === true) return text.alreadyAppliedHelp;
  if (line.status === "ignored") return text.ignoredHelp;
  return line.deductions.length > 0 ? "" : text.genericCheckHelp;
}

type PreviewLineStatusTone =
  | "ready"
  | "warning"
  | "danger"
  | "neutral";

function getPreviewLineStatusInfo(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number],
  receipt: InventoryDeductionPreview["receipts"][number],
  text: InventoryPreviewCopy
) {
  const hasInsufficientStock = line.deductions.some(
    (deduction) => deduction.status === "insufficient_stock"
  );
  const isMappingRequired =
    line.status === "missing_mapping" ||
    line.status === "invalid_mapping" ||
    line.lineType === "combo_missing_mapping" ||
    line.lineType === "combo_invalid_mapping";
  const isOperationReview =
    line.status === "manual_review" ||
    line.status === "review_required" ||
    line.lineType === "manual" ||
    line.lineType === "manual_review";
  const isIncompleteRecipe =
    line.status === "incomplete_recipe" ||
    line.lineType === "combo_incomplete_recipe";
  const isExcluded =
    line.status === "ignored" ||
    line.status === "skipped" ||
    line.lineType === "ignore" ||
    line.lineType === "combo_ignore" ||
    receipt.status === "skipped";
  const isAlreadyApplied = line.isApplied === true;
  const isKegTracked =
    line.isKegTracked === true || line.status === "keg_tracked";

  if (hasInsufficientStock) {
    return {
      label: text.lineStatusGroup.insufficientStock,
      message: text.lineStatusHelp.insufficientStock,
      tone: "danger" as const,
    };
  }

  if (isAlreadyApplied) {
    return {
      label: text.lineStatusGroup.alreadyApplied,
      message: text.lineStatusHelp.alreadyApplied,
      tone: "neutral" as const,
    };
  }

  if (isKegTracked) {
    return {
      label: text.lineStatusGroup.kegTracked,
      message: text.lineStatusHelp.kegTracked,
      tone: "neutral" as const,
    };
  }

  if (isMappingRequired) {
    return {
      label: text.lineStatusGroup.mappingRequired,
      message: getLineHelpText(line, text),
      tone: "warning" as const,
    };
  }

  if (isOperationReview) {
    return {
      label: text.lineStatusGroup.operationReview,
      message: getLineHelpText(line, text),
      tone: "warning" as const,
    };
  }

  if (isIncompleteRecipe) {
    return {
      label: text.lineStatusGroup.incompleteRecipe,
      message: text.lineStatusHelp.incompleteRecipe,
      tone: "warning" as const,
    };
  }

  if (isExcluded) {
    return {
      label: text.lineStatusGroup.excluded,
      message: text.lineStatusHelp.excluded,
      tone: "neutral" as const,
    };
  }

  if (line.deductions.length > 0) {
    return {
      label: text.lineStatusGroup.ready,
      message: text.lineStatusHelp.ready,
      tone: "ready" as const,
    };
  }

  return {
    label: text.lineStatusGroup.operationReview,
    message: getLineHelpText(line, text),
    tone: "warning" as const,
  };
}

function getReceiptDetailLineStatusInfo(
  previewLines: InventoryDeductionPreview["receipts"][number]["lines"],
  receipt: InventoryDeductionPreview["receipts"][number],
  text: InventoryPreviewCopy
) {
  if (previewLines.length === 0) return null;

  const ranked = previewLines
    .map((line) => ({
      info: getPreviewLineStatusInfo(line, receipt, text),
      rank:
        line.deductions.some(
          (deduction) => deduction.status === "insufficient_stock"
        )
          ? 0
          : line.status === "missing_mapping" ||
              line.status === "invalid_mapping" ||
              line.status === "manual_review" ||
              line.status === "incomplete_recipe"
            ? 1
            : line.isKegTracked === true || line.status === "keg_tracked"
              ? 2
              : line.isApplied === true
                ? 3
                : line.deductions.length > 0
                  ? 4
                  : 5,
    }))
    .sort((left, right) => left.rank - right.rank);

  return ranked[0]?.info ?? null;
}

function getPreviewLineBadgeStyle(tone: PreviewLineStatusTone) {
  if (tone === "ready") return previewLineBadgeReadyStyle;
  if (tone === "danger") return previewLineBadgeDangerStyle;
  if (tone === "neutral") return previewLineBadgeNeutralStyle;
  return previewLineBadgeWarningStyle;
}

function getNeedsCheckDetails(
  preview: InventoryDeductionPreview,
  text: InventoryPreviewCopy
) {
  const incompleteRecipeLineCount =
    preview.summary.incompleteRecipeLineCount ??
    preview.receipts.reduce(
      (count, receipt) =>
        count +
        receipt.lines.filter((line) => line.status === "incomplete_recipe")
          .length,
      0
    );

  return [
    [text.detailStatus.missingMapping, preview.summary.missingMappingCount],
    [text.detailStatus.incompleteRecipe, incompleteRecipeLineCount],
    [
      text.detailStatus.modified,
      preview.summary.appliedAfterModifiedCount ?? 0,
    ],
    [text.detailStatus.insufficientStock, preview.summary.insufficientStockCount],
    [text.detailStatus.manualReview, preview.summary.manualReviewCount],
    [text.detailStatus.alreadyApplied, preview.summary.alreadyAppliedCount],
    [text.detailStatus.skipped, preview.summary.skippedCount],
    [text.detailStatus.invalidMapping, preview.summary.invalidMappingCount],
    [text.detailStatus.reviewRequired, preview.summary.reviewRequiredCount],
  ] as const;
}

function formatVnd(value?: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatNumber(value?: number) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function toFiniteNumber(value: number | string | null | undefined) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function calculateLineFinalAmount(params: {
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
}) {
  return params.quantity * params.unitPrice - (params.discountAmount || 0);
}

function calculateLineTaxAmount(
  finalAmount: number,
  taxRate: number | null | undefined
) {
  const rate = toFiniteNumber(taxRate);
  if (!Number.isFinite(finalAmount) || finalAmount <= 0 || rate <= 0) return 0;
  return Math.round((finalAmount * rate) / 100);
}

function formatTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";

  return date.toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatUnifiedExecuteButton(text: InventoryPreviewCopy, count: number) {
  return text.unified.executeButton.replace("{count}", formatNumber(count));
}

function getUnifiedOperationLabel(
  operationType: UnifiedOperationType | null,
  text: InventoryPreviewCopy
) {
  if (operationType === "initial_apply") return text.unified.initialApply;
  if (operationType === "reprocess_modified") {
    return text.unified.reprocessModified;
  }
  if (operationType === "rollback_canceled") {
    return text.unified.rollbackCanceled;
  }
  if (operationType === "needs_check") return text.unified.needsCheck;
  return text.unified.noOp;
}

function getUnifiedOperationStyle(operationType: UnifiedOperationType | null) {
  if (operationType === "initial_apply") return previewStatusReadyStyle;
  if (operationType === "reprocess_modified") return previewStatusAlreadyAppliedStyle;
  if (operationType === "rollback_canceled") return previewStatusBlockedStyle;
  if (operationType === "needs_check") return previewStatusBlockedStyle;
  return previewStatusSkippedStyle;
}

function getUnifiedReprocessMode(
  receipt: UnifiedPreviewReceipt,
  text: InventoryPreviewCopy
) {
  if (receipt.operationType !== "reprocess_modified") return "";
  if (receipt.activeDeductionCount > 0 && receipt.actionableLineCount > 0) {
    return text.unified.restoreAndReapply;
  }
  if (receipt.activeDeductionCount > 0) return text.unified.restoreOnly;
  if (receipt.actionableLineCount > 0) return text.unified.reapplyOnly;
  return "";
}

function getUnifiedResultLabel(
  result: UnifiedExecuteResultCode,
  text: InventoryPreviewCopy
) {
  if (result === "applied") return text.unified.resultApplied;
  if (result === "already_processed") return text.unified.resultAlreadyProcessed;
  if (result === "stale_preview") return text.unified.resultStale;
  if (result === "needs_check") return text.unified.resultNeedsCheck;
  if (result === "no_op") return text.unified.resultNoOp;
  if (result === "not_supported") return text.unified.resultNotSupported;
  return text.unified.resultFailed;
}

function getUnifiedFailureReasonLabel(
  reason: string | null,
  text: InventoryPreviewCopy
) {
  if (!reason) return "";
  const mapped =
    text.unified.failureReasons[
      reason as keyof typeof text.unified.failureReasons
    ];
  return mapped || text.unified.failureReasons.blocking_status;
}

function getPaymentStatusLabel(
  receipt: Pick<ReceiptItem, "isCanceled" | "paymentStatus">,
  text: SalesReceiptsViewText
) {
  if (receipt.isCanceled) return text.canceled;
  if (receipt.paymentStatus === 1) return text.paymentPending;
  if (receipt.paymentStatus === 3) return text.paid;
  if (receipt.paymentStatus === 4 || receipt.paymentStatus === 5) {
    return text.canceled;
  }
  return `${text.status} ${receipt.paymentStatus ?? "-"}`;
}

function getReceiptLineCountLabel(text: SalesReceiptsViewText) {
  return text.salesLineLabel;
}

function getReceiptSortTime(receipt: ReceiptItem) {
  const parsed = Date.parse(receipt.refDate || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortReceiptsByRefDateDesc(receipts: ReceiptItem[]) {
  return [...receipts].sort((a, b) => {
    const timeDiff = getReceiptSortTime(b) - getReceiptSortTime(a);
    if (timeDiff !== 0) return timeDiff;
    return b.id - a.id;
  });
}

function normalizePaymentText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getPaymentLabel(
  payment: {
    paymentName?: string | null;
    payment_name?: string | null;
    cardName?: string | null;
    card_name?: string | null;
    paymentType?: number | string | null;
    payment_type?: number | string | null;
  },
  text: {
    cash?: string;
    transfer?: string;
    card?: string;
    other?: string;
  }
) {
  const fallbackPaymentLabel = text.other || "";
  const rawName =
    payment.paymentName ??
    payment.payment_name ??
    payment.cardName ??
    payment.card_name ??
    "";

  const normalized = normalizePaymentText(rawName);
  const paymentType = String(payment.paymentType ?? payment.payment_type ?? "");

  if (
    normalized.includes("tien mat") ||
    normalized.includes("cash") ||
    paymentType === "1"
  ) {
    return text.cash || fallbackPaymentLabel;
  }

  if (
    normalized.includes("chuyen khoan") ||
    normalized.includes("transfer") ||
    normalized.includes("bank")
  ) {
    return text.transfer || fallbackPaymentLabel;
  }

  if (
    normalized.includes("the") ||
    normalized.includes("card") ||
    normalized.includes("visa") ||
    normalized.includes("master")
  ) {
    return text.card || fallbackPaymentLabel;
  }

  if (
    normalized.includes("khac") ||
    normalized.includes("other")
  ) {
    return fallbackPaymentLabel;
  }

  return String(rawName || fallbackPaymentLabel);
}

function isCashPayment(payment: Pick<ReceiptPayment, "paymentName" | "cardName">) {
  const paymentName = normalizePaymentText(payment.paymentName);
  const cardName = normalizePaymentText(payment.cardName);
  const label = `${paymentName} ${cardName}`;

  return (
    label.includes("tien mat") ||
    label.includes("cash")
  );
}

function getPaymentKindLabel(
  payment: Pick<ReceiptPayment, "paymentName" | "cardName">,
  text: SalesReceiptsViewText
) {
  const paymentName = normalizePaymentText(payment.paymentName);
  const cardName = normalizePaymentText(payment.cardName);
  const label = `${paymentName} ${cardName}`.trim();

  if (label.includes("tien mat") || label.includes("cash")) {
    return text.cash;
  }

  if (
    label.includes("chuyen khoan") ||
    label.includes("transfer") ||
    label.includes("bank")
  ) {
    return text.transfer;
  }

  if (label.includes("khac") || label.includes("other")) {
    return text.other;
  }

  if (
    label.includes("the") ||
    label.includes("card") ||
    label.includes("visa") ||
    label.includes("master") ||
    cardName
  ) {
    return text.card;
  }

  return payment.cardName || payment.paymentName || text.paymentMethod;
}

function getPaymentSummaryText(
  payments: ReceiptPayment[] | undefined,
  text: SalesReceiptsViewText
) {
  const labels = (payments || [])
    .map((payment) => getPaymentKindLabel(payment, text))
    .filter(Boolean);

  return Array.from(new Set(labels)).join(" · ");
}

function getPaymentIcon(payment: PaymentDetail) {
  const label = normalizePaymentText(
    `${payment.paymentName ?? ""} ${payment.cardName ?? ""}`
  );

  if (label.includes("tien mat") || label.includes("cash")) {
    return "💵";
  }

  if (
    label.includes("chuyen khoan") ||
    label.includes("transfer") ||
    label.includes("bank")
  ) {
    return "🏦";
  }

  if (
    label.includes("the") ||
    label.includes("card") ||
    label.includes("visa") ||
    label.includes("master")
  ) {
    return "💳";
  }

  if (label.includes("khac") || label.includes("other")) {
    return "💰";
  }

  return "💰";
}

function hasCashPayment(payments?: PaymentDetail[]) {
  return (payments || []).some(isCashPayment);
}

export default function SalesReceiptsPage() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { lang } = useLanguage();
  const t = salesText[lang];
  const c = commonText[lang];
  const s = t.common;
  const inventoryText = inventoryPreviewText[lang];
  const receiptsText = {
    ...s,
    ...t.receipts,
    quantity: c.quantity,
    total: c.total,
    loading: c.loading,
    error: c.error,
    loadFailed: c.loadFailed,
    noSearchResult: c.noSearchResult,
    cash: c.cash,
    transfer: c.transfer,
    card: c.card,
    other: c.etc,
    paymentMethod: c.paymentMethod,
    vat: c.vat,
    totalTax: c.totalTax,
    receivedAmount: c.receivedAmount,
    changeAmount: c.changeAmount,
    paid: c.paid,
    paymentPending: c.paymentPending,
    canceled: c.canceled,
    status: c.status,
    modified: c.modified,
    table: c.table,
  };
  const receiptsEditText = {
    ...s,
    ...t.receiptsEdit,
    quantity: c.quantity,
    delete: c.delete,
    save: c.save,
    saving: c.saving,
    cancel: c.cancel,
    reset: c.reset,
    searchLoading: c.searchLoading,
    noSearchResult: c.noSearchResult,
    cash: c.cash,
    transfer: c.transfer,
    card: c.card,
    other: c.etc,
    paymentMethod: c.paymentMethod,
    vat: c.vat,
    receivedAmount: c.receivedAmount,
    changeAmount: c.changeAmount,
    manage: c.manage,
    restore: c.restore,
    add: c.add,
    productName: c.productName,
    unitPrice: c.unitPrice,
    taxRate: c.taxRate,
    taxAmount: c.taxAmount,
  };
  // Empty means "let the server resolve today's business date" — see
  // fetchReceipts below, which syncs state/URL from the API response once
  // the store-settings-resolved businessDate arrives.
  const initialBusinessDate = searchParams.get("businessDate") || "";
  const [businessDate, setBusinessDate] = useState(initialBusinessDate);
  const [receipts, setReceipts] = useState<ReceiptItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [expandedReceiptId, setExpandedReceiptId] = useState<number | null>(null);
  const [detailByReceiptId, setDetailByReceiptId] = useState<
    Record<number, ReceiptDetailResponse>
  >({});
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const [detailErrorByReceiptId, setDetailErrorByReceiptId] = useState<
    Record<number, string>
  >({});
  const [editSavingId, setEditSavingId] = useState<number | null>(null);
  const [editErrorByReceiptId, setEditErrorByReceiptId] = useState<
    Record<number, string>
  >({});
  const [posCheckingIds, setPosCheckingIds] = useState<Set<number>>(
    () => new Set()
  );
  const [posCheckErrorByReceiptId, setPosCheckErrorByReceiptId] = useState<
    Record<number, string>
  >({});
  const [autoOpenEditReceiptId, setAutoOpenEditReceiptId] = useState<
    number | null
  >(null);
  const [currentUser, setCurrentUser] =
    useState<ReturnType<typeof getUser>>(null);
  const [isMenuSyncing, setIsMenuSyncing] = useState(false);
  const [menuSyncMessage, setMenuSyncMessage] = useState("");
  const [menuSyncWarning, setMenuSyncWarning] = useState("");
  const [menuSyncErrorMessage, setMenuSyncErrorMessage] = useState("");
  const [isManualReceiptModalOpen, setIsManualReceiptModalOpen] = useState(false);
  const [isManualReceiptSaving, setIsManualReceiptSaving] = useState(false);
  const [manualReceiptSaveError, setManualReceiptSaveError] = useState("");
  const [manualReceiptDateNotice, setManualReceiptDateNotice] = useState("");
  const [receiptDeductionPreview, setReceiptDeductionPreview] = useState<
    InventoryDeductionPreview["receipts"] | null
  >(null);
  const [receiptUnifiedPreview, setReceiptUnifiedPreview] = useState<
    UnifiedPreviewReceipt[] | null
  >(null);
  const [receiptDeductionPreviewRefreshToken, setReceiptDeductionPreviewRefreshToken] =
    useState(0);
  const [unifiedPreview, setUnifiedPreview] = useState<UnifiedPreview | null>(
    null
  );
  const [isUnifiedPreviewLoading, setIsUnifiedPreviewLoading] = useState(false);
  const [unifiedPreviewError, setUnifiedPreviewError] = useState("");
  const [isUnifiedExecuting, setIsUnifiedExecuting] = useState(false);
  const [unifiedExecuteResult, setUnifiedExecuteResult] =
    useState<UnifiedExecuteResponse | null>(null);

  const canSyncMenu =
    currentUser?.role === "owner" ||
    currentUser?.role === "master" ||
    currentUser?.role === "manager";
  const tabs = useMemo(
    () =>
      salesTabs.map((tab) => ({
        label: t.tabs[tab.key],
        href: `${tab.href}?businessDate=${encodeURIComponent(businessDate)}`,
        active:
          tab.href === "/admin/sales"
            ? pathname === "/admin/sales" || pathname === "/admin/sales/"
            : pathname.startsWith(tab.href),
      })),
    [businessDate, pathname, t.tabs]
  );

  const receiptIdsKey = useMemo(
    () => receipts.map((receipt) => receipt.id).join(","),
    [receipts]
  );
  const receiptDeductionPreviewByReceiptId = useMemo(() => {
    const map = new Map<
      number,
      InventoryDeductionPreview["receipts"][number]
    >();
    (receiptDeductionPreview || []).forEach((receipt) => {
      map.set(receipt.receiptId, receipt);
    });
    return map;
  }, [receiptDeductionPreview]);
  const receiptUnifiedPreviewByReceiptId = useMemo(() => {
    const map = new Map<number, UnifiedPreviewReceipt>();
    (receiptUnifiedPreview || []).forEach((receipt) => {
      map.set(receipt.receiptId, receipt);
    });
    return map;
  }, [receiptUnifiedPreview]);
  const receiptListIncompleteRecipeLineCount = useMemo(
    () => getIncompleteRecipeLineCount(receiptDeductionPreview),
    [receiptDeductionPreview]
  );

  useEffect(() => {
    const user = getUser();
    setCurrentUser(user);
    if (user?.role === "leader") {
      router.replace("/admin/sales/monthly");
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchReceipts() {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const query = `?businessDate=${encodeURIComponent(businessDate)}`;
        const res = await fetch(`/api/admin/sales/receipts${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await res.json()) as SalesReceiptsResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || receiptsText.loadFailed);
        }

        setReceipts(sortReceiptsByRefDateDesc(result.receipts || []));

        if (!businessDate && result.businessDate) {
          setBusinessDate(result.businessDate);
          router.replace(
            `${pathname}?businessDate=${encodeURIComponent(result.businessDate)}`,
            { scroll: false }
          );
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setErrorMessage(
          error instanceof Error
            ? error.message
            : receiptsText.loadFailed
        );
        setReceipts([]);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    setExpandedReceiptId(null);
    setDetailErrorByReceiptId({});
    setReceiptDeductionPreview(null);
    setReceiptUnifiedPreview(null);
    setUnifiedPreview(null);
    setUnifiedPreviewError("");
    setUnifiedExecuteResult(null);
    fetchReceipts();

    return () => controller.abort();
  }, [businessDate, receiptsText.loadFailed, pathname, router]);

  useEffect(() => {
    if (!canSyncMenu || !currentUser?.username || !receiptIdsKey) {
      setReceiptDeductionPreview(null);
      setReceiptUnifiedPreview(null);
      return;
    }

    const receiptIds = receiptIdsKey.split(",").map(Number);
    const controller = new AbortController();

    async function fetchReceiptDeductionPreview() {
      try {
        const res = await fetchSalesApi("/api/admin/sales/inventory-deductions/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            receiptIds,
          }),
          signal: controller.signal,
          cache: "no-store",
        });
        const result = (await res.json().catch(() => null)) as
          | InventoryPreviewResponse
          | null;

        if (!res.ok || !result?.ok || !result.preview) {
          if (!controller.signal.aborted) setReceiptDeductionPreview(null);
          return;
        }

        setReceiptDeductionPreview(result.preview.receipts);

        const unifiedRes = await fetchSalesApi(
          "/api/admin/sales/inventory-deductions/unified-preview",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              receiptIds,
            }),
            signal: controller.signal,
            cache: "no-store",
          }
        );
        const unifiedResult = (await unifiedRes.json().catch(() => null)) as
          | UnifiedPreviewResponse
          | null;
        setReceiptUnifiedPreview(
          unifiedRes.ok && unifiedResult?.ok && unifiedResult.preview
            ? unifiedResult.preview.receipts
            : null
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setReceiptDeductionPreview(null);
        setReceiptUnifiedPreview(null);
      }
    }

    fetchReceiptDeductionPreview();
    return () => controller.abort();
  }, [
    canSyncMenu,
    currentUser?.username,
    receiptIdsKey,
    receiptDeductionPreviewRefreshToken,
  ]);

  async function handleToggleReceipt(receiptId: number) {
    setAutoOpenEditReceiptId(null);

    if (expandedReceiptId === receiptId) {
      setExpandedReceiptId(null);
      return;
    }

    setExpandedReceiptId(receiptId);

    if (detailByReceiptId[receiptId]) return;

    setDetailLoadingId(receiptId);
    setDetailErrorByReceiptId((current) => ({ ...current, [receiptId]: "" }));

    try {
      const res = await fetch(`/api/admin/sales/receipts/${receiptId}`, {
        cache: "no-store",
      });
      const result = (await res.json()) as ReceiptDetailResponse;

      if (!res.ok || !result.ok) {
        throw new Error(result.error || receiptsText.detailLoadFailed);
      }

      setDetailByReceiptId((current) => ({
        ...current,
        [receiptId]: result,
      }));
    } catch (error) {
      setDetailErrorByReceiptId((current) => ({
        ...current,
        [receiptId]:
          error instanceof Error
            ? error.message
            : receiptsText.detailLoadFailed,
      }));
    } finally {
      setDetailLoadingId(null);
    }
  }

  async function handleSaveReceiptEdit({
    receiptId,
    lines,
    paymentMethod,
    cashReceivedAmount,
    note,
    taxOverrideMode,
    finalAmountOverride,
    expectedRevision,
    requestId,
  }: SaveReceiptEditInput) {
    const user = getUser();

    if (!user?.username) {
      setEditErrorByReceiptId((current) => ({
        ...current,
        [receiptId]: c.loginAgain,
      }));
      return;
    }

    setEditSavingId(receiptId);
    setEditErrorByReceiptId((current) => ({
      ...current,
      [receiptId]: "",
    }));

    try {
      const res = await fetch(`/api/admin/sales/receipts/${receiptId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actorUsername: user.username,
          paymentMethod,
          cashReceivedAmount,
          note,
          lines,
          taxOverrideMode,
          finalAmountOverride,
          expectedRevision,
          requestId,
        }),
      });

      const result = (await res.json()) as ReceiptPatchResponse;

      if (res.status === 409 && result.code === "receipt_revision_conflict") {
        const refreshed = await fetch(`/api/admin/sales/receipts/${receiptId}`, { cache: "no-store" });
        const latest = (await refreshed.json()) as ReceiptDetailResponse;
        if (refreshed.ok && latest.ok && latest.receipt) {
          setDetailByReceiptId((current) => ({ ...current, [receiptId]: latest }));
        }
        throw new Error(receiptsEditText.revisionConflict);
      }

      if (!res.ok || !result.ok || !result.receipt) {
        throw new Error(
          result.code === "receipt_has_option_lines"
            ? receiptsEditText.optionEditProtected
            : result.message || result.error || receiptsEditText.saveFailed
        );
      }

      const updatedReceipt = result.receipt;
      setReceipts((current) =>
        current.map((receipt) =>
          receipt.id === receiptId
            ? {
              ...receipt,
              totalAmount: updatedReceipt.totalAmount,
              finalAmount: updatedReceipt.finalAmount,
              isModified: updatedReceipt.isModified,
            }
            : receipt
        )
      );

      setDetailByReceiptId((current) => {
        const currentDetail = current[receiptId];

        if (!currentDetail?.receipt) return current;

        return {
          ...current,
          [receiptId]: {
            ...currentDetail,
            receipt: {
              ...currentDetail.receipt,
              totalAmount: updatedReceipt.totalAmount,
              finalAmount: updatedReceipt.finalAmount,
              receiveAmount: updatedReceipt.receiveAmount,
              returnAmount: updatedReceipt.returnAmount,
              isModified: updatedReceipt.isModified,
              modifiedAt: updatedReceipt.modifiedAt,
              modifiedBy: updatedReceipt.modifiedBy,
              modificationNote: updatedReceipt.modificationNote,
              vatAmount: updatedReceipt.vatAmount,
              calculatedVatAmount: updatedReceipt.calculatedVatAmount,
              calculatedFinalAmount: updatedReceipt.calculatedFinalAmount,
              finalAmountOverride: updatedReceipt.finalAmountOverride,
              taxOverrideMode: updatedReceipt.taxOverrideMode,
              revision: updatedReceipt.revision,
            },
          },
        };
      });

      const refreshed = await fetch(`/api/admin/sales/receipts/${receiptId}`, {
        cache: "no-store",
      });
      const refreshedDetail = (await refreshed.json()) as ReceiptDetailResponse;

      if (refreshed.ok && refreshedDetail.ok) {
        setDetailByReceiptId((current) => ({
          ...current,
          [receiptId]: refreshedDetail,
        }));
        setReceipts((current) =>
          current.map((receipt) =>
            receipt.id === receiptId && refreshedDetail.receipt
              ? {
                ...receipt,
                totalAmount: refreshedDetail.receipt.totalAmount,
                finalAmount: refreshedDetail.receipt.finalAmount,
                isModified: refreshedDetail.receipt.isModified,
                payments: (refreshedDetail.payments || []).map((payment) => ({
                  paymentName: payment.paymentName,
                  cardName: payment.cardName,
                  amount: payment.amount,
                })),
                lineCount: (refreshedDetail.lines || []).filter(
                  (line) =>
                    line.isExcluded !== true &&
                    !isExistingOptionLine(
                      line,
                      getReceiptLineRefDetailIds(refreshedDetail.lines || [])
                    )
                ).length,
                optionLineCount: (refreshedDetail.lines || []).filter(
                  (line) =>
                    line.isExcluded !== true &&
                    isExistingOptionLine(
                      line,
                      getReceiptLineRefDetailIds(refreshedDetail.lines || [])
                    )
                ).length,
              }
              : receipt
          )
        );
      }
    } catch (error) {
      setEditErrorByReceiptId((current) => ({
        ...current,
        [receiptId]:
          error instanceof Error ? error.message : receiptsEditText.saveFailed,
      }));
    } finally {
      setEditSavingId(null);
    }
  }

  async function handleRequestEdit(receipt: ReceiptItem) {
    // 결제완료 + 미취소 영수증은 ReceiptEditPanel이 이 함수를 호출하지 않고
    // 즉시 수정 화면을 연다(불필요한 POS 재조회 방지). 여기서는 방어적으로만 확인한다.
    const isAlreadyPaid = receipt.paymentStatus === 3 && !receipt.isCanceled;
    if (isAlreadyPaid) return;

    if (posCheckingIds.has(receipt.id)) return;

    setAutoOpenEditReceiptId(null);
    setPosCheckErrorByReceiptId((current) => ({
      ...current,
      [receipt.id]: "",
    }));

    const user = getUser();
    if (!user?.username) {
      setPosCheckErrorByReceiptId((current) => ({
        ...current,
        [receipt.id]: c.loginAgain,
      }));
      return;
    }

    setPosCheckingIds((current) => {
      const next = new Set(current);
      next.add(receipt.id);
      return next;
    });

    try {
      const res = await fetch(
        `/api/admin/sales/receipts/${receipt.id}/refresh-pos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actorUsername: user.username }),
        }
      );
      const result = (await res.json()) as {
        ok: boolean;
        paymentStatus: number | null;
        isCanceled: boolean;
        editable: boolean;
        blockReason: "pending" | "canceled" | "pos_lookup_failed" | null;
        error?: string;
      };

      if (typeof result.paymentStatus === "number") {
        setReceipts((current) =>
          current.map((item) =>
            item.id === receipt.id
              ? {
                ...item,
                paymentStatus: result.paymentStatus,
                isCanceled: result.isCanceled === true,
              }
              : item
          )
        );
      }

      if (!res.ok || !result.ok) {
        setPosCheckErrorByReceiptId((current) => ({
          ...current,
          [receipt.id]: receiptsEditText.posCheckLookupFailed,
        }));
        return;
      }

      if (!result.editable) {
        const message =
          result.blockReason === "canceled"
            ? receiptsEditText.posCheckCanceled
            : result.blockReason === "pos_lookup_failed"
              ? receiptsEditText.posCheckLookupFailed
              : receiptsEditText.posCheckPaymentPending;

        setPosCheckErrorByReceiptId((current) => ({
          ...current,
          [receipt.id]: message,
        }));
        return;
      }

      const detailRes = await fetch(
        `/api/admin/sales/receipts/${receipt.id}`,
        { cache: "no-store" }
      );
      const detailResult = (await detailRes.json()) as ReceiptDetailResponse;

      if (!detailRes.ok || !detailResult.ok || !detailResult.receipt) {
        setPosCheckErrorByReceiptId((current) => ({
          ...current,
          [receipt.id]: receiptsEditText.posCheckRefreshFailed,
        }));
        return;
      }

      setDetailByReceiptId((current) => ({
        ...current,
        [receipt.id]: detailResult,
      }));
      setReceipts((current) =>
        current.map((item) =>
          item.id === receipt.id && detailResult.receipt
            ? {
              ...item,
              paymentStatus: detailResult.receipt.paymentStatus,
              isCanceled: detailResult.receipt.isCanceled,
              totalAmount: detailResult.receipt.totalAmount,
              finalAmount: detailResult.receipt.finalAmount,
              payments: (detailResult.payments || []).map((payment) => ({
                paymentName: payment.paymentName,
                cardName: payment.cardName,
                amount: payment.amount,
              })),
              lineCount: (detailResult.lines || []).filter(
                (line) =>
                  line.isExcluded !== true &&
                  !isExistingOptionLine(
                    line,
                    getReceiptLineRefDetailIds(detailResult.lines || [])
                  )
              ).length,
              optionLineCount: (detailResult.lines || []).filter(
                (line) =>
                  line.isExcluded !== true &&
                  isExistingOptionLine(
                    line,
                    getReceiptLineRefDetailIds(detailResult.lines || [])
                  )
              ).length,
            }
            : item
        )
      );
      setAutoOpenEditReceiptId(receipt.id);
    } catch {
      setPosCheckErrorByReceiptId((current) => ({
        ...current,
        [receipt.id]: receiptsEditText.posCheckLookupFailed,
      }));
    } finally {
      setPosCheckingIds((current) => {
        const next = new Set(current);
        next.delete(receipt.id);
        return next;
      });
    }
  }

  function handleBusinessDateChange(value: string) {
    setBusinessDate(value);
    setDetailByReceiptId({});
    setEditErrorByReceiptId({});
    router.replace(`${pathname}?businessDate=${encodeURIComponent(value)}`, {
      scroll: false,
    });
  }

  async function handleSyncMenu() {
    if (!currentUser?.username || !canSyncMenu) {
      setMenuSyncErrorMessage(receiptsText.noPermission);
      setMenuSyncMessage("");
      setMenuSyncWarning("");
      return;
    }

    setIsMenuSyncing(true);
    setMenuSyncMessage("");
    setMenuSyncWarning("");
    setMenuSyncErrorMessage("");

    try {
      const res = await fetch("/api/admin/pos/products/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actorUsername: currentUser.username,
        }),
      });
      const result = (await res.json().catch(() => null)) as
        | PosProductsSyncResponse
        | null;

      if (!res.ok || !result?.ok) {
        throw new Error(
          res.status === 403
            ? receiptsText.noPermission
            : receiptsText.menuSyncFailed
        );
      }

      const upsertedCount = result.result?.upsertedCount || 0;
      const detailFailedCount = result.result?.detailFailedCount || 0;

      setMenuSyncMessage(
        `${receiptsText.menuSyncSuccess}: ${receiptsText.menuSyncApplied} ${formatNumber(upsertedCount)}${receiptsText.menuSyncCountSuffix}, ${receiptsText.menuSyncDetailFailed} ${formatNumber(detailFailedCount)}${receiptsText.menuSyncCountSuffix}`
      );
      setMenuSyncWarning(
        detailFailedCount > 0 ? receiptsText.menuSyncDetailWarning : ""
      );
    } catch (error) {
      setMenuSyncErrorMessage(
        error instanceof Error ? error.message : receiptsText.menuSyncFailed
      );
    } finally {
      setIsMenuSyncing(false);
    }
  }

  async function refreshReceiptsAndDeductionPreview() {
    const query = `?businessDate=${encodeURIComponent(businessDate)}`;
    const refreshRes = await fetch(`/api/admin/sales/receipts${query}`, {
      cache: "no-store",
    });
    const refreshResult = (await refreshRes.json().catch(
      () => null
    )) as SalesReceiptsResponse | null;

    if (refreshResult?.ok) {
      setReceipts(sortReceiptsByRefDateDesc(refreshResult.receipts || []));
    }
    setReceiptDeductionPreviewRefreshToken((current) => current + 1);
  }

  async function handleInventoryPreview() {
    if (!currentUser?.username || !canSyncMenu) {
      setUnifiedPreviewError(receiptsText.noPermission);
      return;
    }

    setIsUnifiedPreviewLoading(true);
    setUnifiedPreviewError("");
    setUnifiedPreview(null);
    setUnifiedExecuteResult(null);
    try {
      const res = await fetchSalesApi(
        "/api/admin/sales/inventory-deductions/unified-preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessDate,
          }),
        }
      );
      const result = (await res.json().catch(() => null)) as
        | UnifiedPreviewResponse
        | null;

      if (!res.ok || !result?.ok || !result.preview) {
        throw new Error(result?.error || inventoryText.previewFailed);
      }

      setUnifiedPreview(result.preview);
    } catch (error) {
      setUnifiedPreviewError(
        error instanceof Error
          ? error.message
          : inventoryText.previewFailed
      );
    } finally {
      setIsUnifiedPreviewLoading(false);
    }
  }

  async function handleUnifiedExecute() {
    if (!currentUser?.username || !canSyncMenu || !unifiedPreview) return;

    const executableReceipts = unifiedPreview.receipts.filter(
      (receipt) => receipt.canExecute
    );
    if (
      executableReceipts.length === 0 ||
      executableReceipts.length > 30 ||
      isUnifiedExecuting
    ) {
      return;
    }

    setIsUnifiedExecuting(true);
    setUnifiedPreviewError("");
    try {
      const res = await fetchSalesApi(
        "/api/admin/sales/inventory-deductions/unified-execute",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: executableReceipts.map((receipt) => ({
              receiptId: receipt.receiptId,
              expectedOperationType: receipt.operationType,
              expectedFingerprint: receipt.currentFingerprint,
              expectedInventoryAffectingHash: receipt.inventoryAffectingHash,
              expectedReceiptUpdatedAt: receipt.updatedAt,
            })),
          }),
        }
      );
      const result = (await res.json().catch(() => null)) as
        | UnifiedExecuteResponse
        | null;

      if (!res.ok || !result?.success) {
        throw new Error(result?.error || inventoryText.applyFailed);
      }

      setUnifiedExecuteResult(result);
      await refreshReceiptsAndDeductionPreview();
      const previewRes = await fetchSalesApi(
        "/api/admin/sales/inventory-deductions/unified-preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessDate,
          }),
        }
      );
      const previewResult = (await previewRes.json().catch(() => null)) as
        | UnifiedPreviewResponse
        | null;
      if (previewRes.ok && previewResult?.ok && previewResult.preview) {
        setUnifiedPreview(previewResult.preview);
      }
    } catch (error) {
      setUnifiedPreviewError(
        error instanceof Error ? error.message : inventoryText.applyFailed
      );
    } finally {
      setIsUnifiedExecuting(false);
    }
  }

  async function handleCreateManualReceipt(input: CreateManualReceiptInput) {
    const user = getUser();
    if (!user?.username) {
      setManualReceiptSaveError(c.loginAgain);
      return;
    }

    setIsManualReceiptSaving(true);
    setManualReceiptSaveError("");

    try {
      const res = await fetch("/api/admin/sales/receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, actorUsername: user.username }),
      });
      const result = (await res.json().catch(() => null)) as ManualReceiptCreateResponse | null;

      if (!res.ok || !result?.ok) {
        throw new Error(result?.error || receiptsText.manualReceiptFailed);
      }

      setIsManualReceiptModalOpen(false);
      setManualReceiptSaveError("");

      if (input.businessDate !== businessDate) {
        setManualReceiptDateNotice(
          receiptsText.manualReceiptCreatedOtherDateNotice.replace(
            "{businessDate}",
            input.businessDate
          )
        );
      } else {
        setManualReceiptDateNotice("");
        const query = `?businessDate=${encodeURIComponent(businessDate)}`;
        const refreshRes = await fetch(`/api/admin/sales/receipts${query}`, {
          cache: "no-store",
        });
        const refreshResult = (await refreshRes.json().catch(
          () => null
        )) as SalesReceiptsResponse | null;
        if (refreshResult?.ok) {
          setReceipts(sortReceiptsByRefDateDesc(refreshResult.receipts || []));
          setDetailByReceiptId({});
          setExpandedReceiptId(null);
        }
      }
    } catch (error) {
      setManualReceiptSaveError(
        error instanceof Error ? error.message : receiptsText.manualReceiptFailed
      );
    } finally {
      setIsManualReceiptSaving(false);
    }
  }

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        <section style={noticeCardStyle}>
          <div style={noticeHeaderStyle}>
            <span style={noticeBadgeStyle}>{receiptsText.badge}</span>
            <span style={noticeTitleStyle}>{receiptsText.title}</span>
          </div>
          <div style={dateFilterStyle}>
            <label style={dateInputWrapStyle}>
              <input
                type="date"
                value={businessDate}
                onChange={(event) => handleBusinessDateChange(event.target.value)}
                style={dateInputStyle}
              />
            </label>
            {canSyncMenu ? (
              <div style={menuSyncWrapStyle}>
                <button
                  type="button"
                  onClick={() => {
                    setManualReceiptSaveError("");
                    setIsManualReceiptModalOpen(true);
                  }}
                  style={createManualReceiptButtonStyle}
                >
                  {receiptsText.createManualReceiptButton}
                </button>
                <button
                  type="button"
                  onClick={handleInventoryPreview}
                  disabled={isUnifiedPreviewLoading || isUnifiedExecuting || isLoading}
                  style={{
                    ...inventoryPreviewButtonStyle,
                    ...(isUnifiedPreviewLoading || isUnifiedExecuting
                      ? menuSyncButtonDisabledStyle
                      : null),
                  }}
                >
                  {isUnifiedPreviewLoading
                    ? inventoryText.previewLoading
                    : inventoryText.previewButton}
                </button>
              </div>
            ) : null}
          </div>
          {manualReceiptDateNotice ? (
            <p style={warningTextStyle}>{manualReceiptDateNotice}</p>
          ) : null}
          {unifiedPreviewError ? (
            <p style={errorTextStyle}>{unifiedPreviewError}</p>
          ) : null}
          {errorMessage ? <p style={errorTextStyle}>{errorMessage}</p> : null}
        </section>

        {unifiedPreview ? (
          <UnifiedInventoryDeductionPanel
            preview={unifiedPreview}
            receipts={receipts}
            executeResult={unifiedExecuteResult}
            isExecuting={isUnifiedExecuting}
            canExecute={canSyncMenu}
            text={inventoryText}
            receiptText={receiptsText}
            onExecute={handleUnifiedExecute}
            onRetryPreview={handleInventoryPreview}
          />
        ) : null}

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <div style={sectionTitleRowStyle}>
              <h2 style={sectionTitleStyle}>{receiptsText.listTitle}</h2>
              {receiptListIncompleteRecipeLineCount > 0 ? (
                <span style={receiptListExclusionBadgeStyle}>
                  {inventoryText.detailStatus.incompleteRecipe}{" "}
                  {formatNumber(receiptListIncompleteRecipeLineCount)}
                  {inventoryText.countSuffix}
                </span>
              ) : null}
            </div>
            <span style={sectionMetaStyle}>
              {receipts.length}{receiptsText.receiptCountSuffix}
            </span>
          </div>

          <ReceiptList
            isLoading={isLoading}
            text={receiptsText}
            editText={receiptsEditText}
            receipts={receipts}
            expandedReceiptId={expandedReceiptId}
            detailByReceiptId={detailByReceiptId}
            detailLoadingId={detailLoadingId}
            detailErrorByReceiptId={detailErrorByReceiptId}
            editSavingId={editSavingId}
            editErrorByReceiptId={editErrorByReceiptId}
            posCheckingIds={posCheckingIds}
            posCheckErrorByReceiptId={posCheckErrorByReceiptId}
            autoOpenEditReceiptId={autoOpenEditReceiptId}
            deductionText={inventoryText}
            deductionPreviewByReceiptId={receiptDeductionPreviewByReceiptId}
            unifiedPreviewByReceiptId={receiptUnifiedPreviewByReceiptId}
            onToggleReceipt={handleToggleReceipt}
            onSaveEdit={handleSaveReceiptEdit}
            onRequestEdit={handleRequestEdit}
          />

          {canSyncMenu ? (
            <div style={menuSyncBottomWrapStyle}>
              <span style={menuSyncDescriptionStyle}>
                {receiptsText.menuSyncDescription}
              </span>
              <button
                type="button"
                onClick={handleSyncMenu}
                disabled={isMenuSyncing}
                style={{
                  ...menuSyncButtonStyle,
                  ...(isMenuSyncing ? menuSyncButtonDisabledStyle : null),
                }}
              >
                {isMenuSyncing
                  ? receiptsText.menuSyncing
                  : receiptsText.menuSyncButton}
              </button>
              {menuSyncMessage ? (
                <p style={successTextStyle}>{menuSyncMessage}</p>
              ) : null}
              {menuSyncWarning ? (
                <p style={warningTextStyle}>{menuSyncWarning}</p>
              ) : null}
              {menuSyncErrorMessage ? (
                <p style={errorTextStyle}>{menuSyncErrorMessage}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      {isManualReceiptModalOpen ? (
        <ManualReceiptCreateModal
          businessDate={businessDate}
          isSaving={isManualReceiptSaving}
          saveError={manualReceiptSaveError}
          text={receiptsText}
          editText={receiptsEditText}
          onClose={() => {
            setIsManualReceiptModalOpen(false);
            setManualReceiptSaveError("");
          }}
          onSubmit={handleCreateManualReceipt}
        />
      ) : null}
    </Container>
  );
}

function UnifiedInventoryDeductionPanel({
  preview,
  receipts,
  executeResult,
  isExecuting,
  canExecute,
  text,
  receiptText,
  onExecute,
  onRetryPreview,
}: {
  preview: UnifiedPreview;
  receipts: ReceiptItem[];
  executeResult: UnifiedExecuteResponse | null;
  isExecuting: boolean;
  canExecute: boolean;
  text: InventoryPreviewCopy;
  receiptText: SalesReceiptsViewText;
  onExecute: () => void;
  onRetryPreview: () => void;
}) {
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const executableReceipts = preview.receipts.filter(
    (receipt) => receipt.canExecute
  );
  const needsCheckReceipts = preview.receipts.filter(
    (receipt) => receipt.operationType === "needs_check"
  );
  const noOpReceipts = preview.receipts.filter(
    (receipt) => receipt.operationType === "no_op"
  );
  const executeLimitExceeded = executableReceipts.length > 30;
  const executeDisabled =
    !canExecute ||
    isExecuting ||
    executableReceipts.length === 0 ||
    executeLimitExceeded;
  const summaryItems = [
    [text.unified.executable, executableReceipts.length],
    [text.unified.initialApply, preview.summary.initialApplyCount],
    [text.unified.reprocessModified, preview.summary.reprocessModifiedCount],
    [text.unified.rollbackCanceled, preview.summary.rollbackCanceledCount],
    [text.unified.needsCheck, preview.summary.needsCheckCount],
    [text.unified.noOp, preview.summary.noOpCount],
  ] as const;

  return (
    <section style={inventoryPreviewPanelStyle}>
      <div style={inventoryPreviewHeaderStyle}>
        <div>
          <h2 style={inventoryPreviewTitleStyle}>{text.previewButton}</h2>
          <p style={inventoryPreviewDescriptionStyle}>
            {text.unified.executable} {formatNumber(executableReceipts.length)}
            {text.countSuffix}
          </p>
        </div>
        <button
          type="button"
          onClick={onRetryPreview}
          disabled={isExecuting}
          style={{
            ...inventoryApplyDisabledButtonStyle,
            cursor: isExecuting ? "not-allowed" : "pointer",
          }}
        >
          {text.unified.retryPreview}
        </button>
      </div>

      <div style={inventoryPreviewSummaryStyle}>
        {summaryItems.map(([label, value]) => (
          <div key={label} style={inventoryPreviewSummaryItemStyle}>
            <span>{label}</span>
            <strong>{formatNumber(value)}</strong>
          </div>
        ))}
      </div>

      <div style={inventoryBatchActionStyle}>
        <div>
          {executeLimitExceeded ? (
            <strong style={errorTextStyle}>{text.unified.limitExceeded}</strong>
          ) : executableReceipts.length === 0 ? (
            <span style={mutedTextStyle}>{text.unified.noExecutable}</span>
          ) : (
            <span style={mutedTextStyle}>
              {formatUnifiedExecuteButton(text, executableReceipts.length)}
            </span>
          )}
        </div>
        <div style={inventoryBatchButtonsStyle}>
          <button
            type="button"
            onClick={onExecute}
            disabled={executeDisabled}
            style={{
              ...(executeDisabled
                ? inventoryApplyDisabledButtonStyle
                : inventoryApplyButtonStyle),
            }}
          >
            {isExecuting
              ? text.unified.processing
              : formatUnifiedExecuteButton(text, executableReceipts.length)}
          </button>
        </div>
      </div>

      {executeResult?.summary ? (
        <div style={batchApplyResultStyle}>
          <div>
            <strong>{text.unified.resultTitle}</strong>
            <div style={batchValidationMetaStyle}>
              {text.unified.initialAppliedDone}{" "}
              {formatNumber(executeResult.summary.initialAppliedCount)}
              {text.countSuffix} · {text.unified.reprocessedDone}{" "}
              {formatNumber(executeResult.summary.reprocessedCount)}
              {text.countSuffix} · {text.unified.alreadyProcessedDone}{" "}
              {formatNumber(executeResult.summary.alreadyProcessedCount)}
              {text.countSuffix} · {text.unified.staleDone}{" "}
              {formatNumber(
                executeResult.summary.staleCount +
                  executeResult.summary.needsCheckCount +
                  executeResult.summary.notSupportedCount
              )}
              {text.countSuffix} · {text.unified.failedDone}{" "}
              {formatNumber(executeResult.summary.failedCount)}
              {text.countSuffix}
            </div>
            {executeResult.executionId ? (
              <span style={batchValidationMetaStyle}>
                {executeResult.executionId}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {executeResult?.results?.length ? (
        <details style={inventoryPreviewDetailsStyle} open>
          <summary style={inventoryPreviewSummaryTitleStyle}>
            {text.unified.resultTitle} {executeResult.results.length}
            {text.countSuffix}
          </summary>
          <div style={previewReceiptListStyle}>
            {executeResult.results.map((result) => {
              const receipt = receiptById.get(result.receiptId);
              const failureReason = getUnifiedFailureReasonLabel(
                result.failureReason,
                text
              );

              return (
                <div key={result.receiptId} style={previewReceiptStyle}>
                  <div style={previewReceiptHeaderRowStyle}>
                    <span style={previewReceiptMainStyle}>
                      <strong>
                        {receipt?.tableName
                          ? `${receiptText.table}: ${receipt.tableName}`
                          : result.receiptId}
                      </strong>
                      <span style={previewReceiptMetaStyle}>
                        {receipt?.refNo || result.receiptId} ·{" "}
                        {getUnifiedResultLabel(result.result, text)}
                      </span>
                    </span>
                    <span
                      style={{
                        ...previewStatusStyle,
                        ...getUnifiedOperationStyle(result.actualOperationType),
                      }}
                    >
                      {getUnifiedOperationLabel(result.actualOperationType, text)}
                    </span>
                  </div>
                  {failureReason ? (
                    <p style={previewLineErrorStyle}>{failureReason}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      <details style={inventoryPreviewDetailsStyle} open>
        <summary style={inventoryPreviewSummaryTitleStyle}>
          {text.unified.executable} {executableReceipts.length}
          {text.countSuffix}
        </summary>
        <div style={previewReceiptListStyle}>
          {executableReceipts.map((receipt) => (
            <UnifiedReceiptPreviewRow
              key={receipt.receiptId}
              receipt={receipt}
              salesReceipt={receiptById.get(receipt.receiptId)}
              text={text}
              receiptText={receiptText}
            />
          ))}
        </div>
      </details>

      {needsCheckReceipts.length > 0 ? (
        <details style={inventoryPreviewDetailsStyle}>
          <summary style={inventoryPreviewSummaryTitleStyle}>
            {text.unified.needsCheck} {needsCheckReceipts.length}
            {text.countSuffix}
          </summary>
          <div style={previewReceiptListStyle}>
            {needsCheckReceipts.map((receipt) => (
              <UnifiedReceiptPreviewRow
                key={receipt.receiptId}
                receipt={receipt}
                salesReceipt={receiptById.get(receipt.receiptId)}
                text={text}
                receiptText={receiptText}
              />
            ))}
          </div>
        </details>
      ) : null}

      {noOpReceipts.length > 0 ? (
        <details style={inventoryPreviewDetailsStyle}>
          <summary style={inventoryPreviewSummaryTitleStyle}>
            {text.unified.noOp} {noOpReceipts.length}
            {text.countSuffix}
          </summary>
          <div style={previewReceiptListStyle}>
            {noOpReceipts.map((receipt) => (
              <UnifiedReceiptPreviewRow
                key={receipt.receiptId}
                receipt={receipt}
                salesReceipt={receiptById.get(receipt.receiptId)}
                text={text}
                receiptText={receiptText}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function UnifiedReceiptPreviewRow({
  receipt,
  salesReceipt,
  text,
  receiptText,
}: {
  receipt: UnifiedPreviewReceipt;
  salesReceipt?: ReceiptItem;
  text: InventoryPreviewCopy;
  receiptText: SalesReceiptsViewText;
}) {
  const reprocessMode = getUnifiedReprocessMode(receipt, text);
  const reason = receipt.blockingReasons[0] || "";
  const actionableSalesLines = receipt.canExecute
    ? receipt.actionableSalesLines ?? []
    : [];

  return (
    <div style={previewReceiptStyle}>
      <div style={unifiedReceiptHeaderStyle}>
        <span style={previewReceiptMainStyle}>
          <span
            style={{
              ...previewStatusStyle,
              ...getUnifiedOperationStyle(receipt.operationType),
              alignSelf: "flex-start",
            }}
          >
            {getUnifiedOperationLabel(receipt.operationType, text)}
          </span>
          {actionableSalesLines.length > 0 ? (
            <div style={unifiedActionableItemsStyle}>
              <span style={unifiedActionableItemsLabelStyle}>
                {text.unified.actionableItems}:
              </span>
              {actionableSalesLines.length === 1 ? (
                <span style={unifiedActionableSingleItemStyle}>
                  {getActionableSalesLineLabel(actionableSalesLines[0])}
                </span>
              ) : (
                <ul style={unifiedActionableItemsListStyle}>
                  {actionableSalesLines.map((line) => (
                    <li
                      key={line.receiptLineId}
                      style={unifiedActionableItemStyle}
                    >
                      {getActionableSalesLineLabel(line)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          <strong>
            {salesReceipt?.tableName
              ? `${receiptText.table}: ${salesReceipt.tableName}`
              : receipt.refNo || salesReceipt?.refNo || receipt.receiptId}
          </strong>
          <span style={previewReceiptMetaStyle}>
            {salesReceipt?.refNo || receipt.refNo || receipt.receiptId} ·{" "}
            {formatTime(salesReceipt?.refDate ?? null)} ·{" "}
            {salesReceipt ? formatVnd(salesReceipt.finalAmount) : "-"}
          </span>
          <span style={previewReceiptMetaStyle}>
            {text.unified.actionableLine}{" "}
            {formatNumber(receipt.actionableLineCount)}
            {text.countSuffix} · {text.unified.activeDeduction}{" "}
            {formatNumber(receipt.activeDeductionCount)}
            {text.countSuffix}
            {reprocessMode ? ` · ${reprocessMode}` : ""}
          </span>
        </span>
      </div>
      {reason ? <p style={previewLineErrorStyle}>{reason}</p> : null}
    </div>
  );
}

function InventoryPreviewPanel({
  preview,
  receipts,
  selectedReceipts,
  batchApplyResult,
  isBatchApplying,
  canApplyInventory,
  text,
  receiptText,
  onApplyBatch,
  onSelectionChange,
}: {
  preview: InventoryDeductionPreview;
  receipts: ReceiptItem[];
  selectedReceipts: Record<number, boolean>;
  batchApplyResult: BatchApplyResult | null;
  isBatchApplying: boolean;
  canApplyInventory: boolean;
  text: InventoryPreviewCopy;
  receiptText: SalesReceiptsViewText;
  onApplyBatch: () => void;
  onSelectionChange: (
    receiptId: number,
    selectedForApply: boolean
  ) => void;
}) {
  const [expandedReceiptIds, setExpandedReceiptIds] = useState<
    Record<number, boolean>
  >({});
  const needsCheckDetails = getNeedsCheckDetails(preview, text);
  const visibleNeedsCheckDetails = needsCheckDetails.filter(
    ([label, value]) =>
      value > 0 && label !== text.detailStatus.incompleteRecipe
  );
  const needsCheckCount = Math.max(
    0,
    preview.summary.totalReceiptCount - preview.summary.readyCount
  );
  const summaryItems = [
    [text.total, preview.summary.totalReceiptCount],
    [text.canApply, preview.summary.readyCount],
    [text.needsCheck, needsCheckCount],
  ] as const;
  const selectedReceiptCount = preview.receipts.filter(
    (receipt) => selectedReceipts[receipt.receiptId] === true
  ).length;
  const kegTrackingProducts = preview.kegTrackingSummary?.products ?? [];
  const selectedApplyDisabled =
    selectedReceiptCount === 0 ||
    !canApplyInventory ||
    isBatchApplying ||
    Boolean(batchApplyResult);
  const receiptById = useMemo(
    () => new Map(receipts.map((receipt) => [receipt.id, receipt])),
    [receipts]
  );
  const receiptByRefNo = useMemo(
    () =>
      new Map(
        receipts
          .filter((receipt) => receipt.refNo)
          .map((receipt) => [receipt.refNo as string, receipt])
      ),
    [receipts]
  );

  return (
    <section style={inventoryPreviewPanelStyle}>
      <div style={inventoryPreviewHeaderStyle}>
        <div>
          <h2 style={inventoryPreviewTitleStyle}>{text.title}</h2>
          <p style={inventoryPreviewDescriptionStyle}>
            {text.description}
          </p>
        </div>
      </div>
      <div style={inventoryPreviewReadinessRowStyle}>
        <span
          style={{
            ...inventoryPreviewReadinessStyle,
            ...(preview.validationSummary.errorCount === 0
              ? inventoryPreviewReadyStyle
              : batchValidationWarningStyle),
          }}
          title={text.mappingTooltip}
        >
          {preview.validationSummary.errorCount === 0
            ? text.mappingReady
            : `${text.mappingNeedsCheck} ${formatNumber(
                preview.validationSummary.errorCount
              )}${text.countSuffix}`}
        </span>
      </div>

      <div style={inventoryBatchActionStyle}>
        <div style={inventoryBatchButtonsStyle}>
          <button
            type="button"
            style={{
              ...inventoryApplyButtonStyle,
              ...(selectedApplyDisabled ? inventoryApplyDisabledButtonStyle : null),
            }}
            disabled={selectedApplyDisabled}
            onClick={onApplyBatch}
          >
            {isBatchApplying
              ? text.applyProcessing
              : batchApplyResult
                ? text.applyDone
              : canApplyInventory
                  ? text.applyButton
                  : text.ownerMasterOnly}
          </button>
        </div>
      </div>

      {batchApplyResult ? (
        <div style={batchApplyResultStyle}>
          <div>
            <strong>{text.applyDone}</strong>
            <span style={batchValidationMetaStyle}>
              {text.receipt} {batchApplyResult.summary.appliedReceiptCount}
              {text.countSuffix} ·{" "}
              {text.deduction}{" "}
              {batchApplyResult.summary.appliedDeductionCount}
              {text.countSuffix} · {text.log}{" "}
              {batchApplyResult.summary.inventoryLogCount}
              {text.countSuffix}
            </span>
          </div>
          <div style={batchApplyInventoryListStyle}>
            {batchApplyResult.inventoryTotals.map((total) => (
              <span key={total.inventoryItemId}>
                {total.itemName || `#${total.inventoryItemId}`}:{" "}
                {formatNumber(total.previousQuantity)} →{" "}
                {formatNumber(total.newQuantity)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div style={inventoryPreviewSummaryStyle}>
        {summaryItems.map(([label, value]) => (
          <div key={label} style={inventoryPreviewSummaryItemStyle}>
            <span>{label}</span>
            <strong>{formatNumber(value)}</strong>
          </div>
        ))}
      </div>

      {visibleNeedsCheckDetails.length > 0 ? (
        <details style={inventoryPreviewDetailsStyle}>
          <summary style={inventoryPreviewSummaryTitleStyle}>
            {text.needsCheckDetails} · {text.details}
          </summary>
          <div style={inventoryCheckDetailListStyle}>
            {visibleNeedsCheckDetails.map(([label, value]) => (
              <div key={label} style={inventoryCheckDetailItemStyle}>
                <span>{label}</span>
                <strong>
                  {formatNumber(value)}
                  {text.countSuffix}
                </strong>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <details style={inventoryPreviewDetailsStyle} open>
        <summary style={inventoryPreviewSummaryTitleStyle}>
          {text.inventoryTotals} {preview.inventoryTotals.length}
          {text.itemSuffix}
        </summary>
        {preview.inventoryTotals.length > 0 ? (
          <div style={inventoryTotalListStyle}>
            {preview.inventoryTotals.map((total) => (
              <div
                key={total.inventoryItemId}
                style={{
                  ...inventoryTotalRowStyle,
                  ...(total.status === "insufficient_stock"
                    ? inventoryTotalInsufficientStyle
                    : null),
                }}
              >
                <strong style={inventoryTotalNameStyle}>
                  {getInventoryTotalName(total)}
                </strong>
                <span>{text.current} {formatNumber(total.currentQuantity)}</span>
                <span style={inventoryExpectedDeductionStyle}>
                  {text.expectedDeduction} {formatNumber(total.deductQuantity)}
                </span>
                <span style={inventoryAfterDeductionStyle}>
                  {text.afterDeduction} {formatNumber(total.afterQuantity)}
                </span>
                <span>
                  {text.receipt} {total.receiptCount} / {text.line}{" "}
                  {total.lineCount}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p style={inventoryPreviewEmptyStyle}>{text.noDeductionItems}</p>
        )}
      </details>

      {kegTrackingProducts.length > 0 ? (
        <details style={inventoryPreviewDetailsStyle} open>
          <summary style={inventoryPreviewSummaryTitleStyle}>
            {text.kegTrackingItems} {kegTrackingProducts.length}
            {text.countSuffix}
          </summary>
          <div style={kegTrackingPreviewListStyle}>
            {kegTrackingProducts.map((product) => (
              <div
                key={`${product.posProductId}:${product.inventoryItemId}`}
                style={kegTrackingPreviewItemStyle}
              >
                <strong style={kegTrackingPreviewNameStyle}>
                  {getKegTrackingProductName(product)}
                </strong>
                <span style={kegTrackingPreviewMetaStyle}>
                  {text.saleQuantity} {formatNumber(product.quantitySold)}
                </span>
                <span style={kegTrackingPreviewMetaStyle}>
                  {text.expectedUsage} {formatKegUsageMl(product.expectedUsageMl)}
                </span>
                <span style={kegTrackingPreviewBadgeStyle}>
                  {text.actualDeductionExcluded} · {text.kegTrackingOnly}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <details style={inventoryPreviewDetailsStyle}>
        <summary style={inventoryPreviewSummaryTitleStyle}>
          {text.receiptResults} {preview.receipts.length}
          {text.countSuffix}
        </summary>
        <div style={previewReceiptListStyle}>
          {preview.receipts.map((receipt) => {
            const partialDeduction = isPartialDeductionReceipt(receipt);
            const isExpanded = expandedReceiptIds[receipt.receiptId] === true;
            const { applicableCount, checkCount } = getReceiptLineCounts(receipt);
            const matchedReceipt =
              receiptById.get(receipt.receiptId) ||
              (receipt.refNo ? receiptByRefNo.get(receipt.refNo) : undefined);
            const paymentSummaryText = matchedReceipt
              ? getPaymentSummaryText(matchedReceipt.payments, receiptText)
              : "";
            const amount = matchedReceipt?.finalAmount ?? 0;
            const refDate = matchedReceipt?.refDate ?? receipt.refDate;
            const refNo =
              matchedReceipt?.refNo || receipt.refNo || `#${receipt.receiptId}`;
            const tableLabel = matchedReceipt?.tableName
              ? `${receiptText.table}: ${matchedReceipt.tableName}`
              : text.receipt;
            const selectionLabel = getPreviewReceiptSelectionLabel(
              receipt,
              text
            );
            return (
              <div key={receipt.receiptId} style={previewReceiptStyle}>
                <div style={previewReceiptHeaderRowStyle}>
                  <label style={previewReceiptSelectionStyle}>
                    <input
                      type="checkbox"
                      aria-label={`${receipt.refNo || receipt.receiptId} ${text.applyButton}`}
                      checked={selectedReceipts[receipt.receiptId] === true}
                      disabled={
                        receipt.status !== "ready" ||
                        Boolean(batchApplyResult)
                      }
                      onChange={(event) =>
                        onSelectionChange(
                          receipt.receiptId,
                          event.target.checked
                        )
                      }
                      style={previewReceiptCheckboxStyle}
                    />
                    <span
                      style={{
                        ...previewSelectionLabelStyle,
                        ...(receipt.status === "ready"
                          ? previewSelectionReadyStyle
                          : receipt.status === "already_applied"
                            ? previewSelectionNeutralStyle
                            : previewSelectionWarningStyle),
                      }}
                    >
                      {selectionLabel}
                    </span>
                  </label>
                  <button
                    type="button"
                    style={previewReceiptHeaderButtonStyle}
                    aria-expanded={isExpanded}
                    onClick={() =>
                      setExpandedReceiptIds((current) => ({
                        ...current,
                        [receipt.receiptId]: !current[receipt.receiptId],
                      }))
                    }
                  >
                    <span style={previewReceiptMainStyle}>
                      <span style={receiptTopLineStyle}>
                        <strong style={receiptNoStyle}>{tableLabel}</strong>
                        <span
                          style={{
                            ...previewStatusStyle,
                            ...(partialDeduction
                              ? batchValidationWarningStyle
                              : receipt.status === "ready"
                                ? previewStatusReadyStyle
                                : receipt.status === "skipped"
                                  ? previewStatusSkippedStyle
                                  : receipt.status === "already_applied"
                                    ? previewStatusAlreadyAppliedStyle
                                    : previewStatusBlockedStyle),
                          }}
                        >
                          {getInventoryPreviewStatusLabel(receipt, text)}
                        </span>
                      </span>
                      <span style={receiptMetaLineStyle}>
                        {refNo}
                        {paymentSummaryText ? ` · ${paymentSummaryText}` : ""}
                      </span>
                      <span style={previewReceiptMetaStyle}>
                        {text.availableCount} {formatNumber(applicableCount)} ·{" "}
                        {text.checkCount} {formatNumber(checkCount)}
                      </span>
                    </span>
                    <span style={previewReceiptAmountWrapStyle}>
                      <span style={receiptTimeStyle}>{formatTime(refDate)}</span>
                      <strong style={amountStyle}>
                        {matchedReceipt ? formatVnd(amount) : "-"}
                      </strong>
                      <span style={chevronStyle}>{isExpanded ? "⌃" : "⌄"}</span>
                    </span>
                  </button>
                </div>

                {isExpanded ? (
                  <>
                    <div style={previewLineListStyle}>
                    {receipt.lines.map((line, lineIndex) => {
                      const statusInfo = getPreviewLineStatusInfo(
                        line,
                        receipt,
                        text
                      );
                      const comboParentCode =
                        typeof line.mappingSnapshot?.comboParentCode ===
                        "string"
                          ? line.mappingSnapshot.comboParentCode
                          : null;
                      const comboParentName =
                        typeof line.mappingSnapshot?.comboParentName ===
                        "string"
                          ? line.mappingSnapshot.comboParentName
                          : null;
                      const comboChildIndex =
                        typeof line.mappingSnapshot?.comboChildIndex ===
                        "number"
                          ? line.mappingSnapshot.comboChildIndex
                          : lineIndex;
                      const isComboLine = line.lineType.startsWith("combo_");
                      const quantityLabel = `${
                        isComboLine
                          ? `${text.comboDeduction} · `
                          : line.isOption
                            ? `${text.option} · `
                            : ""
                      }${text.saleQuantity} ${formatNumber(
                        line.quantitySold
                      )}`;
                      return (
                        <div
                          key={`${line.receiptLineId}-${comboChildIndex}-${line.lineType}`}
                          style={{
                            ...previewLineStyle,
                            ...(line.isOption ? previewOptionLineStyle : null),
                          }}
                        >
                          <div style={previewLineTitleStyle}>
                            <div style={previewLineMainStyle}>
                              <span
                                style={{
                                  ...previewLineBadgeStyle,
                                  ...getPreviewLineBadgeStyle(statusInfo.tone),
                                }}
                              >
                                {statusInfo.label}
                              </span>
                              <strong style={previewLineNameStyle}>
                                {line.itemName || `#${line.receiptLineId}`}
                              </strong>
                            </div>
                            <span style={previewLineQuantityStyle}>
                              {quantityLabel}
                            </span>
                          </div>
                          {isComboLine &&
                          (comboParentCode || comboParentName) ? (
                            <p style={previewLineErrorStyle}>
                              {text.combo}:{" "}
                              {comboParentCode ? `[${comboParentCode}] ` : ""}
                              {comboParentName || ""}
                            </p>
                          ) : null}
                          {line.deductions.map((deduction) => {
                            const lineAfterQuantity =
                              deduction.currentQuantity -
                              deduction.deductQuantity;
                            return (
                              <div
                                key={`${line.receiptLineId}-${deduction.inventoryItemId}`}
                                style={previewDeductionStyle}
                              >
                                <span>{deduction.inventoryItemName}</span>
                                <strong>
                                  -{formatNumber(deduction.deductQuantity)}
                                </strong>
                                <span>
                                  {formatNumber(deduction.currentQuantity)} →{" "}
                                  {formatNumber(lineAfterQuantity)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </details>

    </section>
  );
}

void InventoryPreviewPanel;

function ReceiptList({
  isLoading,
  text,
  editText,
  receipts,
  expandedReceiptId,
  detailByReceiptId,
  detailLoadingId,
  detailErrorByReceiptId,
  editSavingId,
  editErrorByReceiptId,
  posCheckingIds,
  posCheckErrorByReceiptId,
  autoOpenEditReceiptId,
  deductionText,
  deductionPreviewByReceiptId,
  unifiedPreviewByReceiptId,
  onToggleReceipt,
  onSaveEdit,
  onRequestEdit,
}: {
  isLoading: boolean;
  text: SalesReceiptsViewText;
  editText: SalesReceiptsEditViewText;
  receipts: ReceiptItem[];
  expandedReceiptId: number | null;
  detailByReceiptId: Record<number, ReceiptDetailResponse>;
  detailLoadingId: number | null;
  detailErrorByReceiptId: Record<number, string>;
  editSavingId: number | null;
  editErrorByReceiptId: Record<number, string>;
  posCheckingIds: Set<number>;
  posCheckErrorByReceiptId: Record<number, string>;
  autoOpenEditReceiptId: number | null;
  deductionText: InventoryPreviewCopy;
  deductionPreviewByReceiptId: Map<
    number,
    InventoryDeductionPreview["receipts"][number]
  >;
  unifiedPreviewByReceiptId: Map<number, UnifiedPreviewReceipt>;
  onToggleReceipt: (receiptId: number) => void;
  onSaveEdit: (input: SaveReceiptEditInput) => void;
  onRequestEdit: (receipt: ReceiptItem) => void;
}) {
  if (isLoading) {
    return (
      <EmptyState
        title={text.loading}
        text={text.detailLoading}
      />
    );
  }

  if (receipts.length === 0) {
    return (
      <EmptyState
        title={text.noReceipts}
        text={text.selectedBusinessDateNoReceipts}
      />
    );
  }

  return (
    <div style={receiptListStyle}>
      {receipts.map((receipt, index) => {
        const isExpanded = expandedReceiptId === receipt.id;

        return (
          <div
            key={receipt.id}
            style={{
              ...receiptItemWrapStyle,
              ...(index % 2 === 1 ? receiptItemAlternateStyle : null),
              ...(isExpanded ? receiptItemExpandedStyle : null),
            }}
          >
            <ReceiptRow
              text={text}
              receipt={receipt}
              isExpanded={isExpanded}
              deductionText={deductionText}
              deductionPreview={deductionPreviewByReceiptId.get(receipt.id)}
              unifiedPreview={unifiedPreviewByReceiptId.get(receipt.id)}
              onToggle={() => onToggleReceipt(receipt.id)}
            />
            {isExpanded ? (
              <ReceiptDropdown
                text={text}
                editText={editText}
                detail={detailByReceiptId[receipt.id]}
                isLoading={detailLoadingId === receipt.id}
                errorMessage={detailErrorByReceiptId[receipt.id] || ""}
                isEditSaving={editSavingId === receipt.id}
                editErrorMessage={editErrorByReceiptId[receipt.id] || ""}
                isPosChecking={posCheckingIds.has(receipt.id)}
                posCheckError={posCheckErrorByReceiptId[receipt.id] || ""}
                autoOpenEdit={autoOpenEditReceiptId === receipt.id}
                deductionText={deductionText}
                deductionPreview={deductionPreviewByReceiptId.get(receipt.id)}
                unifiedPreview={unifiedPreviewByReceiptId.get(receipt.id)}
                onSaveEdit={onSaveEdit}
                onRequestEdit={() => onRequestEdit(receipt)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ReceiptRow({
  text,
  receipt,
  isExpanded,
  deductionText,
  deductionPreview,
  unifiedPreview,
  onToggle,
}: {
  text: SalesReceiptsViewText;
  receipt: ReceiptItem;
  isExpanded: boolean;
  deductionText: InventoryPreviewCopy;
  deductionPreview?: InventoryDeductionPreview["receipts"][number];
  unifiedPreview?: UnifiedPreviewReceipt;
  onToggle: () => void;
}) {
  const statusLabel = getPaymentStatusLabel(receipt, text);
  const paymentSummaryText = getPaymentSummaryText(receipt.payments, text);
  const isCanceled =
    receipt.isCanceled ||
    receipt.paymentStatus === 4 ||
    receipt.paymentStatus === 5;
  const lineCountLabel = getReceiptLineCountLabel(text);
  const statusBadgeToneStyle =
    receipt.paymentStatus === 1
      ? paymentPendingBadgeStyle
      : isCanceled
        ? canceledBadgeStyle
        : paidBadgeStyle;
  const deductionBadge = getReceiptListDeductionBadge(
    deductionPreview,
    deductionText,
    unifiedPreview
  );

  return (
    <button type="button" onClick={onToggle} style={receiptRowButtonStyle}>
      <span style={receiptMainStyle}>
        <span style={receiptTopLineStyle}>
          <strong style={receiptNoStyle}>
            {text.table}: {receipt.tableName || "-"}
          </strong>
          <span style={receiptStatusGroupStyle}>
            <span
              style={{
                ...statusBadgeStyle,
                ...statusBadgeToneStyle,
              }}
            >
              {statusLabel}
            </span>
            {receipt.isModified && !isCanceled ? (
              <span style={{ ...statusBadgeStyle, ...modifiedBadgeStyle }}>
                {text.modified}
              </span>
            ) : null}
            {receipt.refId.startsWith("manual-") ? (
              <span style={{ ...statusBadgeStyle, ...manualBadgeStyle }}>
                {text.manualReceiptBadge}
              </span>
            ) : null}
          </span>
        </span>
        <span style={receiptMetaLineStyle}>
          {receipt.refNo || receipt.refId}
          {paymentSummaryText ? ` · ${paymentSummaryText}` : ""}
        </span>
        <span style={receiptMetaLineStyle}>
          {lineCountLabel} {formatNumber(receipt.lineCount)}{text.productCountSuffix} · {text.optionItems}{" "}
          {formatNumber(receipt.optionLineCount)}{text.optionCountSuffix}
        </span>
      </span>

      <span style={receiptAmountWrapStyle}>
        <span style={receiptTimeStyle}>{formatTime(receipt.refDate)}</span>
        <strong style={receiptListAmountStyle}>
          {formatVnd(receipt.finalAmount)}
        </strong>
        <span style={receiptAmountLineStyle}>
          {deductionBadge ? (
            <span
              style={{
                ...receiptDeductionBadgeStyle,
                ...deductionBadge.toneStyle,
              }}
            >
              {deductionBadge.label}
            </span>
          ) : null}
          <span style={chevronStyle}>{isExpanded ? "⌃" : "⌄"}</span>
        </span>
      </span>
    </button>
  );
}

function ReceiptDropdown({
  text,
  editText,
  detail,
  isLoading,
  errorMessage,
  isEditSaving,
  editErrorMessage,
  isPosChecking,
  posCheckError,
  autoOpenEdit,
  deductionText,
  deductionPreview,
  unifiedPreview,
  onSaveEdit,
  onRequestEdit,
}: {
  text: SalesReceiptsViewText;
  editText: SalesReceiptsEditViewText;
  detail?: ReceiptDetailResponse;
  isLoading: boolean;
  errorMessage: string;
  isEditSaving: boolean;
  editErrorMessage: string;
  isPosChecking: boolean;
  posCheckError: string;
  autoOpenEdit: boolean;
  deductionText: InventoryPreviewCopy;
  deductionPreview?: InventoryDeductionPreview["receipts"][number];
  unifiedPreview?: UnifiedPreviewReceipt;
  onSaveEdit: (input: SaveReceiptEditInput) => void;
  onRequestEdit: () => void;
}) {
  if (isLoading) {
    return (
      <div style={dropdownStyle}>
        <EmptyState title={text.loading} text={text.detailLoading} />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div style={dropdownStyle}>
        <EmptyState title={text.error} text={errorMessage} />
      </div>
    );
  }

  if (!detail?.receipt) {
    return null;
  }
  const receipt = detail.receipt;
  const workflowBadge = getReceiptListDeductionBadge(
    deductionPreview,
    deductionText,
    unifiedPreview
  );
  const payments = detail.payments || [];
  const activeLines = (detail.lines || []).filter(
    (line) => line.isExcluded !== true
  );
  const activeLineRefDetailIds = getReceiptLineRefDetailIds(activeLines);
  const hasOptionLines =
    detail.hasOptionLines === true ||
    activeLines.some((line) =>
      isExistingOptionLine(line, activeLineRefDetailIds)
    );
  const previewLinesByReceiptLineId = new Map<
    number,
    InventoryDeductionPreview["receipts"][number]["lines"]
  >();
  for (const previewLine of deductionPreview?.lines ?? []) {
    const rows = previewLinesByReceiptLineId.get(previewLine.receiptLineId) ?? [];
    rows.push(previewLine);
    previewLinesByReceiptLineId.set(previewLine.receiptLineId, rows);
  }

  // 원본 세금 표시: taxSummary는 API의 original_tax_summary/vat_amount 기준
  const taxRows = detail.taxSummary?.taxByRate || [];
  const originalTotalTaxAmount = toFiniteNumber(
    detail.taxSummary?.totalTaxAmount ?? receipt.vatAmount
  );

  const taxSavingAmount = toFiniteNumber(detail.taxSummary?.taxSavingAmount);
  const amountDifferenceAmount = toFiniteNumber(
    detail.taxSummary?.amountDifferenceAmount
  );

  const showCashExtra =
    hasCashPayment(payments) &&
    (detail.receipt.receiveAmount !== null || detail.receipt.returnAmount !== null);

  return (
    <div style={dropdownStyle}>
      {workflowBadge ? (
        <span
          style={{
            ...previewStatusStyle,
            ...workflowBadge.toneStyle,
            alignSelf: "flex-start",
          }}
        >
          {workflowBadge.label}
        </span>
      ) : null}
      <DetailSection title={text.salesItems}>
        <div style={lineListStyle}>
          {activeLines.map((line) => {
            const isOption = isExistingOptionLine(
              line,
              activeLineRefDetailIds
            );
            const lineTotalAmount = line.finalAmount || line.amount;
            const lineStatusInfo = deductionPreview
              ? getReceiptDetailLineStatusInfo(
                  previewLinesByReceiptLineId.get(line.id) ?? [],
                  deductionPreview,
                  deductionText
                )
              : null;

            return (
              <div
                key={line.id}
                style={{
                  ...lineRowStyle,
                  ...(isOption ? optionLineRowStyle : null),
                }}
              >
                <div style={lineTitleRowStyle}>
                  <span
                    style={{
                      ...lineNameStyle,
                      ...(isOption ? optionLineNameStyle : null),
                    }}
                  >
                    {getLineDisplayName(line, text)}
                  </span>
                  {isOption ? <span style={optionBadgeStyle}>{text.optionItems}</span> : null}
                </div>
                <span
                  style={{
                    ...lineSummaryStyle,
                    ...(isOption ? optionLineSummaryStyle : null),
                  }}
                >
                  <span style={lineSummaryLeftStyle}>
                    <span>{text.quantity} {formatNumber(line.quantity)}</span>
                    {lineStatusInfo ? (
                      <span
                        style={{
                          ...receiptLineDeductionBadgeStyle,
                          ...getPreviewLineBadgeStyle(lineStatusInfo.tone),
                        }}
                      >
                        {lineStatusInfo.label}
                      </span>
                    ) : null}
                  </span>
                  <strong style={lineSummaryAmountStyle}>
                    {formatVnd(lineTotalAmount)}
                  </strong>
                </span>
              </div>
            );
          })}
        </div>
      </DetailSection>

      <DetailSection title={text.total}>
        <div style={miniListStyle}>
          <div style={miniRowStyle}>
            <span style={miniLabelStyle}>{text.salesAmount}</span>
            <strong style={miniValueStyle}>{formatVnd(detail.receipt.totalAmount)}</strong>
          </div>
          <div style={miniRowStyle}>
            <span style={miniLabelStyle}>{text.totalTax}</span>
            <strong style={miniValueStyle}>{formatVnd(originalTotalTaxAmount)}</strong>
          </div>
          {detail.receipt.taxOverrideMode ? (
            <div style={miniRowStyle}>
              <span style={miniLabelStyle}>VAT</span>
              <strong style={miniValueStyle}>
                {detail.receipt.taxOverrideMode === "exclude_all"
                  ? editText.vatExclude
                  : editText.vatApply}
              </strong>
            </div>
          ) : null}
          {taxRows.map((tax) => (
            <div key={tax.taxRate} style={miniRowStyle}>
              <span style={miniLabelStyle}>{text.vat} {formatNumber(tax.taxRate)}%</span>
              <strong style={miniValueStyle}>{formatVnd(tax.taxAmount)}</strong>
              <span style={lineCountStyle}>
                {formatNumber(tax.lineCount)}{text.productCountSuffix}
              </span>
            </div>
          ))}
          <div style={miniRowStyle}>
            <span style={miniLabelStyle}>{text.totalPaymentAmount}</span>
            <strong style={miniValueStyle}>{formatVnd(detail.receipt.finalAmount)}</strong>
          </div>
        </div>

        <div style={paymentBlockStyle}>
          <span style={paymentBlockTitleStyle}>{text.actualPaid}</span>
          {payments.length > 0 ? (
            <div style={miniListStyle}>
              {payments.map((payment) => (
                <div key={payment.id} style={miniRowStyle}>
                  <span style={miniLabelStyle}>
                    {getPaymentIcon(payment)} {getPaymentLabel(payment, text)}
                  </span>
                  <strong style={miniValueStyle}>{formatVnd(payment.amount)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p style={mutedTextStyle}>{text.noPaymentData}</p>
          )}
        </div>

        {showCashExtra ? (
          <div style={cashExtraStyle}>
            {detail.receipt.receiveAmount !== null ? (
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.receivedAmount}</span>
                <strong style={miniValueStyle}>
                  {formatVnd(detail.receipt.receiveAmount ?? 0)}
                </strong>
              </div>
            ) : null}
            {detail.receipt.returnAmount !== null ? (
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.changeAmount}</span>
                <strong style={miniValueStyle}>
                  {formatVnd(detail.receipt.returnAmount ?? 0)}
                </strong>
              </div>
            ) : null}
          </div>
        ) : null}
      </DetailSection>

      <ReceiptEditPanel
        key={`${receipt.id}-${receipt.modifiedAt || "original"}-${receipt.paymentStatus}-${receipt.isCanceled}`}
        text={editText}
        receipt={receipt}
        lines={activeLines}
        payments={payments}
        taxSavingAmount={taxSavingAmount}
        amountDifferenceAmount={amountDifferenceAmount}
        hasOptionLines={hasOptionLines}
        isSaving={isEditSaving}
        errorMessage={editErrorMessage}
        isPosChecking={isPosChecking}
        posCheckError={posCheckError}
        initialEditing={autoOpenEdit}
        onRequestEdit={onRequestEdit}
        onSave={(values) =>
          onSaveEdit({
            receiptId: receipt.id,
            ...values,
          })
        }
      />
    </div>
  );
}

function ReceiptEditPanel({
  text,
  receipt,
  lines,
  payments,
  taxSavingAmount,
  amountDifferenceAmount,
  hasOptionLines,
  isSaving,
  errorMessage,
  isPosChecking,
  posCheckError,
  initialEditing,
  onRequestEdit,
  onSave,
}: {
  text: SalesReceiptsEditViewText;
  receipt: ReceiptDetail;
  lines: LineDetail[];
  payments: PaymentDetail[];
  taxSavingAmount: number;
  amountDifferenceAmount: number;
  hasOptionLines: boolean;
  isSaving: boolean;
  errorMessage: string;
  isPosChecking: boolean;
  posCheckError: string;
  initialEditing: boolean;
  onRequestEdit: () => void;
  onSave: (values: Omit<SaveReceiptEditInput, "receiptId">) => void;
}) {
  const [isEditing, setIsEditing] = useState(initialEditing === true);
  const receiptLineRefDetailIds = getReceiptLineRefDetailIds(lines);
  const isReceiptCanceled =
    receipt.isCanceled ||
    receipt.paymentStatus === 4 ||
    receipt.paymentStatus === 5;

  function handleEditClick() {
    if (receipt.paymentStatus === 3 && !isReceiptCanceled) {
      setIsEditing(true);
      return;
    }

    onRequestEdit();
  }
  const [draftLines, setDraftLines] = useState<ReceiptDraftLine[]>(() =>
    lines
      .filter(
        (line) =>
          line.isExcluded !== true &&
          !isExistingOptionLine(line, receiptLineRefDetailIds)
      )
      .map((line) => ({
        id: line.id,
        refDetailId: line.refDetailId,
        itemName: line.itemName || "",
        unitName: line.unitName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
        finalAmount: line.finalAmount,
        taxRate: line.taxRate,
        mode: "update" as const,
      }))
  );
  const existingOptionLines = lines.filter(
    (line) =>
      line.isExcluded !== true &&
      isExistingOptionLine(line, receiptLineRefDetailIds)
  );
  const [newLines, setNewLines] = useState<NewDraftLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    hasCashPayment(payments) ? "cash" : "other"
  );
  const [cashReceivedAmount, setCashReceivedAmount] = useState(
    receipt.receiveAmount ?? receipt.finalAmount
  );
  const [taxOverrideMode, setTaxOverrideMode] = useState<"apply" | "exclude_all">(
    receipt.taxOverrideMode ?? "apply"
  );
  const [finalAmountInput, setFinalAmountInput] = useState(
    String(receipt.finalAmountOverride ?? receipt.calculatedFinalAmount ?? receipt.finalAmount)
  );
  const [finalAmountTouched, setFinalAmountTouched] = useState(
    receipt.finalAmountOverride !== null
  );
  const [note, setNote] = useState(receipt.modificationNote || "");
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<PosProduct[]>([]);
  const [isProductSearching, setIsProductSearching] = useState(false);
  const [productSearchError, setProductSearchError] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<PosProduct | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, PosProductOption>
  >({});
  const [newProductQuantity, setNewProductQuantity] = useState(1);

  useEffect(() => {
    const query = productQuery.trim();
    const controller = new AbortController();

    if (!isEditing || query.length < 1) {
      setProductResults([]);
      setProductSearchError("");
      setIsProductSearching(false);
      return () => controller.abort();
    }

    async function fetchProducts() {
      setIsProductSearching(true);
      try {
        const res = await fetch(
          `/api/pos/products?query=${encodeURIComponent(query)}&includeOptions=1`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        const result = (await res.json()) as PosProductsResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || text.productSearchFailed);
        }

        setProductResults(result.products || []);
        setProductSearchError("");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProductSearchError(
          error instanceof Error ? error.message : text.productSearchFailed
        );
        setProductResults([]);
      } finally {
        if (!controller.signal.aborted) setIsProductSearching(false);
      }
    }

    fetchProducts();
    return () => controller.abort();
  }, [isEditing, productQuery, text.productSearchFailed]);

  const activeDraftLineTotals = draftLines
    .filter((line) => line.mode !== "delete")
    .map((line) => ({
      finalAmount: calculateLineFinalAmount({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
      }),
      taxRate: line.taxRate,
    }));
  const existingOptionLineTotals = existingOptionLines.flatMap((line) => {
    const parentLine = line.parentRefDetailId
      ? draftLines.find(
          (candidate) => candidate.refDetailId === line.parentRefDetailId
        )
      : null;

    if (parentLine?.mode === "delete") return [];

    return [
      {
        finalAmount: calculateLineFinalAmount({
          quantity: parentLine?.quantity ?? line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
        }),
        taxRate: line.taxRate,
      },
    ];
  });
  const newDraftLineTotals = newLines.map((line) => ({
    finalAmount: calculateLineFinalAmount({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    }),
    taxRate: line.taxRate,
  }));
  const draftLineTotals = [
    ...activeDraftLineTotals,
    ...existingOptionLineTotals,
    ...newDraftLineTotals,
  ];
  const draftSalesSubtotal = draftLineTotals.reduce(
    (sum, line) => sum + line.finalAmount,
    0
  );
  const rawDraftAdjustedTaxAmount = draftLineTotals.reduce(
    (sum, line) => sum + calculateLineTaxAmount(line.finalAmount, line.taxRate),
    0
  );
  const draftAdjustedTaxAmount = taxOverrideMode === "exclude_all" ? 0 : rawDraftAdjustedTaxAmount;
  const draftCalculatedTotal = draftSalesSubtotal + draftAdjustedTaxAmount;
  const parsedFinalAmount = Number(finalAmountInput);
  const finalAmountInvalid =
    finalAmountInput.trim() === "" ||
    !Number.isSafeInteger(parsedFinalAmount) ||
    parsedFinalAmount < 0 ||
    parsedFinalAmount > 999999999999;
  const draftPaymentTotal = finalAmountTouched && !finalAmountInvalid
    ? parsedFinalAmount
    : draftCalculatedTotal;
  const manualAdjustmentAmount = draftPaymentTotal - draftCalculatedTotal;
  const returnAmount =
    paymentMethod === "cash"
      ? Math.max(0, cashReceivedAmount - draftPaymentTotal)
      : 0;
  const cashPaymentInvalid =
    paymentMethod === "cash" &&
    (!Number.isFinite(cashReceivedAmount) ||
      cashReceivedAmount < draftPaymentTotal);
  const saveDisabled = isSaving || draftSalesSubtotal <= 0 || cashPaymentInvalid || finalAmountInvalid;

  useEffect(() => {
    if (!finalAmountTouched) setFinalAmountInput(String(draftCalculatedTotal));
  }, [draftCalculatedTotal, finalAmountTouched]);

  function updateLine(index: number, nextLine: Partial<ReceiptDraftLine>) {
    setDraftLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...nextLine } : line
      )
    );
  }

  function removeLine(index: number) {
    setDraftLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, mode: "delete" } : line
      )
    );
  }

  function restoreLine(index: number) {
    updateLine(index, { mode: "update" });
  }

  function addSelectedProduct() {
    if (!selectedProduct || newProductQuantity <= 0) return;

    const clientId = `manual-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const optionLines = Object.entries(selectedOptions).map(
      ([optionGroupId, option], optionIndex): NewDraftLine => ({
        mode: "create",
        clientId: `${clientId}-option-${optionIndex + 1}`,
        parentClientId: clientId,
        productId: null,
        itemCode: option.code,
        itemName: option.name,
        unitName: selectedProduct.unitName,
        unitPrice: option.unitPrice,
        quantity: newProductQuantity,
        taxRate: option.taxRate ?? selectedProduct.taxRate ?? null,
        taxRateSource: selectedProduct.taxRateSource ?? null,
        isOption: true,
        refDetailType: 2,
        inventoryItemType: 6,
        additionId: option.id,
        optionGroupName:
          selectedProduct.optionGroups?.find(
            (group) => group.id === optionGroupId
          )?.name ?? optionGroupId,
        rawJson: option.raw,
      })
    );

    setNewLines((current) => [
      ...current,
      {
        mode: "create",
        clientId,
        parentClientId: null,
        productId: selectedProduct.id,
        itemCode: selectedProduct.itemCode,
        itemName: selectedProduct.itemName,
        unitName: selectedProduct.unitName,
        unitPrice: selectedProduct.unitPrice,
        quantity: newProductQuantity,
        taxRate: selectedProduct.taxRate ?? null,
        taxRateSource: selectedProduct.taxRateSource ?? null,
        isOption: false,
        refDetailType: 1,
        inventoryItemType: selectedProduct.itemType ?? null,
        additionId: null,
        optionGroupName: null,
        rawJson: null,
      },
      ...optionLines,
    ]);
    setSelectedProduct(null);
    setSelectedOptions({});
    setProductQuery("");
    setProductResults([]);
    setNewProductQuantity(1);
  }

  function resetDraft() {
    setDraftLines(
      lines
        .filter(
          (line) =>
            line.isExcluded !== true &&
            !isExistingOptionLine(line, receiptLineRefDetailIds)
        )
        .map((line) => ({
          id: line.id,
          refDetailId: line.refDetailId,
          itemName: line.itemName || "",
          unitName: line.unitName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
          finalAmount: line.finalAmount,
          taxRate: line.taxRate,
          mode: "update" as const,
        }))
    );
    setNewLines([]);
    setPaymentMethod(hasCashPayment(payments) ? "cash" : "other");
    setCashReceivedAmount(receipt.receiveAmount ?? receipt.finalAmount);
    setTaxOverrideMode(receipt.taxOverrideMode ?? "apply");
    setFinalAmountInput(String(receipt.finalAmountOverride ?? receipt.calculatedFinalAmount ?? receipt.finalAmount));
    setFinalAmountTouched(receipt.finalAmountOverride !== null);
    setNote(receipt.modificationNote || "");
    setSelectedProduct(null);
    setSelectedOptions({});
    setProductQuery("");
    setProductResults([]);
    setIsEditing(false);
  }

  function saveDraft() {
    const existingLines: ReceiptEditLine[] = draftLines.map((line) =>
      line.mode === "delete"
        ? {
          id: line.id,
          mode: "delete",
        }
        : {
          id: line.id,
          mode: "update",
          quantity: Number(line.quantity),
        }
    );
    const createLines: ReceiptEditLine[] = newLines.map((line) => ({
      ...line,
      quantity: Number(line.quantity),
    }));

    if ([...existingLines, ...createLines].length === 0) return;
    if (saveDisabled) return;

    onSave({
      lines: [...existingLines, ...createLines],
      paymentMethod,
      cashReceivedAmount: paymentMethod === "cash" ? cashReceivedAmount : null,
      note,
      taxOverrideMode,
      finalAmountOverride:
        finalAmountTouched && parsedFinalAmount !== draftCalculatedTotal
          ? parsedFinalAmount
          : null,
      expectedRevision: receipt.revision,
      requestId: crypto.randomUUID(),
    });
  }

  return (
    <DetailSection title={text.manage}>
      <div style={editPanelStyle}>
        <div style={editSummaryStyle}>
          <strong style={miniValueStyle}>
            {text.taxSaving}:{" "}
            {formatVnd(taxSavingAmount)}
          </strong>
          <strong style={miniValueStyle}>
            {text.amountDifference}:{" "}
            {formatVnd(amountDifferenceAmount)}
          </strong>
        </div>

        {!isEditing ? (
          <>
            {hasOptionLines ? (
              <p style={mutedTextStyle}>{text.existingOptionReadOnlyNotice}</p>
            ) : null}
            {posCheckError ? (
              <p style={errorTextStyle}>{posCheckError}</p>
            ) : null}
            <button
              type="button"
              onClick={handleEditClick}
              disabled={isPosChecking}
              style={editButtonStyle}
            >
              {isPosChecking ? text.posChecking : text.title}
            </button>
          </>
        ) : (
          <>
            {hasOptionLines ? (
              <p style={existingOptionNoticeStyle}>
                {text.existingOptionReadOnlyNotice}
              </p>
            ) : null}
            <div style={editLineListStyle}>
              {draftLines.map((line, index) => {
                const linkedOptions = line.refDetailId
                  ? existingOptionLines.filter(
                      (option) =>
                        option.parentRefDetailId === line.refDetailId
                    )
                  : [];

                return (
                  <div key={line.id} style={existingLineGroupStyle}>
                    <div
                      style={{
                        ...editLineRowStyle,
                        ...(line.mode === "delete"
                          ? deletedEditLineRowStyle
                          : null),
                      }}
                    >
                      <span style={editLineNameStyle}>{line.itemName}</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(index, {
                            quantity: Math.max(
                              0,
                              Number(event.target.value)
                            ),
                          })
                        }
                        style={editNumberInputStyle}
                        disabled={isSaving || line.mode === "delete"}
                      />
                      <strong style={miniValueStyle}>
                        {formatVnd(
                          calculateLineFinalAmount({
                            quantity: line.quantity,
                            unitPrice: line.unitPrice,
                            discountAmount: line.discountAmount,
                          })
                        )}
                      </strong>
                      <button
                        type="button"
                        onClick={() =>
                          line.mode === "delete"
                            ? restoreLine(index)
                            : removeLine(index)
                        }
                        disabled={isSaving}
                        style={deleteLineButtonStyle}
                      >
                        {line.mode === "delete" ? text.restore : text.delete}
                      </button>
                    </div>
                    {linkedOptions.map((option) => {
                      const optionQuantity = line.quantity;
                      const optionFinalAmount = calculateLineFinalAmount({
                        quantity: optionQuantity,
                        unitPrice: option.unitPrice,
                        discountAmount: option.discountAmount,
                      });

                      return (
                        <div
                          key={option.id}
                          style={{
                            ...existingOptionReadOnlyRowStyle,
                            ...(line.mode === "delete"
                              ? deletedEditLineRowStyle
                              : null),
                          }}
                        >
                          <span style={editLineNameStyle}>
                            {text.optionItems} · {option.itemName}
                          </span>
                          <span style={existingOptionMetaStyle}>
                            {formatNumber(optionQuantity)}
                          </span>
                          <span style={existingOptionMetaStyle}>
                            {formatVnd(option.unitPrice)}
                          </span>
                          <strong style={miniValueStyle}>
                            {formatVnd(optionFinalAmount)}
                          </strong>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div style={productSearchStyle}>
              <span style={reviewCurrentStatusStyle}>{text.addItem}</span>
              <input
                value={productQuery}
                onChange={(event) => setProductQuery(event.target.value)}
                placeholder={text.searchProductPlaceholder}
                style={editNameInputStyle}
                disabled={isSaving}
              />
              {productResults.length > 0 ? (
                <div style={productResultListStyle}>
                  {productResults.map((product) => (
                    <button
                      type="button"
                      key={product.id}
                      onClick={() => {
                        setSelectedProduct(product);
                        setSelectedOptions({});
                      }}
                      style={{
                        ...productResultButtonStyle,
                        ...(selectedProduct?.id === product.id
                          ? productResultButtonSelectedStyle
                          : null),
                      }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = "#111827";
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background =
                          selectedProduct?.id === product.id
                            ? "#111827"
                            : "#1f2937";
                      }}
                    >
                      <span style={productResultNameStyle}>{product.itemName}</span>
                      <strong style={productResultPriceStyle}>
                        {formatVnd(product.unitPrice)}
                      </strong>
                    </button>
                  ))}
                </div>
              ) : null}
              {productQuery.trim().length > 0 &&
              !isProductSearching &&
              productResults.length === 0 &&
              !productSearchError ? (
                <p style={mutedTextStyle}>{text.noSearchResult}</p>
              ) : null}
              {productSearchError ? (
                <p style={reviewErrorTextStyle}>{productSearchError}</p>
              ) : null}
              {selectedProduct ? (
                <div style={selectedProductStyle}>
                  <div style={selectedProductHeaderStyle}>
                    <span style={editLineNameStyle}>
                      {selectedProduct.itemCode ? `${selectedProduct.itemCode} · ` : ""}
                      {selectedProduct.itemName} · {formatVnd(selectedProduct.unitPrice)}
                    </span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={newProductQuantity}
                      onChange={(event) =>
                        setNewProductQuantity(Math.max(0, Number(event.target.value)))
                      }
                      style={editNumberInputStyle}
                      disabled={isSaving}
                    />
                    <button
                      type="button"
                      onClick={addSelectedProduct}
                      disabled={isSaving || newProductQuantity <= 0}
                      style={secondaryButtonStyle}
                    >
                      {text.add}
                    </button>
                  </div>
                  {(selectedProduct.optionGroups || []).filter(
                    (group) => group.type === "addition"
                  ).length > 0 ? (
                    <div style={optionSelectionStyle}>
                      <span style={reviewCurrentStatusStyle}>
                        {text.selectOptions}
                      </span>
                      <span style={mutedTextStyle}>{text.optionsAvailable}</span>
                      {(selectedProduct.optionGroups || [])
                        .filter((group) => group.type === "addition")
                        .map((group) => (
                          <div key={group.id} style={optionGroupStyle}>
                            <strong style={miniValueStyle}>{group.name}</strong>
                            <div style={optionButtonListStyle}>
                              {group.options.map((option) => {
                                const selected =
                                  selectedOptions[group.id]?.id === option.id;

                                return (
                                  <button
                                    type="button"
                                    key={option.id}
                                    onClick={() =>
                                      setSelectedOptions((current) => {
                                        if (current[group.id]?.id === option.id) {
                                          const next = { ...current };
                                          delete next[group.id];
                                          return next;
                                        }

                                        return {
                                          ...current,
                                          [group.id]: option,
                                        };
                                      })
                                    }
                                    disabled={isSaving}
                                    style={{
                                      ...secondaryButtonStyle,
                                      ...optionButtonStyle,
                                      ...(selected ? activeSegmentStyle : null),
                                    }}
                                  >
                                    <span style={optionButtonNameStyle}>
                                      {option.name}
                                    </span>
                                    <span style={optionButtonPriceStyle}>
                                      {text.surcharge} {formatVnd(option.unitPrice)}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {newLines.length > 0 ? (
                <div style={editLineListStyle}>
                  {newLines.map((line, index) => (
                    <div
                      key={line.clientId}
                      style={{
                        ...newLineRowStyle,
                        ...(line.isOption ? newOptionLineRowStyle : null),
                      }}
                    >
                      <span style={editLineNameStyle}>
                        {line.isOption ? `${text.optionItems} · ` : ""}
                        {line.itemName}
                      </span>
                      <span style={reviewCurrentStatusStyle}>{formatNumber(line.quantity)}</span>
                      <strong style={miniValueStyle}>
                        {formatVnd(
                          calculateLineFinalAmount({
                            quantity: line.quantity,
                            unitPrice: line.unitPrice,
                          })
                        )}
                      </strong>
                      <button
                        type="button"
                        onClick={() =>
                          setNewLines((current) =>
                            current.filter(
                              (candidate, lineIndex) =>
                                lineIndex !== index &&
                                candidate.parentClientId !== line.clientId
                            )
                          )
                        }
                        style={deleteLineButtonStyle}
                      >
                        {text.delete}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={paymentEditBlockStyle}>
              <span style={reviewCurrentStatusStyle}>{text.paymentMethod}</span>
              <span style={paymentMethodButtonsStyle}>
                <button
                  type="button"
                  onClick={() => {
                    setPaymentMethod("cash");
                    setCashReceivedAmount((current) =>
                      Math.max(toFiniteNumber(current), draftPaymentTotal)
                    );
                  }}
                  style={{
                    ...secondaryButtonStyle,
                    ...(paymentMethod === "cash" ? activeSegmentStyle : null),
                  }}
                >
                  {text.cash}
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod("other")}
                  style={{
                    ...secondaryButtonStyle,
                    ...(paymentMethod === "other" ? activeSegmentStyle : null),
                  }}
                >
                  {text.other}
                </button>
              </span>
              <span style={reviewCurrentStatusStyle}>{text.vatApply}</span>
              <span style={paymentMethodButtonsStyle}>
                <button
                  type="button"
                  onClick={() => setTaxOverrideMode("apply")}
                  style={{ ...secondaryButtonStyle, ...(taxOverrideMode === "apply" ? activeSegmentStyle : null) }}
                >
                  {text.vatApply}
                </button>
                <button
                  type="button"
                  onClick={() => setTaxOverrideMode("exclude_all")}
                  style={{ ...secondaryButtonStyle, ...(taxOverrideMode === "exclude_all" ? activeSegmentStyle : null) }}
                >
                  {text.vatExclude}
                </button>
              </span>
              {paymentMethod === "cash" ? (
                <div style={cashPaymentEditStyle}>
                  <label style={cashInputLabelStyle}>
                    <span style={reviewCurrentStatusStyle}>{text.receivedAmount}</span>
                    <input
                      type="number"
                      min={draftPaymentTotal}
                      step="1000"
                      value={cashReceivedAmount}
                      onChange={(event) =>
                        setCashReceivedAmount(Number(event.target.value))
                      }
                      style={editNameInputStyle}
                      disabled={isSaving}
                    />
                  </label>
                  <div style={miniRowStyle}>
                    <span style={miniLabelStyle}>{text.changeAmount}</span>
                    <strong style={miniValueStyle}>{formatVnd(returnAmount)}</strong>
                  </div>
                </div>
              ) : null}
            </div>

            <div style={modalAdjustmentBoxStyle}>
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.salesAmount}</span>
                <strong style={miniValueStyle}>{formatVnd(draftSalesSubtotal)}</strong>
              </div>
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.calculatedVat}</span>
                <strong style={miniValueStyle}>{formatVnd(draftAdjustedTaxAmount)}</strong>
              </div>
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.calculatedTotal}</span>
                <strong style={miniValueStyle}>{formatVnd(draftCalculatedTotal)}</strong>
              </div>
              <label style={cashInputLabelStyle}>
                <span style={reviewCurrentStatusStyle}>{text.finalPaymentAmount}</span>
                <input
                  type="number"
                  min={0}
                  max={999999999999}
                  step={1}
                  value={finalAmountInput}
                  onChange={(event) => {
                    setFinalAmountTouched(true);
                    setFinalAmountInput(event.target.value);
                  }}
                  style={editNameInputStyle}
                  disabled={isSaving}
                />
              </label>
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.manualAdjustmentAmount}</span>
                <strong style={miniValueStyle}>{formatVnd(manualAdjustmentAmount)}</strong>
              </div>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => {
                  setFinalAmountTouched(false);
                  setFinalAmountInput(String(draftCalculatedTotal));
                }}
                disabled={isSaving}
              >
                {text.restoreCalculatedAmount}
              </button>
              {finalAmountInvalid ? <span style={reviewErrorTextStyle}>{text.invalidFinalPaymentAmount}</span> : null}
            </div>

            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={text.memoPlaceholder}
              style={editTextareaStyle}
              disabled={isSaving}
            />

            <div style={reviewFooterStyle}>
              <span style={productResultMainStyle}>
                <span style={reviewCurrentStatusStyle}>
                  {text.salesAmount} {formatVnd(draftSalesSubtotal)} · {text.vat}{" "}
                  {formatVnd(draftAdjustedTaxAmount)}
                </span>
                <strong style={miniValueStyle}>{formatVnd(draftPaymentTotal)}</strong>
                {cashPaymentInvalid ? (
                  <span style={reviewErrorTextStyle}>
                    {text.finalAmountTooHigh}
                  </span>
                ) : null}
              </span>
              <span style={editActionGroupStyle}>
                <button type="button" onClick={resetDraft} disabled={isSaving} style={secondaryButtonStyle}>
                  {text.cancel}
                </button>
                <button
                  type="button"
                  onClick={saveDraft}
                  disabled={saveDisabled}
                  style={{
                    ...reviewSaveButtonStyle,
                    ...(saveDisabled ? reviewSaveButtonDisabledStyle : null),
                  }}
                >
                  {isSaving ? text.saving : text.save}
                </button>
              </span>
            </div>
          </>
        )}

        {errorMessage ? <p style={reviewErrorTextStyle}>{errorMessage}</p> : null}
      </div>
    </DetailSection>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={detailSectionStyle}>
      <h3 style={detailSectionTitleStyle}>{title}</h3>
      {children}
    </section>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div style={emptyBoxStyle}>
      <div style={emptyTitleStyle}>{title}</div>
      <p style={emptyTextStyle}>{text}</p>
    </div>
  );
}

function ManualReceiptCreateModal({
  businessDate,
  isSaving,
  saveError,
  text,
  editText,
  onClose,
  onSubmit,
}: {
  businessDate: string;
  isSaving: boolean;
  saveError: string;
  text: SalesReceiptsViewText;
  editText: SalesReceiptsEditViewText;
  onClose: () => void;
  onSubmit: (input: CreateManualReceiptInput) => void;
}) {
  const nowLocalTime = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const [vatEnabled, setVatEnabled] = useState(true);
  const [manualFinalAmountInput, setManualFinalAmountInput] = useState("");
  const [manualFinalAmountTouched, setManualFinalAmountTouched] = useState(false);
  const [saleTime, setSaleTime] = useState(() => nowLocalTime());
  const [tableName, setTableName] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "other">("cash");
  const [lines, setLines] = useState<ManualDraftLine[]>([]);

  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<PosProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<PosProduct | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, PosProductOption>
  >({});
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [productQty, setProductQty] = useState("1");

  const [formError, setFormError] = useState("");

  const totalSubtotal = lines.reduce((s, l) => {
    return s + Math.max(0, Math.round(l.unitPrice * l.quantity) - l.discountAmount);
  }, 0);
  const totalTax = lines.reduce((s, l) => {
    if (!vatEnabled) return s;
    const amt = Math.max(0, Math.round(l.unitPrice * l.quantity) - l.discountAmount);
    const rate = l.taxRate || 0;
    return s + (rate > 0 ? Math.round((amt * rate) / 100) : 0);
  }, 0);
  const taxRowsByRate = lines.reduce((rows, line) => {
    if (!vatEnabled) return rows;
    const rate = line.taxRate || 0;
    if (rate <= 0) return rows;
    const amount = Math.max(
      0,
      Math.round(line.unitPrice * line.quantity) - line.discountAmount
    );
    const taxAmount = Math.round((amount * rate) / 100);
    rows.set(rate, (rows.get(rate) || 0) + taxAmount);
    return rows;
  }, new Map<number, number>());
  const taxRows = Array.from(taxRowsByRate.entries())
    .map(([taxRate, taxAmount]) => ({ taxRate, taxAmount }))
    .sort((a, b) => a.taxRate - b.taxRate);
  const parsedManualFinalAmount = Number(manualFinalAmountInput);
  const manualFinalAmount =
    !vatEnabled && Number.isFinite(parsedManualFinalAmount)
      ? Math.round(parsedManualFinalAmount)
      : totalSubtotal;
  const manualAdjustmentAmount = !vatEnabled
    ? manualFinalAmount - totalSubtotal
    : 0;
  const totalPayable = vatEnabled ? totalSubtotal + totalTax : manualFinalAmount;
  const tableListId = "manual-receipt-table-options";
  const parentLines = lines.filter((line) => line.isOption !== true);

  useEffect(() => {
    if (vatEnabled) {
      setManualFinalAmountTouched(false);
      return;
    }
    if (!manualFinalAmountTouched) {
      setManualFinalAmountInput(String(totalSubtotal));
    }
  }, [manualFinalAmountTouched, totalSubtotal, vatEnabled]);

  useEffect(() => {
    const query = productQuery.trim();
    const controller = new AbortController();

    if (query.length < 1) {
      setProductResults([]);
      setSearchError("");
      setIsSearching(false);
      return () => controller.abort();
    }

    async function fetchProducts() {
      setIsSearching(true);
      try {
        const res = await fetch(
          `/api/pos/products?query=${encodeURIComponent(query)}&includeOptions=1`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        const result = (await res.json()) as PosProductsResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || editText.productSearchFailed);
        }

        setProductResults(result.products || []);
        setSearchError("");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSearchError(
          error instanceof Error ? error.message : editText.productSearchFailed
        );
        setProductResults([]);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }

    fetchProducts();
    return () => controller.abort();
  }, [productQuery, editText.productSearchFailed]);

  function addProductLine(product: PosProduct) {
    const qty = Number(productQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setFormError(text.manualReceiptQuantityRequired);
      return;
    }
    const parentClientId = crypto.randomUUID();
    setLines((prev) => [
      ...prev,
      {
        clientId: parentClientId,
        parentClientId: null,
        productId: product.id,
        itemCode: product.itemCode,
        itemName: product.itemName,
        unitName: product.unitName,
        quantity: qty,
        unitPrice: product.unitPrice,
        discountAmount: 0,
        taxRate: product.taxRate ?? null,
        isOption: false,
        refDetailType: 1,
        inventoryItemType: product.itemType ?? null,
        additionId: null,
        optionGroupName: null,
        rawJson: null,
      },
      ...Object.values(selectedOptions).map((option) => ({
        clientId: crypto.randomUUID(),
        parentClientId,
        productId: null,
        itemCode: option.code,
        itemName: option.name,
        unitName: product.unitName,
        quantity: qty,
        unitPrice: option.unitPrice,
        discountAmount: 0,
        taxRate: option.taxRate ?? product.taxRate ?? null,
        isOption: true,
        refDetailType: 2,
        inventoryItemType: 6,
        additionId: option.id,
        optionGroupName:
          product.optionGroups?.find((group) =>
            group.options.some((candidate) => candidate.id === option.id)
          )?.name ?? null,
        rawJson: option.raw,
      })),
    ]);
    setProductQuery("");
    setProductResults([]);
    setSelectedProduct(null);
    setSelectedOptions({});
    setProductQty("1");
    setFormError("");
  }

  function handleSubmit() {
    if (lines.length === 0) { setFormError(text.manualReceiptNoLines); return; }
    if (!/^\d{2}:\d{2}$/.test(saleTime)) {
      setFormError(text.manualReceiptSaleTimeRequired);
      return;
    }
    if (!vatEnabled && (!Number.isFinite(manualFinalAmount) || manualFinalAmount < 0)) {
      setFormError(text.manualReceiptFinalAmountInvalid);
      return;
    }
    setFormError("");
    onSubmit({
      businessDate,
      saleTime,
      tableName,
      note: "",
      vatEnabled,
      paymentMethod,
      cashReceivedAmount: totalPayable,
      manualFinalAmount: vatEnabled ? undefined : manualFinalAmount,
      lines,
    });
  }

  return (
    <div style={modalOverlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modalCardStyle}>
        <div style={modalHeaderStyle}>
          <div style={modalHeaderTitleWrapStyle}>
            <strong style={modalTitleStyle}>{text.manualReceiptModalTitle}</strong>
            <span style={modalHeaderDateStyle}>
              {text.manualReceiptBusinessDateLabel} {businessDate}
            </span>
          </div>
          <button type="button" onClick={onClose} disabled={isSaving} style={modalCloseButtonStyle}>✕</button>
        </div>

        <div style={modalBodyStyle}>
          <div style={modalCompactRowStyle}>
            <label style={modalTimeFieldStyle}>
              <span style={modalSectionTitleStyle}>{text.manualReceiptSaleTime}</span>
              <input
                type="time"
                value={saleTime}
                onChange={(e) => setSaleTime(e.target.value)}
                style={modalTimeInputStyle}
                disabled={isSaving}
              />
            </label>

            <div style={modalSectionStyle}>
              <div style={modalSectionTitleStyle}>{text.vat}</div>
              <div style={modalChipGroupStyle} role="radiogroup" aria-label={text.vat}>
                <label style={{ ...modalRadioChipStyle, ...(vatEnabled ? modalRadioChipActiveStyle : null) }}>
                  <input
                    type="radio"
                    name="manual-receipt-vat"
                    checked={vatEnabled}
                    onChange={() => setVatEnabled(true)}
                    style={modalRadioInputStyle}
                    disabled={isSaving}
                  />
                  <span style={modalRadioIndicatorStyle}>
                    {vatEnabled ? <span style={modalRadioIndicatorDotStyle} /> : null}
                  </span>
                  <span>{text.manualReceiptVatEnabled}</span>
                </label>
                <label style={{ ...modalRadioChipStyle, ...(!vatEnabled ? modalRadioChipActiveStyle : null) }}>
                  <input
                    type="radio"
                    name="manual-receipt-vat"
                    checked={!vatEnabled}
                    onChange={() => {
                      setVatEnabled(false);
                      setManualFinalAmountTouched(false);
                      setManualFinalAmountInput(String(totalSubtotal));
                    }}
                    style={modalRadioInputStyle}
                    disabled={isSaving}
                  />
                  <span style={modalRadioIndicatorStyle}>
                    {!vatEnabled ? <span style={modalRadioIndicatorDotStyle} /> : null}
                  </span>
                  <span>{text.manualReceiptVatDisabled}</span>
                </label>
              </div>
            </div>
          </div>

          <div style={modalCompactRowStyle}>
            <div style={modalSectionStyle}>
              <div style={modalSectionTitleStyle}>{text.table}</div>
              <input
                type="text"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                list={tableListId}
                style={modalInputStyle}
                disabled={isSaving}
              />
              <datalist id={tableListId}>
                {manualReceiptTableNameOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </div>

            <div style={modalSectionStyle}>
              <div style={modalSectionTitleStyle}>{text.paymentMethod}</div>
              <div style={modalChipGroupStyle} role="radiogroup" aria-label={text.paymentMethod}>
                <label style={{ ...modalRadioChipStyle, ...(paymentMethod === "cash" ? modalRadioChipActiveStyle : null) }}>
                  <input
                    type="radio"
                    name="manual-receipt-payment"
                    checked={paymentMethod === "cash"}
                    onChange={() => setPaymentMethod("cash")}
                    style={modalRadioInputStyle}
                    disabled={isSaving}
                  />
                  <span style={modalRadioIndicatorStyle}>
                    {paymentMethod === "cash" ? <span style={modalRadioIndicatorDotStyle} /> : null}
                  </span>
                  <span>{text.cash}</span>
                </label>
                <label style={{ ...modalRadioChipStyle, ...(paymentMethod === "other" ? modalRadioChipActiveStyle : null) }}>
                  <input
                    type="radio"
                    name="manual-receipt-payment"
                    checked={paymentMethod === "other"}
                    onChange={() => setPaymentMethod("other")}
                    style={modalRadioInputStyle}
                    disabled={isSaving}
                  />
                  <span style={modalRadioIndicatorStyle}>
                    {paymentMethod === "other" ? <span style={modalRadioIndicatorDotStyle} /> : null}
                  </span>
                  <span>{text.other}</span>
                </label>
              </div>
            </div>
          </div>

          <div style={modalSectionStyle}>
            <div style={modalSectionTitleStyle}>{text.manualReceiptAddItems}</div>
            <div style={modalFieldGroupStyle}>
              <input
                type="text"
                value={productQuery}
                onChange={(e) => {
                  setProductQuery(e.target.value);
                  setSelectedProduct(null);
                  setSelectedOptions({});
                }}
                placeholder={editText.searchProductPlaceholder}
                style={modalInputStyle}
                disabled={isSaving}
              />
              {isSearching ? <p style={modalMutedTextStyle}>{text.loading}</p> : null}
              {searchError ? <p style={errorTextStyle}>{searchError}</p> : null}
              {productResults.length > 0 ? (
                <div style={modalProductResultsStyle}>
                  {productResults.slice(0, 10).map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => {
                        setSelectedProduct(product);
                        setSelectedOptions({});
                      }}
                      style={{
                        ...modalProductResultItemStyle,
                        ...(selectedProduct?.id === product.id
                          ? modalProductResultSelectedStyle
                          : null),
                      }}
                      disabled={isSaving}
                    >
                      <span style={modalProductResultNameStyle}>{product.itemName}</span>
                      <span style={modalProductResultPriceStyle}>{formatVnd(product.unitPrice)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {productQuery.trim().length > 0 &&
              !isSearching &&
              productResults.length === 0 &&
              !searchError ? (
                <p style={modalMutedTextStyle}>{text.noSearchResult}</p>
              ) : null}
              {selectedProduct ? (
                <div style={modalSelectedProductStyle}>
                  <span style={modalLineNameStyle}>{selectedProduct.itemName}</span>
                  <span style={modalSelectedProductPriceStyle}>
                    {formatVnd(selectedProduct.unitPrice)}
                  </span>
                  {(selectedProduct.optionGroups || []).filter(
                    (group) => group.type === "addition" && group.options.length > 0
                  ).length > 0 ? (
                    <div style={modalOptionSelectionStyle}>
                      {(selectedProduct.optionGroups || [])
                        .filter(
                          (group) =>
                            group.type === "addition" && group.options.length > 0
                        )
                        .map((group) => (
                          <div key={group.id} style={modalOptionGroupStyle}>
                            <span style={modalFieldLabelStyle}>{group.name}</span>
                            <div style={modalOptionButtonListStyle}>
                              {group.options.map((option) => {
                                const selected =
                                  selectedOptions[group.id]?.id === option.id;

                                return (
                                  <button
                                    type="button"
                                    key={option.id}
                                    onClick={() =>
                                      setSelectedOptions((current) => {
                                        if (current[group.id]?.id === option.id) {
                                          const next = { ...current };
                                          delete next[group.id];
                                          return next;
                                        }

                                        return {
                                          ...current,
                                          [group.id]: option,
                                        };
                                      })
                                    }
                                    disabled={isSaving}
                                    style={{
                                      ...modalOptionButtonStyle,
                                      ...(selected ? modalOptionButtonSelectedStyle : null),
                                    }}
                                  >
                                    <span style={modalOptionButtonNameStyle}>
                                      {option.name}
                                    </span>
                                    <span style={modalOptionButtonPriceStyle}>
                                      {formatVnd(option.unitPrice)}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : null}
                  {(selectedProduct.optionGroups || []).filter(
                    (group) => group.type === "child" && group.options.length > 0
                  ).length > 0 ? (
                    <div style={modalComboChildrenStyle}>
                      <span style={modalFieldLabelStyle}>
                        {text.manualReceiptComboItems}
                      </span>
                      {(selectedProduct.optionGroups || [])
                        .filter(
                          (group) => group.type === "child" && group.options.length > 0
                        )
                        .flatMap((group) => group.options)
                        .map((child) => (
                          <div key={child.id} style={modalComboChildRowStyle}>
                            <span style={modalComboChildNameStyle}>
                              {child.name}
                            </span>
                            {child.unitPrice > 0 ? (
                              <span style={modalComboChildPriceStyle}>
                                {formatVnd(child.unitPrice)}
                              </span>
                            ) : null}
                          </div>
                        ))}
                    </div>
                  ) : null}
                  <div style={modalProductResultActionsStyle}>
                    <input
                      type="number"
                      value={productQty}
                      onChange={(e) => setProductQty(e.target.value)}
                      min={0.01}
                      step={0.01}
                      style={modalQtyInputStyle}
                      disabled={isSaving}
                    />
                    <button
                      type="button"
                      onClick={() => addProductLine(selectedProduct)}
                      style={modalAddLineButtonStyle}
                      disabled={isSaving}
                    >
                      {editText.add}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div style={modalSectionStyle}>
            <div style={modalSectionTitleStyle}>
              {text.manualReceiptSelectedItems}
            </div>
            {lines.length > 0 ? (
              <div style={modalLineListStyle}>
                {parentLines.map((line) => {
                  const optionLines = lines.filter(
                    (candidate) => candidate.parentClientId === line.clientId
                  );
                  const amt = Math.max(0, Math.round(line.unitPrice * line.quantity) - line.discountAmount);
                  return (
                    <div key={line.clientId} style={modalLineItemStyle}>
                      <div style={modalLineHeaderStyle}>
                        <div style={modalLineContentStyle}>
                          <span style={modalLineNameStyle}>{line.itemName}</span>
                          <span style={modalLineMetaStyle}>
                            {formatNumber(line.quantity)} × {formatVnd(line.unitPrice)} = {formatVnd(amt)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setLines((prev) =>
                              prev.filter(
                                (l) =>
                                  l.clientId !== line.clientId &&
                                  l.parentClientId !== line.clientId
                              )
                            )
                          }
                          style={modalLineRemoveButtonStyle}
                          disabled={isSaving}
                        >
                          ✕
                        </button>
                      </div>
                      {optionLines.length > 0 ? (
                        <div style={modalOptionLineListStyle}>
                          {optionLines.map((optionLine) => {
                            const optionAmount = Math.max(
                              0,
                              Math.round(optionLine.unitPrice * optionLine.quantity) -
                                optionLine.discountAmount
                            );

                            return (
                              <div key={optionLine.clientId} style={modalOptionLineStyle}>
                                <span style={modalOptionLineNameStyle}>
                                  + {optionLine.itemName}
                                </span>
                                <span style={modalLineMetaStyle}>
                                  {formatVnd(optionAmount)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={modalEmptyTextStyle}>{text.manualReceiptNoLines}</p>
            )}
          </div>

          {!vatEnabled && lines.length > 0 ? (
            <div style={modalAdjustmentBoxStyle}>
              <div style={modalSectionTitleStyle}>
                {text.manualReceiptAdjustmentTitle}
              </div>
              <p style={modalMutedTextStyle}>
                {text.manualReceiptAdjustmentHelp}
              </p>
              <div style={modalTotalRowStyle}>
                <span style={modalTotalLabelStyle}>
                  {text.manualReceiptProductSubtotal}
                </span>
                <span style={modalTotalValueStyle}>{formatVnd(totalSubtotal)}</span>
              </div>
              <label style={modalAdjustmentInputRowStyle}>
                <span style={modalTotalLabelStyle}>
                  {text.manualReceiptFinalAmountLabel}
                </span>
                <input
                  type="number"
                  value={manualFinalAmountInput}
                  onChange={(event) => {
                    setManualFinalAmountTouched(true);
                    setManualFinalAmountInput(event.target.value);
                  }}
                  min={0}
                  step={1000}
                  style={modalAdjustmentInputStyle}
                  disabled={isSaving}
                />
              </label>
              <div style={modalTotalRowStyle}>
                <span style={modalTotalLabelStyle}>
                  {text.manualReceiptAdjustmentAmountLabel}
                </span>
                <strong
                  style={{
                    ...modalTotalValueStyle,
                    ...(manualAdjustmentAmount < 0
                      ? modalNegativeAdjustmentStyle
                      : manualAdjustmentAmount > 0
                        ? modalPositiveAdjustmentStyle
                        : null),
                  }}
                >
                  {formatVnd(manualAdjustmentAmount)}
                </strong>
              </div>
            </div>
          ) : null}

          {lines.length > 0 ? (
            <div style={modalSectionStyle}>
              <div style={modalSectionTitleStyle}>{text.total}</div>
              <div style={modalTotalRowStyle}>
                <span style={modalTotalLabelStyle}>{text.salesAmount}</span>
                <span style={modalTotalValueStyle}>{formatVnd(totalSubtotal)}</span>
              </div>
              {vatEnabled && totalTax > 0 ? (
                taxRows.map((tax) => (
                  <div key={tax.taxRate} style={modalTotalRowStyle}>
                    <span style={modalTotalLabelStyle}>
                      {text.vat} {formatNumber(tax.taxRate)}%
                    </span>
                    <span style={modalTotalValueStyle}>{formatVnd(tax.taxAmount)}</span>
                  </div>
                ))
              ) : (
                <div style={modalTotalRowStyle}>
                  <span style={modalTotalLabelStyle}>
                    {vatEnabled ? text.vat : text.manualReceiptVatDisabled}
                  </span>
                  <span style={modalTotalValueStyle}>{formatVnd(0)}</span>
                </div>
              )}
              <div style={{ ...modalTotalRowStyle, ...modalTotalFinalStyle }}>
                <span style={modalTotalLabelStyle}>{text.total}</span>
                <strong style={modalTotalFinalValueStyle}>{formatVnd(totalPayable)}</strong>
              </div>
            </div>
          ) : null}

          {(formError || saveError) ? (
            <p style={errorTextStyle}>{formError || saveError}</p>
          ) : null}
        </div>

        <div style={modalFooterStyle}>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving || lines.length === 0}
            style={{
              ...modalPrimarySubmitButtonStyle,
              ...(isSaving || lines.length === 0 ? reviewSaveButtonDisabledStyle : null),
            }}
          >
            {isSaving ? text.manualReceiptCreating : text.manualReceiptModalTitle}
          </button>
        </div>
      </div>
    </div>
  );
}

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const cardStyle: CSSProperties = {
  ...ui.card,
  padding: 14,
};

const noticeCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
};

const noticeHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};

const noticeBadgeStyle: CSSProperties = {
  ...ui.badgeMini,
  minWidth: 0,
  background: "#111827",
};

const noticeTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
};

const errorTextStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#dc2626",
  fontWeight: 700,
};

const dateFilterStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gap: 8,
};

const dateInputWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const dateInputStyle: CSSProperties = {
  ...ui.input,
  padding: "9px 10px",
  fontSize: 13,
  borderRadius: 10,
};

const menuSyncWrapStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const menuSyncDescriptionStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: "#6b7280",
  fontWeight: 700,
};

const menuSyncButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "10px 12px",
  fontSize: 13,
  borderRadius: 10,
  fontWeight: 800,
};

const menuSyncButtonDisabledStyle: CSSProperties = {
  opacity: 0.65,
  cursor: "not-allowed",
};

const inventoryPreviewButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "10px 12px",
  borderRadius: 8,
  background: "#245f78",
  color: "#ffffff",
  border: "1px solid #245f78",
  fontSize: 13,
  fontWeight: 800,
};

const inventoryPreviewPanelStyle: CSSProperties = {
  border: "1px solid #d5dbe3",
  borderRadius: 8,
  background: "#ffffff",
  overflow: "hidden",
};

const inventoryPreviewHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 14,
  padding: "11px 14px 8px",
};

const inventoryPreviewReadinessRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-start",
  padding: "0 14px 10px",
  borderBottom: "1px solid #e5e7eb",
};

const inventoryPreviewTitleStyle: CSSProperties = {
  margin: "0 0 2px",
  color: "#18202b",
  fontSize: 16,
  letterSpacing: 0,
};

const inventoryPreviewDescriptionStyle: CSSProperties = {
  margin: 0,
  color: "#667085",
  fontSize: 11,
  lineHeight: 1.45,
};

const inventoryPreviewReadinessStyle: CSSProperties = {
  flexShrink: 0,
  border: "1px solid",
  borderRadius: 5,
  padding: "4px 7px",
  fontSize: 10,
  fontWeight: 900,
};

const inventoryPreviewReadyStyle: CSSProperties = {
  borderColor: "#9fcbbd",
  background: "#edf8f4",
  color: "#246052",
};

const inventoryPreviewSummaryStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))",
  gap: 6,
  padding: "8px 10px",
  borderBottom: "1px solid #e5e7eb",
  background: "#fbfcfd",
};

const inventoryBatchActionStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  padding: "10px 14px",
  borderBottom: "1px solid #e5e7eb",
  background: "#f8fafb",
  fontSize: 12,
};

const inventoryBatchButtonsStyle: CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-end",
  gap: 7,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const inventoryApplyButtonStyle: CSSProperties = {
  border: "1px solid #8b2f2f",
  borderRadius: 6,
  background: "#8b2f2f",
  color: "#ffffff",
  padding: "9px 14px",
  fontSize: 12,
  fontWeight: 900,
  cursor: "pointer",
};

const inventoryApplyDisabledButtonStyle: CSSProperties = {
  border: "1px solid #c9d0da",
  borderRadius: 6,
  background: "#eef0f3",
  color: "#7a8493",
  padding: "8px 10px",
  fontSize: 11,
  fontWeight: 800,
  cursor: "not-allowed",
};

const batchApplyResultStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 14,
  padding: "11px 14px",
  borderBottom: "1px solid #b9d8cc",
  background: "#eef8f4",
  color: "#24584b",
  fontSize: 11,
};

const batchApplyInventoryListStyle: CSSProperties = {
  display: "grid",
  gap: 3,
  color: "#3d645a",
  fontSize: 10,
  textAlign: "right",
};

const batchValidationMetaStyle: CSSProperties = {
  display: "block",
  marginTop: 3,
  color: "#667085",
  fontSize: 10,
};

const batchValidationWarningStyle: CSSProperties = {
  borderColor: "#e5ca8e",
  background: "#fff8e8",
  color: "#805d16",
};

const inventoryPreviewSummaryItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  padding: "9px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 7,
  background: "#ffffff",
  color: "#667085",
  fontSize: 10,
  textAlign: "left",
};

const inventoryPreviewDetailsStyle: CSSProperties = {
  borderBottom: "1px solid #e5e7eb",
};

const inventoryPreviewSummaryTitleStyle: CSSProperties = {
  padding: "11px 14px",
  color: "#344054",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

const inventoryCheckDetailListStyle: CSSProperties = {
  display: "grid",
  gap: 0,
  borderTop: "1px solid #edf0f3",
};

const inventoryCheckDetailItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 14px",
  color: "#596273",
  fontSize: 11,
  borderBottom: "1px solid #edf0f3",
};

const inventoryTotalListStyle: CSSProperties = {
  display: "grid",
  borderTop: "1px solid #edf0f3",
};

const inventoryTotalRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "5px 14px",
  padding: "9px 14px",
  borderBottom: "1px solid #edf0f3",
  color: "#667085",
  fontSize: 11,
};

const inventoryTotalInsufficientStyle: CSSProperties = {
  background: "#fff3f3",
  color: "#8a2f2f",
};

const inventoryTotalNameStyle: CSSProperties = {
  minWidth: 0,
  color: "#18202b",
  overflowWrap: "anywhere",
};

const inventoryExpectedDeductionStyle: CSSProperties = {
  color: "#dc2626",
  fontWeight: 900,
};

const inventoryAfterDeductionStyle: CSSProperties = {
  color: "#18202b",
  fontWeight: 900,
};

const inventoryPreviewEmptyStyle: CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  color: "#667085",
  fontSize: 11,
};

const kegTrackingPreviewListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  paddingTop: 8,
};

const kegTrackingPreviewItemStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  border: "1px solid #d7e7dd",
  background: "#f4fbf7",
  borderRadius: 7,
  padding: "7px 9px",
};

const kegTrackingPreviewNameStyle: CSSProperties = {
  minWidth: 0,
  flex: "1 1 220px",
  color: "#18202b",
  fontSize: 11,
  lineHeight: 1.3,
  overflow: "hidden",
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflowWrap: "anywhere",
};

const kegTrackingPreviewMetaStyle: CSSProperties = {
  flex: "0 0 auto",
  color: "#475467",
  fontSize: 10,
  lineHeight: 1.25,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const kegTrackingPreviewBadgeStyle: CSSProperties = {
  flex: "0 0 auto",
  color: "#276052",
  background: "#e4f4ec",
  border: "1px solid #a9d3bf",
  borderRadius: 5,
  padding: "2px 6px",
  fontSize: 9,
  lineHeight: 1.25,
  fontWeight: 900,
  textAlign: "right",
  whiteSpace: "nowrap",
};

const previewReceiptListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingTop: 8,
};

const previewReceiptStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  overflow: "hidden",
};

const previewReceiptHeaderRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  alignItems: "start",
  gap: 8,
  padding: "9px 10px",
};

const unifiedReceiptHeaderStyle: CSSProperties = {
  padding: "9px 10px",
};

const previewReceiptHeaderButtonStyle: CSSProperties = {
  width: "100%",
  border: 0,
  background: "transparent",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 10,
  padding: 0,
  color: "#18202b",
  textAlign: "left",
  cursor: "pointer",
};

const previewReceiptCheckboxStyle: CSSProperties = {
  width: 16,
  height: 16,
  margin: 0,
  verticalAlign: "middle",
};

const previewReceiptSelectionStyle: CSSProperties = {
  display: "grid",
  justifyItems: "center",
  gap: 3,
};

const previewSelectionLabelStyle: CSSProperties = {
  border: "1px solid",
  borderRadius: 5,
  padding: "1px 4px",
  fontSize: 9,
  lineHeight: 1.2,
  fontWeight: 900,
  whiteSpace: "nowrap",
};

const previewSelectionReadyStyle: CSSProperties = {
  borderColor: "#9fcbbd",
  background: "#edf8f4",
  color: "#246052",
};

const previewSelectionWarningStyle: CSSProperties = {
  borderColor: "#ead39c",
  background: "#fff9eb",
  color: "#77591b",
};

const previewSelectionNeutralStyle: CSSProperties = {
  borderColor: "#c9d0da",
  background: "#f5f6f7",
  color: "#596273",
};

const previewReceiptMetaStyle: CSSProperties = {
  display: "block",
  marginTop: 3,
  color: "#667085",
  fontSize: 10,
  lineHeight: 1.35,
};

const unifiedActionableItemsStyle: CSSProperties = {
  minWidth: 0,
  marginTop: 2,
  color: "#344054",
  fontSize: 11,
  lineHeight: 1.4,
};

const unifiedActionableItemsLabelStyle: CSSProperties = {
  fontWeight: 700,
};

const unifiedActionableSingleItemStyle: CSSProperties = {
  marginLeft: 4,
  overflowWrap: "anywhere",
  fontWeight: 600,
};

const unifiedActionableItemsListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  margin: "2px 0 0",
  padding: 0,
  listStyle: "none",
};

const unifiedActionableItemStyle: CSSProperties = {
  minWidth: 0,
  overflowWrap: "anywhere",
  fontWeight: 600,
};

const previewReceiptMainStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const previewReceiptAmountWrapStyle: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 3,
  minWidth: 82,
};

const previewStatusStyle: CSSProperties = {
  border: "1px solid",
  borderRadius: 5,
  padding: "3px 7px",
  fontSize: 10,
  fontWeight: 900,
};

const previewStatusReadyStyle: CSSProperties = {
  borderColor: "#9fcbbd",
  background: "#edf8f4",
  color: "#246052",
};

const previewStatusSkippedStyle: CSSProperties = {
  borderColor: "#c9d0da",
  background: "#f5f6f7",
  color: "#596273",
};

const previewStatusBlockedStyle: CSSProperties = {
  borderColor: "#e0abab",
  background: "#fff1f1",
  color: "#8a2f2f",
};

const previewStatusAlreadyAppliedStyle: CSSProperties = {
  borderColor: "#2d3748",
  background: "#2d3748",
  color: "#ffffff",
};

const previewLineListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: "0 10px 10px 36px",
};

const previewLineStyle: CSSProperties = {
  borderLeft: "3px solid #cbd5e1",
  background: "#f8fafb",
  padding: "9px 10px",
};

const previewOptionLineStyle: CSSProperties = {
  marginLeft: 18,
  borderLeftColor: "#7aa4b5",
};

const previewLineTitleStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
  color: "#667085",
  fontSize: 10,
};

const previewLineMainStyle: CSSProperties = {
  minWidth: 0,
  display: "grid",
  gap: 5,
};

const previewLineNameStyle: CSSProperties = {
  color: "#111827",
  fontSize: 11,
  lineHeight: 1.35,
  overflowWrap: "anywhere",
};

const previewLineQuantityStyle: CSSProperties = {
  color: "#475467",
  fontSize: 10,
  lineHeight: 1.35,
  fontWeight: 900,
  whiteSpace: "nowrap",
};

const previewLineBadgeStyle: CSSProperties = {
  width: "fit-content",
  border: "1px solid",
  borderRadius: 5,
  padding: "2px 6px",
  fontSize: 10,
  lineHeight: 1.25,
  fontWeight: 900,
};

const previewLineBadgeReadyStyle: CSSProperties = {
  borderColor: "#9fcbbd",
  background: "#edf8f4",
  color: "#246052",
};

const previewLineBadgeWarningStyle: CSSProperties = {
  borderColor: "#ead39c",
  background: "#fff9eb",
  color: "#77591b",
};

const previewLineBadgeDangerStyle: CSSProperties = {
  borderColor: "#e0abab",
  background: "#fff1f1",
  color: "#8a2f2f",
};

const previewLineBadgeNeutralStyle: CSSProperties = {
  borderColor: "#c9d0da",
  background: "#f5f6f7",
  color: "#596273",
};

const previewLineErrorStyle: CSSProperties = {
  margin: "5px 0 0",
  color: "#9a4a2f",
  fontSize: 10,
};

const previewDeductionStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto auto",
  gap: 10,
  marginTop: 7,
  color: "#475467",
  fontSize: 10,
  overflowWrap: "anywhere",
};

const successTextStyle: CSSProperties = {
  margin: "7px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#047857",
  fontWeight: 800,
};

const warningTextStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#b45309",
  fontWeight: 800,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
};

const sectionTitleStyle: CSSProperties = {
  ...ui.sectionTitle,
  fontSize: 15,
  margin: 0,
};

const sectionTitleRowStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 7,
  flexWrap: "wrap",
};

const receiptListExclusionBadgeStyle: CSSProperties = {
  border: "1px solid #e5ca8e",
  borderRadius: 6,
  padding: "3px 7px",
  background: "#fff8e8",
  color: "#805d16",
  fontSize: 11,
  lineHeight: 1.2,
  fontWeight: 900,
  whiteSpace: "nowrap",
};

const sectionMetaStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#9ca3af",
  whiteSpace: "nowrap",
};

const receiptListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const receiptItemWrapStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#eef0f3",
  borderRadius: 10,
  overflow: "hidden",
  background: "#ffffff",
  boxShadow: "none",
};

const receiptItemAlternateStyle: CSSProperties = {
  background: "#f9fafb",
};

const receiptItemExpandedStyle: CSSProperties = {
  borderColor: "#cbd5e1",
  boxShadow: "inset 3px 0 0 #64748b",
};

const receiptRowButtonStyle: CSSProperties = {
  width: "100%",
  border: 0,
  background: "transparent",
  padding: "9px 10px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: 10,
  textAlign: "left",
  cursor: "pointer",
};

const receiptMainStyle: CSSProperties = {
  flex: "1 1 180px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const receiptTopLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: 7,
  minWidth: 0,
};

const receiptNoStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  wordBreak: "break-word",
};

const receiptMetaLineStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
  overflowWrap: "anywhere",
};

const receiptStatusGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 5,
};

const statusBadgeStyle: CSSProperties = {
  ...ui.badgeMini,
  height: 19,
  minWidth: 0,
  flexShrink: 0,
};

const paidBadgeStyle: CSSProperties = {
  background: "#111827",
};

const paymentPendingBadgeStyle: CSSProperties = {
  background: "#6b7280",
};

const canceledBadgeStyle: CSSProperties = {
  background: "#dc2626",
};

const modifiedBadgeStyle: CSSProperties = {
  background: "#ffee00",
  color: "#111827",
};

const receiptAmountWrapStyle: CSSProperties = {
  marginLeft: "auto",
  minWidth: 0,
  flex: "0 1 auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 3,
};

const receiptAmountLineStyle: CSSProperties = {
  maxWidth: "100%",
  minHeight: 17,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 5,
  flexWrap: "nowrap",
};

const amountStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
};

const receiptListAmountStyle: CSSProperties = {
  ...amountStyle,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const receiptDeductionBadgeStyle: CSSProperties = {
  ...previewStatusStyle,
  flexShrink: 0,
  padding: "1px 5px",
  fontSize: 9,
  lineHeight: 1.2,
  whiteSpace: "nowrap",
};

const receiptTimeStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 800,
};

const chevronStyle: CSSProperties = {
  ...ui.metaText,
  flexShrink: 0,
  fontWeight: 800,
};

const dropdownStyle: CSSProperties = {
  padding: "10px",
  background: "#f8fafc",
  borderTop: "1px solid #e2e8f0",
  display: "grid",
  gap: 9,
};

const detailSectionStyle: CSSProperties = {
  padding: "9px",
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 9,
};

const detailSectionTitleStyle: CSSProperties = {
  margin: "0 0 7px",
  fontSize: 13,
  fontWeight: 900,
  color: "#111827",
};

const miniListStyle: CSSProperties = {
  display: "grid",
  gap: 5,
};

const miniRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto",
  alignItems: "center",
  gap: 8,
  padding: "6px 7px",
  borderRadius: 8,
  background: "#f9fafb",
};

const miniLabelStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 800,
  color: "#374151",
};

const miniValueStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
};

const lineCountStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const mutedTextStyle: CSSProperties = {
  ...ui.metaText,
  margin: 0,
  fontWeight: 700,
};

const paymentBlockStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 8,
  borderTop: "1px solid #eef0f3",
};

const paymentBlockTitleStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#374151",
};

const cashExtraStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gap: 5,
};

const lineListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const lineRowStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: "8px",
  borderRadius: 8,
  background: "#f9fafb",
  border: "1px solid #eef0f3",
};

const optionLineRowStyle: CSSProperties = {
  marginLeft: 16,
  paddingLeft: 10,
  background: "#ffffff",
  borderStyle: "dashed",
  borderLeft: "3px solid #cbd5e1",
};

const lineTitleRowStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "flex-start",
  flexWrap: "wrap",
  gap: 6,
};

const lineNameStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const optionLineNameStyle: CSSProperties = {
  fontSize: 11,
  color: "#374151",
};

const optionBadgeStyle: CSSProperties = {
  ...ui.badgeMini,
  width: "fit-content",
  minWidth: 0,
  height: 17,
  background: "#6b7280",
};

const lineSummaryStyle: CSSProperties = {
  ...ui.metaText,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontWeight: 800,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const lineSummaryLeftStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "nowrap",
  overflow: "hidden",
};

const receiptLineDeductionBadgeStyle: CSSProperties = {
  ...previewLineBadgeStyle,
  flexShrink: 0,
  padding: "1px 5px",
  fontSize: 9,
  lineHeight: 1.2,
  whiteSpace: "nowrap",
};

const lineSummaryAmountStyle: CSSProperties = {
  flexShrink: 0,
  color: "#111827",
  fontWeight: 900,
};

const optionLineSummaryStyle: CSSProperties = {
  fontSize: 11,
};

const editPanelStyle: CSSProperties = {
  display: "grid",
  gap: 8,
};

const editSummaryStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "7px 8px",
  borderRadius: 8,
  background: "#fffbeb",
};

const editButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: 9,
  padding: "9px 12px",
  background: "#111827",
  color: "#ffffff",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
};

const editLineListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  minWidth: 0,
};

const existingOptionNoticeStyle: CSSProperties = {
  ...mutedTextStyle,
  padding: "7px 8px",
  borderRadius: 8,
  background: "#f3f4f6",
  color: "#374151",
};

const existingLineGroupStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  minWidth: 0,
  width: "100%",
};

const editLineRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 48px 98px auto",
  gap: 6,
  alignItems: "center",
  minWidth: 0,
  width: "100%",
};

const existingOptionReadOnlyRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 42px 86px 98px",
  gap: 6,
  alignItems: "center",
  marginLeft: 12,
  padding: "6px 8px",
  width: "calc(100% - 12px)",
  maxWidth: "calc(100% - 12px)",
  minWidth: 0,
  boxSizing: "border-box",
  borderRadius: 8,
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
};

const existingOptionMetaStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 11,
  lineHeight: 1.35,
  fontWeight: 800,
  color: "#475569",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const newLineRowStyle: CSSProperties = {
  ...editLineRowStyle,
  gridTemplateColumns: "minmax(0, 1fr) 48px 98px auto",
  background: "#f0fdf4",
  borderRadius: 8,
  padding: 6,
  minWidth: 0,
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
};

const deletedEditLineRowStyle: CSSProperties = {
  opacity: 0.55,
  textDecoration: "line-through",
};

const editLineNameStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const editNameInputStyle: CSSProperties = {
  ...ui.input,
  minWidth: 0,
  padding: "7px 8px",
  fontSize: 12,
  borderRadius: 8,
  fontWeight: 700,
};

const editNumberInputStyle: CSSProperties = {
  ...editNameInputStyle,
  textAlign: "right",
};

const deleteLineButtonStyle: CSSProperties = {
  border: "1px solid #fecaca",
  borderRadius: 8,
  padding: "7px 8px",
  background: "#fff1f2",
  color: "#b91c1c",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const secondaryButtonStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#d1d5db",
  borderRadius: 9,
  padding: "8px 10px",
  background: "#ffffff",
  color: "#374151",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const editActionGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const productSearchStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  paddingTop: 8,
  borderTop: "1px solid #eef0f3",
};

const productResultListStyle: CSSProperties = {
  display: "grid",
  gap: 4,
};

const productResultButtonStyle: CSSProperties = {
  border: "1px solid #374151",
  borderRadius: 8,
  padding: "7px 8px",
  background: "#1f2937",
  color: "#ffffff",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
  cursor: "pointer",
  minWidth: 0,
  width: "100%",
  transition: "background-color 120ms ease, border-color 120ms ease",
};

const productResultButtonSelectedStyle: CSSProperties = {
  background: "#111827",
  borderColor: "#9ca3af",
};

const productResultNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#ffffff",
};

const productResultPriceStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#e5e7eb",
  whiteSpace: "nowrap",
};

const productResultMainStyle: CSSProperties = {
  minWidth: 0,
  display: "grid",
  gap: 2,
};

const selectedProductStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 6,
  borderRadius: 8,
  background: "#f9fafb",
  minWidth: 0,
  maxWidth: "100%",
  overflow: "hidden",
};

const selectedProductHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 48px auto",
  gap: 6,
  alignItems: "center",
};

const optionSelectionStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  paddingTop: 6,
  borderTop: "1px solid #e5e7eb",
  minWidth: 0,
  maxWidth: "100%",
};

const optionGroupStyle: CSSProperties = {
  display: "grid",
  gap: 5,
  minWidth: 0,
  maxWidth: "100%",
};

const optionButtonListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
  minWidth: 0,
  maxWidth: "100%",
};

const optionButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  minWidth: 0,
  maxWidth: "100%",
  overflow: "hidden",
};

const optionButtonNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const optionButtonPriceStyle: CSSProperties = {
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const newOptionLineRowStyle: CSSProperties = {
  marginLeft: 12,
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  width: "calc(100% - 12px)",
  maxWidth: "calc(100% - 12px)",
};

const paymentEditBlockStyle: CSSProperties = {
  display: "grid",
  gap: 7,
  paddingTop: 8,
  borderTop: "1px solid #eef0f3",
};

const paymentMethodButtonsStyle: CSSProperties = {
  display: "flex",
  gap: 6,
};

const activeSegmentStyle: CSSProperties = {
  background: "#111827",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#111827",
  color: "#ffffff",
};

const cashPaymentEditStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const cashInputLabelStyle: CSSProperties = {
  display: "grid",
  gap: 5,
};

const editTextareaStyle: CSSProperties = {
  ...ui.input,
  minHeight: 58,
  padding: "8px 9px",
  fontSize: 12,
  lineHeight: 1.45,
  borderRadius: 9,
  fontWeight: 700,
  resize: "vertical",
};

const reviewFooterStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const reviewCurrentStatusStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 800,
};

const reviewSaveButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: 9,
  padding: "8px 12px",
  background: "#111827",
  color: "#ffffff",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const reviewSaveButtonDisabledStyle: CSSProperties = {
  opacity: 0.45,
  cursor: "not-allowed",
};

const reviewErrorTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.45,
  color: "#dc2626",
  fontWeight: 800,
};

const emptyBoxStyle: CSSProperties = {
  border: "1px dashed #d1d5db",
  background: "#f9fafb",
  borderRadius: 12,
  padding: 14,
  textAlign: "center",
};

const emptyTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#374151",
  marginBottom: 5,
};

const emptyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.45,
  color: "#6b7280",
  fontWeight: 700,
};

const menuSyncBottomWrapStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  paddingTop: 12,
  marginTop: 8,
  borderTop: "1px solid #f3f4f6",
};

const createManualReceiptButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "10px 12px",
  fontSize: 13,
  borderRadius: 10,
  fontWeight: 800,
  background: "#1a3a5c",
  color: "#ffffff",
  border: "1px solid #1a3a5c",
};

const manualBadgeStyle: CSSProperties = {
  background: "#4b5563",
  color: "#ffffff",
};

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  zIndex: 5000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px 12px",
  boxSizing: "border-box",
};

const modalCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "#ffffff",
  borderRadius: 12,
  width: "100%",
  maxWidth: 480,
  maxHeight: "calc(100dvh - 48px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
  overflow: "hidden",
};

const modalHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
  padding: "14px 16px",
  borderBottom: "1px solid #e5e7eb",
};

const modalHeaderTitleWrapStyle: CSSProperties = {
  display: "grid",
  gap: 2,
  minWidth: 0,
};

const modalTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: "#111827",
};

const modalHeaderDateStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.35,
  fontWeight: 800,
  color: "#6b7280",
};

const modalCloseButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 15,
  color: "#6b7280",
  padding: "2px 6px",
  lineHeight: 1,
};

const modalBodyStyle: CSSProperties = {
  padding: "10px 14px",
  display: "grid",
  gap: 8,
  overflowY: "auto",
  minHeight: 0,
  flex: 1,
};

const modalSectionStyle: CSSProperties = {
  display: "grid",
  gap: 5,
};

const modalSectionTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 900,
  color: "#374151",
};

const modalCompactRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
  gap: 8,
  alignItems: "start",
};

const modalTimeFieldStyle: CSSProperties = {
  display: "grid",
  gap: 4,
};

const modalTimeInputStyle: CSSProperties = {
  ...ui.input,
  padding: "7px 9px",
  fontSize: 13,
  borderRadius: 8,
};

const modalChipGroupStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const modalRadioChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 30,
  padding: "0 10px",
  border: "1px solid #d1d5db",
  borderRadius: 999,
  background: "#ffffff",
  color: "#374151",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

const modalRadioChipActiveStyle: CSSProperties = {
  border: "1px solid #9ca3af",
  background: "#f3f4f6",
  color: "#111827",
};

const modalRadioInputStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: 0,
  opacity: 0,
  pointerEvents: "none",
};

const modalRadioIndicatorStyle: CSSProperties = {
  width: 12,
  height: 12,
  border: "1px solid currentColor",
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const modalRadioIndicatorDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 999,
  background: "#dc2626",
};

const modalFieldGroupStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const modalFieldLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "#6b7280",
};

const modalInputStyle: CSSProperties = {
  ...ui.input,
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 9,
};

const modalLineListStyle: CSSProperties = {
  display: "grid",
  gap: 4,
};

const modalLineItemStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: "5px 7px",
  borderRadius: 7,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
};

const modalLineHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 6,
};

const modalLineContentStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  flex: 1,
};

const modalLineNameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#111827",
  lineHeight: 1.35,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const modalLineMetaStyle: CSSProperties = {
  fontSize: 11,
  color: "#6b7280",
  fontWeight: 700,
  marginTop: 1,
};

const modalLineRemoveButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#9ca3af",
  fontSize: 12,
  padding: "1px 3px",
  lineHeight: 1,
  flexShrink: 0,
};

const modalProductResultsStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  maxHeight: 200,
  overflowY: "auto",
};

const modalProductResultItemStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "center",
  padding: "7px 8px",
  borderRadius: 8,
  background: "#1f2937",
  border: "1px solid #374151",
  color: "#ffffff",
  textAlign: "left",
  cursor: "pointer",
  minWidth: 0,
  width: "100%",
  transition: "background-color 120ms ease, border-color 120ms ease",
};

const modalProductResultSelectedStyle: CSSProperties = {
  border: "1px solid #9ca3af",
  background: "#111827",
};

const modalProductResultNameStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#ffffff",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const modalProductResultPriceStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#e5e7eb",
  whiteSpace: "nowrap",
};

const modalSelectedProductPriceStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#6b7280",
  whiteSpace: "nowrap",
};

const modalProductResultActionsStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "center",
};

const modalMutedTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: 1.4,
  color: "#6b7280",
  fontWeight: 700,
};

const modalSelectedProductStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 6,
  borderRadius: 8,
  background: "#f9fafb",
  minWidth: 0,
  maxWidth: "100%",
  overflow: "hidden",
};

const modalOptionSelectionStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  paddingTop: 2,
};

const modalOptionGroupStyle: CSSProperties = {
  display: "grid",
  gap: 5,
};

const modalOptionButtonListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
};

const modalOptionButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  maxWidth: "100%",
  padding: "5px 8px",
  border: "1px solid #d1d5db",
  borderRadius: 7,
  background: "#ffffff",
  color: "#374151",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const modalOptionButtonSelectedStyle: CSSProperties = {
  border: "1px solid #111827",
  background: "#111827",
  color: "#ffffff",
};

const modalOptionButtonNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const modalOptionButtonPriceStyle: CSSProperties = {
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const modalComboChildrenStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  paddingTop: 4,
  borderTop: "1px solid #e5e7eb",
};

const modalComboChildRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "center",
  paddingLeft: 8,
  color: "#4b5563",
};

const modalComboChildNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 11,
  lineHeight: 1.35,
  fontWeight: 800,
};

const modalComboChildPriceStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 11,
  lineHeight: 1.35,
  fontWeight: 800,
  color: "#6b7280",
  whiteSpace: "nowrap",
};

const modalQtyInputStyle: CSSProperties = {
  ...ui.input,
  width: 48,
  padding: "5px 7px",
  fontSize: 12,
  borderRadius: 7,
  textAlign: "center",
};

const modalAddLineButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "6px 10px",
  fontSize: 12,
  borderRadius: 8,
  fontWeight: 800,
  background: "#111827",
  color: "#ffffff",
  border: "1px solid #111827",
};

const modalEmptyTextStyle: CSSProperties = {
  margin: 0,
  padding: "8px 9px",
  border: "1px dashed #d1d5db",
  borderRadius: 8,
  background: "#f9fafb",
  fontSize: 12,
  lineHeight: 1.4,
  color: "#6b7280",
  fontWeight: 700,
};

const modalAdjustmentBoxStyle: CSSProperties = {
  display: "grid",
  gap: 7,
  padding: 9,
  border: "1px solid #e5e7eb",
  borderRadius: 9,
  background: "#fbfcfd",
};

const modalAdjustmentInputRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(140px, 180px)",
  alignItems: "center",
  gap: 8,
};

const modalAdjustmentInputStyle: CSSProperties = {
  ...ui.input,
  padding: "7px 9px",
  fontSize: 13,
  borderRadius: 8,
  textAlign: "right",
};

const modalNegativeAdjustmentStyle: CSSProperties = {
  color: "#dc2626",
};

const modalPositiveAdjustmentStyle: CSSProperties = {
  color: "#047857",
};

const modalTotalRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
};

const modalTotalLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
};

const modalTotalValueStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#374151",
};

const modalTotalFinalStyle: CSSProperties = {
  paddingTop: 6,
  marginTop: 2,
  borderTop: "1px solid #e5e7eb",
};

const modalTotalFinalValueStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: "#111827",
};

const modalFooterStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "10px 16px 12px",
  borderTop: "1px solid #e5e7eb",
  background: "#ffffff",
  flexShrink: 0,
};

const modalOptionLineListStyle: CSSProperties = {
  display: "grid",
  gap: 2,
  paddingLeft: 12,
  borderLeft: "2px solid #cbd5e1",
};

const modalOptionLineStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  padding: "2px 0",
};

const modalOptionLineNameStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "#374151",
  lineHeight: 1.35,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const modalPrimarySubmitButtonStyle: CSSProperties = {
  ...reviewSaveButtonStyle,
  width: "100%",
  minHeight: 40,
  justifyContent: "center",
};
