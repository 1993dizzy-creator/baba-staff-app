"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { getBusinessDate } from "@/lib/common/business-time";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";
import { commonText, salesText } from "@/lib/text";

const salesTabs = [
  { href: "/admin/sales", key: "daily" },
  { href: "/admin/sales/receipts", key: "receipts" },
  { href: "/admin/sales/monthly", key: "monthly" },
] as const;

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
    | "cash"
    | "transfer"
    | "card"
    | "paymentMethod"
    | "vat"
    | "totalTax"
    | "receivedAmount"
    | "changeAmount"
    | "paid"
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
  };
};

type SaveReceiptEditInput = {
  receiptId: number;
  lines: ReceiptEditLine[];
  paymentMethod: PaymentMethod;
  cashReceivedAmount: number | null;
  note: string;
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

function isExistingOptionLine(line: LineDetail) {
  return (
    line.isOption ||
    Boolean(line.parentRefDetailId) ||
    line.refDetailType !== 1 ||
    line.mappingStatus === "option"
  );
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
      parentRefDetailId: string | null;
      isOption: boolean;
      lineType: string;
      itemName: string | null;
      quantitySold: number;
      mappingSnapshot?: Record<string, unknown> | null;
      status: string;
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

type BatchValidationStatus =
  | "valid"
  | "hash_changed"
  | "amount_changed"
  | "mapping_changed"
  | "recipe_changed"
  | "inventory_insufficient"
  | "already_applied"
  | "no_longer_ready"
  | "missing_receipt"
  | "missing_lines"
  | "invalid_mapping"
  | "manual_review"
  | "skipped";

type BatchValidationResult = {
  batchId: number;
  applyReady: boolean;
  validatedAt: string;
  summary: {
    selectedReceiptCount: number;
    validReceiptCount: number;
    blockedReceiptCount: number;
    warningReceiptCount: number;
    inventoryIssueCount: number;
    hashChangedCount: number;
    mappingChangedCount: number;
    recipeChangedCount: number;
    alreadyAppliedCount: number;
  };
  receipts: Array<{
    receiptId: number;
    receiptRefNo: string | null;
    status: BatchValidationStatus;
    applyAllowed: boolean;
    warnings: string[];
    errors: string[];
  }>;
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

type AppLanguage = keyof typeof salesText;

const inventoryPreviewText = {
  ko: {
    previewButton: "재고 차감 미리보기",
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
    applyFailed: "판매 재고차감을 확정하지 못했습니다.",
    receipt: "영수증",
    deduction: "차감",
    log: "로그",
    countSuffix: "건",
    itemSuffix: "개",
    total: "전체",
    canApply: "차감가능",
    needsCheck: "확인필요",
    details: "상세보기",
    needsCheckDetails: "확인필요 상세",
    inventoryTotals: "재고품목별 예상합계",
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
    alreadyAppliedHelp: "이미 재고 차감이 완료된 영수증입니다",
    modifiedAfterApplyHelp: "차감 후 수정되어 별도 확인이 필요합니다",
    genericCheckHelp: "내용 확인 후 처리해주세요",
    partialNotice:
      "Recipe 미완성 라인은 차감 대상에서 제외됩니다. Direct 매핑 상품과 완성 Recipe 상품은 계속 차감 가능합니다.",
    status: {
      ready: "차감가능",
      partial: "일부 가능",
      needsCheck: "확인필요",
      skipped: "차감 불필요",
      alreadyApplied: "이미 차감",
      modified: "수정됨",
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
      alreadyApplied: "이미 차감",
      skipped: "차감 불필요",
      invalidMapping: "매핑 확인 필요",
      reviewRequired: "영수증 확인 필요",
    },
  },
  vi: {
    previewButton: "Xem trước trừ kho",
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
    applyFailed: "Không xác nhận được trừ kho bán hàng.",
    receipt: "Hóa đơn",
    deduction: "Trừ kho",
    log: "Nhật ký",
    countSuffix: " mục",
    itemSuffix: " món",
    total: "Tổng",
    canApply: "Có thể trừ kho",
    needsCheck: "Cần kiểm tra",
    details: "Chi tiết",
    needsCheckDetails: "Chi tiết cần kiểm tra",
    inventoryTotals: "Tổng dự kiến theo hàng tồn",
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
    partialNotice:
      "Dòng Recipe chưa hoàn thiện sẽ bị loại khỏi trừ kho. Món Direct và Recipe hoàn chỉnh vẫn có thể trừ kho.",
    status: {
      ready: "Có thể trừ kho",
      partial: "Có thể trừ một phần",
      needsCheck: "Cần kiểm tra",
      skipped: "Không cần trừ",
      alreadyApplied: "Đã trừ kho",
      modified: "Đã sửa",
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

function getPreviewLineTypeLabel(lineType: string, text: InventoryPreviewCopy) {
  return text.lineType[lineType as keyof typeof text.lineType] || text.needsCheck;
}

function getInventoryTotalName(total: {
  inventoryItemName: string;
  inventoryCode: string | null;
}) {
  return total.inventoryCode
    ? `[${total.inventoryCode}] ${total.inventoryItemName}`
    : total.inventoryItemName;
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

function getLineHelpText(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number],
  receipt: InventoryDeductionPreview["receipts"][number],
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
  if (receipt.status === "already_applied") return text.alreadyAppliedHelp;
  if (receipt.status === "applied_after_modified") {
    return text.modifiedAfterApplyHelp;
  }
  if (line.status === "ignored") return text.ignoredHelp;
  return line.deductions.length > 0 ? "" : text.genericCheckHelp;
}

function getLineDisplayType(
  line: InventoryDeductionPreview["receipts"][number]["lines"][number],
  text: InventoryPreviewCopy
) {
  if (line.lineType.startsWith("combo_")) {
    return getPreviewLineTypeLabel(line.lineType, text);
  }
  if (line.status === "incomplete_recipe") {
    return text.lineType.incomplete_recipe;
  }
  if (line.status === "missing_mapping") return text.lineType.missing_mapping;
  if (line.status === "manual_review") return text.lineType.manual_review;
  if (line.status === "invalid_mapping") return text.lineType.invalid_mapping;
  if (line.deductions.some((deduction) => deduction.status === "insufficient_stock")) {
    return text.lineType.insufficient_stock;
  }
  return getPreviewLineTypeLabel(line.lineType, text);
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

function getPaymentStatusLabel(
  receipt: Pick<ReceiptItem, "isCanceled" | "paymentStatus" | "isModified">,
  text: SalesReceiptsViewText
) {
  if (receipt.isCanceled) return text.canceled;
  if (receipt.isModified) return text.modified;
  if (receipt.paymentStatus === 3) return text.paid;
  if (receipt.paymentStatus === 4 || receipt.paymentStatus === 5) {
    return text.canceled;
  }
  return `${text.status} ${receipt.paymentStatus ?? "-"}`;
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
    return text.cash ?? "현금";
  }

  if (
    normalized.includes("chuyen khoan") ||
    normalized.includes("transfer") ||
    normalized.includes("bank")
  ) {
    return text.transfer ?? "이체";
  }

  if (
    normalized.includes("the") ||
    normalized.includes("card") ||
    normalized.includes("visa") ||
    normalized.includes("master")
  ) {
    return text.card ?? "카드";
  }

  if (
    normalized.includes("khac") ||
    normalized.includes("other")
  ) {
    return text.other ?? "기타";
  }

  return String(rawName || text.other || "기타");
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
  const initialBusinessDate = searchParams.get("businessDate") || getBusinessDate();
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
  const [currentUser, setCurrentUser] =
    useState<ReturnType<typeof getUser>>(null);
  const [isMenuSyncing, setIsMenuSyncing] = useState(false);
  const [menuSyncMessage, setMenuSyncMessage] = useState("");
  const [menuSyncWarning, setMenuSyncWarning] = useState("");
  const [menuSyncErrorMessage, setMenuSyncErrorMessage] = useState("");
  const [inventoryPreview, setInventoryPreview] =
    useState<InventoryDeductionPreview | null>(null);
  const [isInventoryPreviewLoading, setIsInventoryPreviewLoading] =
    useState(false);
  const [inventoryPreviewError, setInventoryPreviewError] = useState("");
  const [selectedPreviewReceipts, setSelectedPreviewReceipts] = useState<
    Record<number, boolean>
  >({});
  const [batchApplyResult, setBatchApplyResult] =
    useState<BatchApplyResult | null>(null);
  const [isBatchApplying, setIsBatchApplying] = useState(false);

  const canSyncMenu =
    currentUser?.role === "owner" ||
    currentUser?.role === "master" ||
    currentUser?.role === "manager";
  const canApplyInventory =
    currentUser?.role === "owner" || currentUser?.role === "master";

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

  useEffect(() => {
    setCurrentUser(getUser());
  }, []);

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

        setReceipts(result.receipts || []);
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
    setInventoryPreview(null);
    setInventoryPreviewError("");
    setSelectedPreviewReceipts({});
    setBatchApplyResult(null);
    fetchReceipts();

    return () => controller.abort();
  }, [businessDate, receiptsText.loadFailed]);

  async function handleToggleReceipt(receiptId: number) {
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
        }),
      });

      const result = (await res.json()) as ReceiptPatchResponse;

      if (!res.ok || !result.ok || !result.receipt) {
        throw new Error(
          result.code === "receipt_has_option_lines"
            ? receiptsEditText.optionEditProtected
            : result.message || result.error || receiptsEditText.saveFailed
        );
      }

      const updatedReceipt = result.receipt;
      setInventoryPreview(null);
      setSelectedPreviewReceipts({});
      setBatchApplyResult(null);

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
                  (line) => !isExistingOptionLine(line)
                ).length,
                optionLineCount: (refreshedDetail.lines || []).filter(
                  isExistingOptionLine
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

  async function handleInventoryPreview() {
    if (!currentUser?.username || !canSyncMenu) {
      setInventoryPreviewError(receiptsText.noPermission);
      return;
    }

    setIsInventoryPreviewLoading(true);
    setInventoryPreviewError("");
    setInventoryPreview(null);
    try {
      const res = await fetch(
        "/api/admin/sales/inventory-deductions/preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessDateFrom: businessDate,
            businessDateTo: businessDate,
            actorUsername: currentUser.username,
          }),
        }
      );
      const result = (await res.json().catch(() => null)) as
        | InventoryPreviewResponse
        | null;

      if (!res.ok || !result?.ok || !result.preview) {
        throw new Error(result?.error || inventoryText.previewFailed);
      }

      setInventoryPreview(result.preview);
      setBatchApplyResult(null);
      setSelectedPreviewReceipts(
        Object.fromEntries(
          result.preview.receipts.map((receipt) => [
            receipt.receiptId,
            receipt.status === "ready",
          ])
        )
      );
    } catch (error) {
      setInventoryPreviewError(
        error instanceof Error
          ? error.message
          : inventoryText.previewFailed
      );
    } finally {
      setIsInventoryPreviewLoading(false);
    }
  }

  function handlePreviewReceiptSelection(
    receiptId: number,
    selectedForApply: boolean
  ) {
    setSelectedPreviewReceipts((current) => ({
      ...current,
      [receiptId]: selectedForApply,
    }));
    setBatchApplyResult(null);
  }

  async function handleApplyPreviewBatch() {
    const receiptIds = inventoryPreview
      ? inventoryPreview.receipts
          .filter((receipt) => selectedPreviewReceipts[receipt.receiptId])
          .map((receipt) => receipt.receiptId)
      : [];
    if (
      !currentUser?.username ||
      !canApplyInventory ||
      receiptIds.length === 0
    ) {
      return;
    }
    if (
      !window.confirm(
        inventoryText.applyConfirm
      )
    ) {
      return;
    }

    setIsBatchApplying(true);
    setInventoryPreviewError("");
    try {
      const res = await fetch(
        "/api/admin/sales/inventory-deductions/apply",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actorUsername: currentUser.username,
            receiptIds,
          }),
        }
      );
      const result = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            validation?: BatchValidationResult;
            preview?: InventoryDeductionPreview;
            batchId?: number;
            status?: "applied" | "partially_applied";
            summary?: BatchApplyResult["summary"];
            inventoryTotals?: BatchApplyResult["inventoryTotals"];
            receipts?: BatchApplyResult["receipts"];
          }
        | null;

      if (result?.preview) {
        setInventoryPreview(result.preview);
      }
      if (
        !res.ok ||
        !result?.ok ||
        !result.batchId ||
        !result.status ||
        !result.summary
      ) {
        throw new Error(result?.error || inventoryText.applyFailed);
      }

      setBatchApplyResult({
        batchId: result.batchId,
        status: result.status,
        summary: result.summary,
        inventoryTotals: result.inventoryTotals || [],
        receipts: result.receipts || [],
      });
      setSelectedPreviewReceipts((current) =>
        Object.fromEntries(
          Object.keys(current).map((receiptId) => [Number(receiptId), false])
        )
      );
    } catch (error) {
      setInventoryPreviewError(
        error instanceof Error
          ? error.message
          : inventoryText.applyFailed
      );
    } finally {
      setIsBatchApplying(false);
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
                <button
                  type="button"
                  onClick={handleInventoryPreview}
                  disabled={isInventoryPreviewLoading || isLoading}
                  style={{
                    ...inventoryPreviewButtonStyle,
                    ...(isInventoryPreviewLoading
                      ? menuSyncButtonDisabledStyle
                      : null),
                  }}
                >
                  {isInventoryPreviewLoading
                    ? inventoryText.previewLoading
                    : inventoryText.previewButton}
                </button>
              </div>
            ) : null}
          </div>
          {menuSyncMessage ? (
            <p style={successTextStyle}>{menuSyncMessage}</p>
          ) : null}
          {menuSyncWarning ? (
            <p style={warningTextStyle}>{menuSyncWarning}</p>
          ) : null}
          {menuSyncErrorMessage ? (
            <p style={errorTextStyle}>{menuSyncErrorMessage}</p>
          ) : null}
          {inventoryPreviewError ? (
            <p style={errorTextStyle}>{inventoryPreviewError}</p>
          ) : null}
          {errorMessage ? <p style={errorTextStyle}>{errorMessage}</p> : null}
        </section>

        {inventoryPreview ? (
          <InventoryPreviewPanel
            preview={inventoryPreview}
            selectedReceipts={selectedPreviewReceipts}
            batchApplyResult={batchApplyResult}
            isBatchApplying={isBatchApplying}
            canApplyInventory={canApplyInventory}
            text={inventoryText}
            onApplyBatch={handleApplyPreviewBatch}
            onSelectionChange={handlePreviewReceiptSelection}
          />
        ) : null}

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{receiptsText.listTitle}</h2>
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
            onToggleReceipt={handleToggleReceipt}
            onSaveEdit={handleSaveReceiptEdit}
          />
        </section>
      </div>
    </Container>
  );
}

function InventoryPreviewPanel({
  preview,
  selectedReceipts,
  batchApplyResult,
  isBatchApplying,
  canApplyInventory,
  text,
  onApplyBatch,
  onSelectionChange,
}: {
  preview: InventoryDeductionPreview;
  selectedReceipts: Record<number, boolean>;
  batchApplyResult: BatchApplyResult | null;
  isBatchApplying: boolean;
  canApplyInventory: boolean;
  text: InventoryPreviewCopy;
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
  const selectedApplyDisabled =
    selectedReceiptCount === 0 ||
    !canApplyInventory ||
    isBatchApplying ||
    Boolean(batchApplyResult);

  return (
    <section style={inventoryPreviewPanelStyle}>
      <div style={inventoryPreviewHeaderStyle}>
        <div>
          <h2 style={inventoryPreviewTitleStyle}>{text.title}</h2>
          <p style={inventoryPreviewDescriptionStyle}>
            {text.description}
          </p>
        </div>
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
        <div>
          <strong>{text.applyTitle}</strong>
          <span style={inventoryBatchActionMetaStyle}>
            {text.selected} {selectedReceiptCount}
            {text.countSuffix} · {text.expectedItems}{" "}
            {preview.inventoryTotals.length}
            {text.itemSuffix}
          </span>
        </div>
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

      <details style={inventoryPreviewDetailsStyle}>
        <summary style={inventoryPreviewSummaryTitleStyle}>
          {text.needsCheckDetails} · {text.details}
        </summary>
        <div style={inventoryCheckDetailListStyle}>
          {needsCheckDetails
            .filter(([, value]) => value > 0)
            .map(([label, value]) => (
              <div key={label} style={inventoryCheckDetailItemStyle}>
                <span>{label}</span>
                <strong>
                  {formatNumber(value)}
                  {text.countSuffix}
                </strong>
              </div>
            ))}
          {needsCheckDetails.every(([, value]) => value === 0) ? (
            <p style={inventoryPreviewEmptyStyle}>
              {text.needsCheck} 0{text.countSuffix}
            </p>
          ) : null}
        </div>
      </details>

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
                <span>
                  {text.expectedDeduction} {formatNumber(total.deductQuantity)}
                </span>
                <span>{text.afterDeduction} {formatNumber(total.afterQuantity)}</span>
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

      <details style={inventoryPreviewDetailsStyle} open>
        <summary style={inventoryPreviewSummaryTitleStyle}>
          {text.receiptResults} {preview.receipts.length}
          {text.countSuffix}
        </summary>
        <div style={previewReceiptListStyle}>
          {preview.receipts.map((receipt) => {
            const partialDeduction = isPartialDeductionReceipt(receipt);
            const isExpanded = expandedReceiptIds[receipt.receiptId] === true;
            const { applicableCount, checkCount } = getReceiptLineCounts(receipt);
            return (
            <div key={receipt.receiptId} style={previewReceiptStyle}>
              <div style={previewReceiptHeaderRowStyle}>
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
                  <div>
                    <strong>{receipt.refNo || `#${receipt.receiptId}`}</strong>
                    <span style={previewReceiptMetaStyle}>
                      {text.availableCount} {formatNumber(applicableCount)} ·{" "}
                      {text.checkCount} {formatNumber(checkCount)}
                    </span>
                  </div>
                  <span
                    style={{
                      ...previewStatusStyle,
                      ...(partialDeduction
                        ? batchValidationWarningStyle
                        : receipt.status === "ready"
                        ? previewStatusReadyStyle
                        : receipt.status === "skipped"
                          ? previewStatusSkippedStyle
                        : previewStatusBlockedStyle),
                    }}
                  >
                    {getInventoryPreviewStatusLabel(receipt, text)}
                  </span>
                </button>
              </div>

              {isExpanded ? (
                <>
                  {partialDeduction ? (
                    <div style={previewPartialNoticeStyle}>
                      <p style={previewPartialNoticeTextStyle}>
                        {text.partialNotice}
                      </p>
                    </div>
                  ) : null}

                  <div style={previewLineListStyle}>
                    {receipt.lines.map((line, lineIndex) => {
                      const helpText = getLineHelpText(line, receipt, text);
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
                      return (
                        <div
                          key={`${line.receiptLineId}-${comboChildIndex}-${line.lineType}`}
                          style={{
                            ...previewLineStyle,
                            ...(line.isOption ? previewOptionLineStyle : null),
                          }}
                        >
                          <div style={previewLineTitleStyle}>
                            <strong>
                              [{getLineDisplayType(line, text)}]{" "}
                              {line.itemName || `#${line.receiptLineId}`}
                            </strong>
                            <span>
                              {isComboLine
                                ? `${text.comboDeduction} · `
                                : line.isOption
                                  ? `${text.option} · `
                                  : ""}
                              {text.saleQuantity}{" "}
                              {formatNumber(line.quantitySold)}
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
                          {helpText ? (
                            <p style={previewLineErrorStyle}>{helpText}</p>
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
  onToggleReceipt,
  onSaveEdit,
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
  onToggleReceipt: (receiptId: number) => void;
  onSaveEdit: (input: SaveReceiptEditInput) => void;
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
                onSaveEdit={onSaveEdit}
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
  onToggle,
}: {
  text: SalesReceiptsViewText;
  receipt: ReceiptItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const statusLabel = getPaymentStatusLabel(receipt, text);
  const paymentSummaryText = getPaymentSummaryText(receipt.payments, text);

  return (
    <button type="button" onClick={onToggle} style={receiptRowButtonStyle}>
      <span style={receiptMainStyle}>
        <span style={receiptTopLineStyle}>
          <strong style={receiptNoStyle}>
            {text.table}: {receipt.tableName || "-"}
          </strong>
          <span
            style={{
              ...statusBadgeStyle,
              ...(receipt.isCanceled
                ? canceledBadgeStyle
                : receipt.isModified
                  ? modifiedBadgeStyle
                  : paidBadgeStyle),
            }}
          >
            {statusLabel}
          </span>
        </span>
        <span style={receiptMetaLineStyle}>
          {receipt.refNo || receipt.refId}
          {paymentSummaryText ? ` · ${paymentSummaryText}` : ""}
        </span>
        <span style={receiptMetaLineStyle}>
          {text.salesItems} {formatNumber(receipt.lineCount)}{text.productCountSuffix} · {text.optionItems}{" "}
          {formatNumber(receipt.optionLineCount)}{text.optionCountSuffix}
        </span>
      </span>

      <span style={receiptAmountWrapStyle}>
        <span style={receiptTimeStyle}>{formatTime(receipt.refDate)}</span>
        <strong style={amountStyle}>{formatVnd(receipt.finalAmount)}</strong>
        <span style={chevronStyle}>{isExpanded ? "⌃" : "⌄"}</span>
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
  onSaveEdit,
}: {
  text: SalesReceiptsViewText;
  editText: SalesReceiptsEditViewText;
  detail?: ReceiptDetailResponse;
  isLoading: boolean;
  errorMessage: string;
  isEditSaving: boolean;
  editErrorMessage: string;
  onSaveEdit: (input: SaveReceiptEditInput) => void;
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
  const payments = detail.payments || [];
  const hasOptionLines =
    detail.hasOptionLines === true ||
    (detail.lines || []).some(isExistingOptionLine);

  // ?먮낯 ?멸툑 ?쒖떆?? API??taxSummary??original_tax_summary / vat_amount 湲곗?
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
      <DetailSection title={text.salesItems}>
        <div style={lineListStyle}>
          {(detail.lines || []).map((line) => {
            const isOption = isExistingOptionLine(line);
            const lineTotalAmount = line.finalAmount || line.amount;

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
                    {line.itemName || "-"}
                  </span>
                  {isOption ? <span style={optionBadgeStyle}>{text.optionItems}</span> : null}
                </div>
                <span
                  style={{
                    ...lineSummaryStyle,
                    ...(isOption ? optionLineSummaryStyle : null),
                  }}
                >
                  <span>{text.quantity} {formatNumber(line.quantity)}</span>
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
        key={`${receipt.id}-${receipt.modifiedAt || "original"}`}
        text={editText}
        receipt={receipt}
        lines={detail.lines || []}
        payments={payments}
        taxSavingAmount={taxSavingAmount}
        amountDifferenceAmount={amountDifferenceAmount}
        hasOptionLines={hasOptionLines}
        isSaving={isEditSaving}
        errorMessage={editErrorMessage}
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
  onSave: (values: Omit<SaveReceiptEditInput, "receiptId">) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftLines, setDraftLines] = useState<ReceiptDraftLine[]>(() =>
    lines
      .filter((line) => !isExistingOptionLine(line))
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
  const existingOptionLines = lines.filter(isExistingOptionLine);
  const [newLines, setNewLines] = useState<NewDraftLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    hasCashPayment(payments) ? "cash" : "other"
  );
  const [cashReceivedAmount, setCashReceivedAmount] = useState(
    receipt.receiveAmount ?? receipt.finalAmount
  );
  const [note, setNote] = useState(receipt.modificationNote || "");
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<PosProduct[]>([]);
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
      return () => controller.abort();
    }

    async function fetchProducts() {
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
  const draftAdjustedTaxAmount = draftLineTotals.reduce(
    (sum, line) => sum + calculateLineTaxAmount(line.finalAmount, line.taxRate),
    0
  );
  const draftPaymentTotal = draftSalesSubtotal + draftAdjustedTaxAmount;
  const returnAmount =
    paymentMethod === "cash"
      ? Math.max(0, cashReceivedAmount - draftPaymentTotal)
      : 0;
  const cashPaymentInvalid =
    paymentMethod === "cash" &&
    (!Number.isFinite(cashReceivedAmount) ||
      cashReceivedAmount < draftPaymentTotal);
  const saveDisabled = isSaving || draftSalesSubtotal <= 0 || cashPaymentInvalid;

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
        .filter((line) => !isExistingOptionLine(line))
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
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              style={editButtonStyle}
            >
              {text.title}
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
  padding: 14,
  borderBottom: "1px solid #e5e7eb",
};

const inventoryPreviewTitleStyle: CSSProperties = {
  margin: "4px 0 2px",
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
  borderBottom: "1px solid #e5e7eb",
};

const inventoryBatchActionStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "11px 14px",
  borderBottom: "1px solid #e5e7eb",
  background: "#f8fafb",
  fontSize: 12,
};

const inventoryBatchActionMetaStyle: CSSProperties = {
  display: "block",
  marginTop: 3,
  color: "#667085",
  fontSize: 10,
};

const inventoryBatchButtonsStyle: CSSProperties = {
  display: "flex",
  gap: 7,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const inventoryApplyButtonStyle: CSSProperties = {
  border: "1px solid #8b2f2f",
  borderRadius: 6,
  background: "#8b2f2f",
  color: "#ffffff",
  padding: "8px 10px",
  fontSize: 11,
  fontWeight: 800,
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
  padding: "10px 11px",
  borderRight: "1px solid #edf0f3",
  color: "#667085",
  fontSize: 10,
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

const inventoryPreviewEmptyStyle: CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  color: "#667085",
  fontSize: 11,
};

const previewReceiptListStyle: CSSProperties = {
  display: "grid",
  gap: 1,
  borderTop: "1px solid #edf0f3",
  background: "#e7eaee",
};

const previewReceiptStyle: CSSProperties = {
  background: "#ffffff",
  padding: "11px 14px",
};

const previewReceiptHeaderRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  alignItems: "center",
  gap: 8,
};

const previewReceiptHeaderButtonStyle: CSSProperties = {
  width: "100%",
  border: 0,
  background: "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
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

const previewReceiptMetaStyle: CSSProperties = {
  display: "block",
  marginTop: 3,
  color: "#667085",
  fontSize: 10,
  lineHeight: 1.35,
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

const previewPartialNoticeStyle: CSSProperties = {
  display: "grid",
  gap: 3,
  marginTop: 8,
  padding: "8px 10px",
  border: "1px solid #ead39c",
  borderRadius: 6,
  background: "#fff9eb",
  color: "#77591b",
  fontSize: 10,
};

const previewPartialNoticeTextStyle: CSSProperties = {
  margin: 0,
};

const previewLineListStyle: CSSProperties = {
  display: "grid",
  gap: 5,
  marginTop: 9,
};

const previewLineStyle: CSSProperties = {
  borderLeft: "3px solid #cbd5e1",
  background: "#f8fafb",
  padding: "8px 10px",
};

const previewOptionLineStyle: CSSProperties = {
  marginLeft: 18,
  borderLeftColor: "#7aa4b5",
};

const previewLineTitleStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  color: "#667085",
  fontSize: 10,
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
  marginTop: 6,
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
  alignItems: "center",
  gap: 10,
  textAlign: "left",
  cursor: "pointer",
};

const receiptMainStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const receiptTopLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
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

const canceledBadgeStyle: CSSProperties = {
  background: "#dc2626",
};

const modifiedBadgeStyle: CSSProperties = {
  background: "#ffee00",
  color: "#111827",
};

const receiptAmountWrapStyle: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 3,
};

const amountStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#111827",
};

const receiptTimeStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 800,
};

const chevronStyle: CSSProperties = {
  ...ui.metaText,
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
  marginLeft: 12,
  background: "#ffffff",
  borderStyle: "dashed",
};

const lineTitleRowStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
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
  height: 18,
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
