"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useLanguage } from "@/lib/language-context";
import { normalizeVietnameseText } from "@/lib/inventory/normalize";
import { getUser } from "@/lib/supabase/auth";
import styles from "./page.module.css";

type MappingStatus =
  | "unmapped"
  | "mapped"
  | "recipe_mapped"
  | "combo_mapped"
  | "ignored"
  | "manual"
  | "inactive_product"
  | "orphaned"
  | "archived"
  | "needs_review";

type MappingType = "direct" | "recipe" | "combo" | "manual" | "ignore";
type ValidationStatus = "normal" | "needs_review" | "incomplete" | "error";
type OptionMappingType = Exclude<MappingType, "combo">;
type OptionMappingStatus =
  | "unmapped"
  | "mapped"
  | "recipe_mapped"
  | "combo_mapped"
  | "ignored"
  | "manual"
  | "needs_review";

type InventoryItem = {
  id: number;
  item_name?: string | null;
  item_name_vi?: string | null;
  code?: string | null;
  unit?: string | null;
  category_name?: string | null;
  supplier_name?: string | null;
};

type PosOption = {
  id: string;
  optionId: string;
  code: string | null;
  name: string;
  optionName: string;
  groupName: string;
  unitPrice: number;
  isActive: boolean;
  status: OptionMappingStatus;
  validationStatus: ValidationStatus;
  blockedReason: string | null;
  mappingType: MappingType | null;
  inventoryItemId: number | null;
  inventoryItem: InventoryItem | null;
  quantityMultiplier: number | null;
  mapping: CatalogMapping | null;
};

type RecipeRow = {
  id: number;
  inventoryItemId: number;
  inventoryItem?: InventoryItem | null;
  quantityPerPosUnit: number;
  isActive: boolean;
  isRequired: boolean;
  version?: number;
};

type CatalogMapping = {
  id: number;
  mappingType: MappingType;
  inventoryItemId: number | null;
  inventoryItem?: InventoryItem | null;
  quantityMultiplier: number;
  isActive: boolean;
  targetType: "product" | "option";
  posOptionId: string | null;
  mappingVersion: number;
  posItemCode: string | null;
  posItemName: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  archiveReason: string | null;
  recipes: RecipeRow[];
};

type ComboChild = {
  childId: string;
  childCode: string | null;
  childName: string;
  quantity: number;
  posProductId: number | null;
  mappingType: MappingType | null;
  status: MappingStatus;
  validationStatus: ValidationStatus;
  blockedReason: string | null;
};

type LegacyCandidate = {
  id: number;
  itemCode: string | null;
  itemName: string;
  isActive: boolean;
};

type CatalogItem = {
  status: MappingStatus;
  mappingType: MappingType | null;
  validationStatus: ValidationStatus;
  blockedReason: string | null;
  needsReviewReason: string | null;
  posProduct: {
    id: number;
    posItemId: string | null;
    itemCode: string | null;
    itemName: string;
    itemNameVi: string | null;
    categoryName: string | null;
    unitName: string | null;
    isActive: boolean;
    isSold: boolean | null;
  } | null;
  mapping: CatalogMapping | null;
  legacyCandidates?: LegacyCandidate[];
  referenceCounts?: {
    recipeCount: number;
    deductionCount: number;
    processedLineCount: number;
  };
  canHardDelete?: boolean;
  comboChildren?: ComboChild[];
  options?: PosOption[];
};

type OptionBasedStatus = "option_based";
type Summary = Record<MappingStatus | OptionBasedStatus, number>;

type EditorState = {
  itemKey: string;
  mappingType: MappingType;
  inventoryItemId: string;
  quantityMultiplier: string;
  isActive: boolean;
};

type OptionEditorState = {
  optionKey: string;
  mappingType: OptionMappingType;
  inventoryItemId: string;
  quantityMultiplier: string;
  isActive: boolean;
};

type ReconcileSummary = {
  linkedCount: number;
  skippedCount: number;
  needsReviewCount: number;
  orphanedCount: number;
  inactiveProductCount: number;
  duplicateCodeCount: number;
};

type ValidationSeverity = "error" | "warning" | "info";

type ValidationIssue = {
  severity: ValidationSeverity;
  type: string;
  message: string;
  posProductId: number | null;
  posProductName: string | null;
  posItemCode: string | null;
  optionId: string | null;
  optionName: string | null;
  mappingId: number | null;
  recipeId: number | null;
};

type ValidationSummary = {
  totalProducts: number;
  activeProducts: number;
  mappedCount: number;
  recipeMappedCount: number;
  comboMappedCount?: number;
  ignoredCount: number;
  manualCount: number;
  unmappedCount: number;
  optionUnmappedCount: number;
  invalidDirectCount: number;
  invalidRecipeCount: number;
  orphanedCount: number;
  inactiveProductMappingCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  readyForPreview: boolean;
};

type ValidationResult = {
  summary: ValidationSummary;
  issues: ValidationIssue[];
  validatedAt: string;
};

type FilterValue = "all" | MappingStatus | OptionBasedStatus;

const EMPTY_SUMMARY: Summary = {
  unmapped: 0,
  mapped: 0,
  recipe_mapped: 0,
  combo_mapped: 0,
  ignored: 0,
  option_based: 0,
  manual: 0,
  inactive_product: 0,
  orphaned: 0,
  archived: 0,
  needs_review: 0,
};

const FILTERS: Array<{
  value: FilterValue;
  summaryKey?: MappingStatus | OptionBasedStatus;
}> = [
  { value: "all" },
  { value: "unmapped", summaryKey: "unmapped" },
  { value: "mapped", summaryKey: "mapped" },
  {
    value: "recipe_mapped",
    summaryKey: "recipe_mapped",
  },
  { value: "combo_mapped", summaryKey: "combo_mapped" },
  { value: "manual", summaryKey: "manual" },
  { value: "option_based", summaryKey: "option_based" },
  { value: "ignored", summaryKey: "ignored" },
  { value: "orphaned", summaryKey: "orphaned" },
  {
    value: "needs_review",
    summaryKey: "needs_review",
  },
  { value: "inactive_product", summaryKey: "inactive_product" },
  { value: "archived", summaryKey: "archived" },
];

const mappingPageText = {
  ko: {
    deleteMapping: "매핑 삭제",
    deletingMapping: "삭제 중...",
    deleteConfirm:
      "POS 상품이 아닌 구형 매핑 기록만 삭제됩니다. Inventory 품목과 재고는 삭제되지 않습니다.",
    deleteSuccess: "구형 Orphaned 매핑을 삭제했습니다.",
    deleteFailed: "Orphaned 매핑을 삭제하지 못했습니다.",
    relinkCandidate: "삭제 전 재연결 후보를 확인하세요",
    relinkMapping: "재연결",
    relinkConfirm: "선택한 POS 상품으로 이 매핑을 재연결하시겠습니까?",
    archiveMapping: "보관",
    archiveReasonPrompt: "보관 사유를 입력하세요.",
    restoreMapping: "복원",
    restoreConfirm: "이 매핑을 복원하시겠습니까?",
    actionSuccess: "매핑 상태를 변경했습니다.",
    filterLabels: {
      all: "전체",
      unmapped: "미매핑",
      mapped: "Direct",
      recipe_mapped: "Recipe",
      combo_mapped: "Combo / 묶음상품",
      manual: "Manual",
      option_based: "옵션 기준 차감",
      ignored: "Ignore",
      orphaned: "Orphaned",
      needs_review: "검토 필요",
      inactive_product: "비활성 상품",
      archived: "보관된 매핑",
    },
    filterDescriptions: {
      all: "활성 POS 상품 전체를 표시합니다.",
      unmapped: "아직 재고 차감 방식이 설정되지 않은 상품입니다.",
      mapped: "판매 시 연결된 재고 품목 하나를 설정된 배수만큼 차감합니다.",
      recipe_mapped:
        "판매 시 여러 재료 재고를 레시피 수량에 따라 차감합니다.",
      manual: "자동 차감하지 않고 관리자가 직접 확인해야 하는 상품입니다.",
      option_based:
        "기본 상품은 차감하지 않고, 선택된 옵션의 Direct/Recipe 기준으로 재고를 차감합니다.",
      ignored: "재고 차감 대상에서 제외한 상품이나 옵션입니다.",
      orphaned:
        "POS 매핑 기록은 남아 있지만 현재 POS 상품 목록에서 연결 대상을 찾을 수 없는 항목입니다.",
      needs_review:
        "상품 변경이나 연결 불확실성 때문에 관리자의 확인이 필요한 항목입니다.",
      inactive_product: "POS에서 현재 사용하지 않는 상품입니다.",
      archived: "운영 및 차감 흐름에서 제외되어 보관 중인 매핑입니다.",
    },
    inventorySearch: "Inventory 품목 검색",
    inventorySelect: "품목 선택",
    inventoryClear: "선택 해제",
    inventoryLoading: "Inventory 품목을 불러오는 중입니다.",
    inventoryEmpty: "검색 결과가 없습니다.",
    inventorySelected: "선택됨",
    optionBasedDeduction: "옵션 기준 차감",
    optionBasedDeductionDescription:
      "기본 상품은 차감하지 않고, 선택된 옵션의 Direct/Recipe 기준으로 재고를 차감합니다.",
    directNeedsInventory: "직접차감은 재고 품목을 선택해야 합니다.",
    optionDirectNeedsInventory: "옵션 직접차감은 재고 품목을 선택해야 합니다.",
    recipeNeedsInventory: "레시피 재료로 사용할 재고 품목을 선택해야 합니다.",
    reconcileTitle: "최근 재검사 결과",
    reconcileLinked: "연결",
    reconcileDuplicateCode: "중복 코드",
    reconcileSkipped: "변경 없음",
    recipeNotice: "레시피는 저장 후 재료를 별도로 설정합니다. 재료가 없으면 재료 필요로 표시됩니다.",
    optionRecipeNotice: "옵션 레시피는 저장 후 재료를 별도로 설정합니다.",
    filterAriaLabel: "상태 필터",
  },
  vi: {
    deleteMapping: "Xóa mapping",
    deletingMapping: "Đang xóa...",
    deleteConfirm:
      "Chỉ bản ghi mapping cũ không phải sản phẩm POS bị xóa. Mặt hàng Inventory và tồn kho không bị xóa.",
    deleteSuccess: "Đã xóa mapping Orphaned cũ.",
    deleteFailed: "Không thể xóa mapping Orphaned.",
    relinkCandidate: "Kiểm tra ứng viên liên kết lại trước khi xóa",
    relinkMapping: "Liên kết lại",
    relinkConfirm: "Liên kết lại mapping này với sản phẩm POS đã chọn?",
    archiveMapping: "Lưu trữ",
    archiveReasonPrompt: "Nhập lý do lưu trữ.",
    restoreMapping: "Khôi phục",
    restoreConfirm: "Khôi phục mapping này?",
    actionSuccess: "Đã cập nhật trạng thái mapping.",
    filterLabels: {
      all: "Tất cả",
      unmapped: "Chưa ánh xạ",
      mapped: "Direct",
      recipe_mapped: "Recipe",
      combo_mapped: "Combo / Món combo",
      manual: "Manual",
      option_based: "Theo tuỳ chọn",
      ignored: "Ignore",
      orphaned: "Orphaned",
      needs_review: "Cần kiểm tra",
      inactive_product: "Sản phẩm ngừng dùng",
      archived: "Mapping đã lưu trữ",
    },
    filterDescriptions: {
      all: "Hiển thị toàn bộ sản phẩm POS đang hoạt động.",
      unmapped: "Sản phẩm chưa được thiết lập cách trừ tồn kho.",
      mapped:
        "Khi bán, trừ một mặt hàng tồn kho theo hệ số đã thiết lập.",
      recipe_mapped:
        "Khi bán, trừ nhiều nguyên liệu theo định lượng trong công thức.",
      manual:
        "Không tự động trừ kho và cần quản trị viên kiểm tra thủ công.",
      option_based:
        "Sản phẩm chính không trừ kho; tồn kho được trừ theo Direct/Recipe của tùy chọn đã chọn.",
      ignored: "Sản phẩm hoặc tùy chọn được loại khỏi xử lý trừ tồn kho.",
      orphaned:
        "Bản ghi mapping vẫn còn nhưng không tìm thấy sản phẩm tương ứng trong danh sách POS hiện tại.",
      needs_review:
        "Cần quản trị viên kiểm tra do sản phẩm thay đổi hoặc liên kết chưa chắc chắn.",
      inactive_product: "Sản phẩm hiện không còn được sử dụng trong POS.",
      archived: "Mapping được lưu trữ và loại khỏi quy trình vận hành.",
    },
    inventorySearch: "Tìm mặt hàng tồn kho",
    inventorySelect: "Chọn mặt hàng",
    inventoryClear: "Bỏ chọn",
    inventoryLoading: "Đang tải danh sách tồn kho.",
    inventoryEmpty: "Không có kết quả.",
    inventorySelected: "Đã chọn",
    optionBasedDeduction: "Theo tuỳ chọn",
    optionBasedDeductionDescription:
      "Sản phẩm chính không trừ kho; tồn kho được trừ theo Direct/Recipe của tùy chọn đã chọn.",
    directNeedsInventory: "Trừ trực tiếp cần chọn mặt hàng tồn kho.",
    optionDirectNeedsInventory: "Tùy chọn trừ trực tiếp cần chọn mặt hàng tồn kho.",
    recipeNeedsInventory: "Cần chọn mặt hàng tồn kho làm nguyên liệu công thức.",
    reconcileTitle: "Kết quả kiểm tra gần đây",
    reconcileLinked: "Liên kết",
    reconcileDuplicateCode: "Mã trùng",
    reconcileSkipped: "Không thay đổi",
    recipeNotice: "Công thức cần thiết lập nguyên liệu sau khi lưu.",
    optionRecipeNotice: "Công thức tùy chọn cần thiết lập nguyên liệu sau khi lưu.",
    filterAriaLabel: "Bộ lọc trạng thái",
  },
} as const;

type AppLanguage = keyof typeof mappingPageText;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const STATUS_LABELS: Record<MappingStatus, string> = {
  unmapped: "미매핑",
  mapped: "Direct",
  recipe_mapped: "Recipe",
  combo_mapped: "Combo",
  ignored: "Ignore",
  manual: "Manual",
  inactive_product: "비활성 상품",
  orphaned: "Orphaned",
  archived: "보관",
  needs_review: "검토 필요",
};

const MAPPING_TYPE_LABELS: Record<MappingType, string> = {
  direct: "Direct",
  recipe: "Recipe",
  combo: "Combo / 묶음상품",
  manual: "Manual",
  ignore: "Ignore",
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const VALIDATION_STATUS_LABELS: Record<ValidationStatus, string> = {
  normal: "정상",
  needs_review: "검토 필요",
  incomplete: "미완성",
  error: "오류",
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const OPTION_STATUS_LABELS: Record<OptionMappingStatus, string> = {
  unmapped: "미매핑",
  mapped: "Direct",
  recipe_mapped: "Recipe",
  combo_mapped: "Combo",
  ignored: "Ignore",
  manual: "Manual",
  needs_review: "검토 필요",
};

const DISPLAY_STATUS_LABELS = {
  ko: {
    unmapped: "미설정",
    mapped: "직접차감",
    recipe_mapped: "레시피",
    combo_mapped: "묶음상품",
    ignored: "차감제외",
    manual: "수동확인",
    inactive_product: "비활성",
    orphaned: "연결끊김",
    archived: "보관",
    needs_review: "검토필요",
  },
  vi: {
    unmapped: "Chưa liên kết",
    mapped: "Trừ trực tiếp",
    recipe_mapped: "Công thức",
    combo_mapped: "Món theo nhóm",
    ignored: "Không trừ kho",
    manual: "Kiểm tra thủ công",
    inactive_product: "Ngừng bán",
    orphaned: "Mất liên kết",
    archived: "Lưu trữ",
    needs_review: "Cần kiểm tra",
  },
} as const;

const DISPLAY_MAPPING_TYPE_LABELS = {
  ko: {
    direct: "직접차감",
    recipe: "레시피",
    combo: "묶음상품",
    manual: "수동확인",
    ignore: "차감제외",
  },
  vi: {
    direct: "Trừ trực tiếp",
    recipe: "Công thức",
    combo: "Món theo nhóm",
    manual: "Kiểm tra thủ công",
    ignore: "Không trừ kho",
  },
} as const;

const DISPLAY_VALIDATION_STATUS_LABELS = {
  ko: {
    normal: "차감가능",
    needs_review: "검토필요",
    incomplete: "재료 필요",
    error: "확인필요",
  },
  vi: {
    normal: "Có thể trừ kho",
    needs_review: "Cần kiểm tra",
    incomplete: "Cần nguyên liệu",
    error: "Cần kiểm tra",
  },
} as const;

const DISPLAY_OPTION_STATUS_LABELS = {
  ko: {
    unmapped: "미설정",
    mapped: "직접차감",
    recipe_mapped: "레시피",
    combo_mapped: "묶음상품",
    ignored: "차감제외",
    manual: "수동확인",
    needs_review: "검토필요",
  },
  vi: {
    unmapped: "Chưa liên kết",
    mapped: "Trừ trực tiếp",
    recipe_mapped: "Công thức",
    combo_mapped: "Món theo nhóm",
    ignored: "Không trừ kho",
    manual: "Kiểm tra thủ công",
    needs_review: "Cần kiểm tra",
  },
} as const;

const DISPLAY_FILTER_LABELS = {
  ko: {
    all: "전체",
    unmapped: "미설정",
    mapped: "직접차감",
    recipe_mapped: "레시피",
    combo_mapped: "묶음상품",
    manual: "수동확인",
    option_based: "옵션차감",
    ignored: "차감제외",
    orphaned: "연결끊김",
    needs_review: "검토필요",
    inactive_product: "비활성",
    archived: "보관",
  },
  vi: {
    all: "Tất cả",
    unmapped: "Chưa liên kết",
    mapped: "Trừ trực tiếp",
    recipe_mapped: "Công thức",
    combo_mapped: "Món theo nhóm",
    manual: "Kiểm tra thủ công",
    option_based: "Trừ theo tùy chọn",
    ignored: "Không trừ kho",
    orphaned: "Mất liên kết",
    needs_review: "Cần kiểm tra",
    inactive_product: "Ngừng bán",
    archived: "Lưu trữ",
  },
} as const;

const DISPLAY_FILTER_DESCRIPTIONS = {
  ko: {
    all: "활성 POS 상품 전체를 표시합니다.",
    unmapped: "아직 재고 차감 방식이 설정되지 않은 상품입니다.",
    mapped: "판매 시 연결된 재고 품목을 직접 차감합니다.",
    recipe_mapped: "판매 시 레시피 재료 기준으로 재고를 차감합니다.",
    combo_mapped: "구성 상품의 기존 매핑을 재사용해 재고를 차감합니다.",
    manual: "자동 차감하지 않고 운영자가 직접 확인해야 하는 상품입니다.",
    option_based: "기본 상품은 제외하고 선택된 옵션 기준으로 차감합니다.",
    ignored: "재고 차감 대상에서 제외된 상품이나 옵션입니다.",
    orphaned: "현재 POS 상품 목록과 연결되지 않은 기존 매핑입니다.",
    needs_review: "연결이나 설정 확인이 필요한 항목입니다.",
    inactive_product: "POS에서 현재 비활성 상태인 상품입니다.",
    archived: "운영 및 차감 흐름에서 제외되어 보관 중인 매핑입니다.",
  },
  vi: {
    all: "Hiển thị tất cả món POS đang hoạt động.",
    unmapped: "Món chưa có liên kết trừ kho.",
    mapped: "Trừ trực tiếp mặt hàng tồn kho đã liên kết.",
    recipe_mapped: "Trừ kho theo nguyên liệu công thức.",
    combo_mapped: "Trừ kho theo các món trong nhóm.",
    manual: "Cần kiểm tra thủ công.",
    option_based: "Trừ kho theo tùy chọn POS.",
    ignored: "Không xử lý trừ kho.",
    orphaned: "Liên kết cũ không còn khớp món POS.",
    needs_review: "Cần kiểm tra liên kết hoặc thiết lập.",
    inactive_product: "Món đã ngừng bán trên POS.",
    archived: "Liên kết đã lưu trữ.",
  },
} as const;

const OPTION_BASED_DESCRIPTION = {
  ko: "기본 상품은 제외하고 선택된 POS 옵션 기준으로 재고를 차감합니다.",
  vi: "Sản phẩm chính không trừ kho; trừ kho theo tùy chọn POS đã chọn.",
} as const;

const DISPLAY_UI_TEXT = {
  ko: {
    search: "상품 검색",
    searchPlaceholder: "상품명, 코드, 카테고리",
    itemCount: "개 항목",
    listDescription: "상품 레시피와 POS 옵션 매핑은 각각 관리됩니다.",
  },
  vi: {
    search: "Tìm món",
    searchPlaceholder: "Tên món, mã, danh mục",
    itemCount: "mục",
    listDescription: "Công thức món và liên kết tùy chọn POS được quản lý riêng.",
  },
} as const;

const COMBO_TEXT = {
  ko: {
    title: "구성 상품",
    deduction: "구성 상품 기준으로 재고를 차감합니다.",
    needsCheck: "구성 상품 중 확인이 필요한 항목이 있습니다.",
    empty: "POS Children 정보가 없어 구성 상품 매핑 확인이 필요합니다.",
    summary: "구성 상품",
    applicable: "차감가능",
    needsReview: "확인필요",
    excluded: "차감제외",
    setup: "설정",
    check: "확인",
    ingredientNeeded: "재료 필요",
    mappingNeeded: "매핑 필요",
    available: "차감가능",
  },
  vi: {
    title: "Món trong nhóm",
    deduction: "Trừ kho theo các món trong nhóm.",
    needsCheck: "Có món trong nhóm cần kiểm tra.",
    empty: "Thiếu món trong nhóm, cần kiểm tra liên kết POS.",
    summary: "Món trong nhóm",
    applicable: "Có thể trừ",
    needsReview: "Cần kiểm tra",
    excluded: "Không trừ kho",
    setup: "Cài đặt",
    check: "Kiểm tra",
    ingredientNeeded: "Cần nguyên liệu",
    mappingNeeded: "Cần liên kết",
    available: "Có thể trừ kho",
  },
} as const;


function getItemKey(item: CatalogItem) {
  if (item.mapping) return `mapping-${item.mapping.id}`;
  return `product-${item.posProduct?.id ?? "unknown"}`;
}

function getCatalogItemCode(item: CatalogItem) {
  return (item.posProduct?.itemCode || item.mapping?.posItemCode || "").trim();
}

function getCatalogItemName(item: CatalogItem) {
  return (
    item.posProduct?.itemName ||
    item.mapping?.posItemName ||
    ""
  ).trim();
}

function compareCatalogItems(left: CatalogItem, right: CatalogItem) {
  const leftCode = getCatalogItemCode(left);
  const rightCode = getCatalogItemCode(right);

  if (leftCode && !rightCode) return -1;
  if (!leftCode && rightCode) return 1;

  if (leftCode && rightCode) {
    const codeCompare = leftCode.localeCompare(rightCode, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (codeCompare !== 0) return codeCompare;
  }

  return getCatalogItemName(left).localeCompare(
    getCatalogItemName(right),
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    }
  );
}

function getInventoryLabel(item: InventoryItem) {
  const name = item.item_name_vi || item.item_name || `품목 #${item.id}`;
  const code = item.code ? ` [${item.code}]` : "";
  const unit = item.unit ? ` / ${item.unit}` : "";
  return `${name}${code}${unit}`;
}

function getInventorySearchText(item: InventoryItem) {
  return normalizeVietnameseText(
    [
      item.item_name,
      item.item_name_vi,
      item.code,
      item.unit,
      item.category_name,
      item.supplier_name,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripDuplicateCode(name: string, code: string | null) {
  if (!code) return name.trim();
  const escapedCode = escapeRegExp(code);
  return name
    .replace(new RegExp(`^\\s*\\[${escapedCode}\\]\\s*`, "i"), "")
    .replace(new RegExp(`^\\s*${escapedCode}\\s+`, "i"), "")
    .trim();
}

function getComboChildStatus(
  child: ComboChild,
  text: (typeof COMBO_TEXT)[AppLanguage]
) {
  if (child.mappingType === "ignore") {
    return text.excluded;
  }
  if (!child.mappingType) {
    return text.mappingNeeded;
  }
  if (child.validationStatus === "normal") {
    return text.available;
  }
  if (child.mappingType === "recipe") {
    return text.ingredientNeeded;
  }
  return text.needsReview;
}

function getComboSummary(children: ComboChild[]) {
  return children.reduce(
    (summary, child) => {
      if (child.mappingType === "ignore") {
        summary.excluded += 1;
      } else if (child.validationStatus === "normal") {
        summary.applicable += 1;
      } else {
        summary.needsReview += 1;
      }
      return summary;
    },
    { applicable: 0, needsReview: 0, excluded: 0 }
  );
}

function getDisplayBlockedReason(item: CatalogItem, lang: AppLanguage) {
  if (item.mapping?.mappingType !== "combo") return item.blockedReason;
  if (!item.blockedReason) return COMBO_TEXT[lang].deduction;
  return (item.comboChildren || []).some(
    (child) =>
      child.mappingType !== "ignore" && child.validationStatus !== "normal"
  )
    ? COMBO_TEXT[lang].needsCheck
    : COMBO_TEXT[lang].deduction;
}

function isOptionBasedDeductionItem(item: CatalogItem) {
  return (
    item.mappingType === "ignore" &&
    (item.options || []).some(
      (option) =>
        option.mappingType === "direct" || option.mappingType === "recipe"
    )
  );
}

function InventoryCombobox({
  items,
  value,
  onChange,
  name,
  disabled = false,
  required = false,
  loading = false,
  text,
}: {
  items: InventoryItem[];
  value: string;
  onChange: (value: string) => void;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  loading?: boolean;
  text: (typeof mappingPageText)[keyof typeof mappingPageText];
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedItem = useMemo(
    () => items.find((item) => String(item.id) === value) ?? null,
    [items, value]
  );
  const selectedLabel = selectedItem ? getInventoryLabel(selectedItem) : "";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(selectedLabel);
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredItems = useMemo(() => {
    const normalizedQuery =
      query === selectedLabel ? "" : normalizeVietnameseText(query);
    if (!normalizedQuery) return items;
    return items.filter((item) =>
      getInventorySearchText(item).includes(normalizedQuery)
    );
  }, [items, query, selectedLabel]);
  const safeActiveIndex = Math.min(
    activeIndex,
    Math.max(filteredItems.length - 1, 0)
  );

  function selectItem(item: InventoryItem) {
    onChange(String(item.id));
    setQuery(getInventoryLabel(item));
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      const nextIndex = Math.min(
        safeActiveIndex + 1,
        Math.max(filteredItems.length - 1, 0)
      );
      setActiveIndex(nextIndex);
      requestAnimationFrame(() =>
        optionRefs.current[nextIndex]?.scrollIntoView({ block: "nearest" })
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const nextIndex = Math.max(safeActiveIndex - 1, 0);
      setActiveIndex(nextIndex);
      requestAnimationFrame(() =>
        optionRefs.current[nextIndex]?.scrollIntoView({ block: "nearest" })
      );
      return;
    }

    if (event.key === "Enter" && open && filteredItems[safeActiveIndex]) {
      event.preventDefault();
      selectItem(filteredItems[safeActiveIndex]);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setQuery(selectedLabel);
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (
      event.relatedTarget instanceof Node &&
      rootRef.current?.contains(event.relatedTarget)
    ) {
      return;
    }
    setOpen(false);
    setQuery(selectedLabel);
  }

  return (
    <div
      ref={rootRef}
      className={styles.inventoryCombobox}
      onBlur={handleBlur}
    >
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <div className={styles.comboInputRow}>
        <input
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={
            open && filteredItems[safeActiveIndex]
              ? `${listboxId}-${filteredItems[safeActiveIndex].id}`
              : undefined
          }
          aria-required={required}
          autoComplete="off"
          disabled={disabled}
          value={open ? query : selectedLabel}
          placeholder={text.inventorySearch}
          onFocus={(event) => {
            setQuery(selectedLabel);
            setOpen(true);
            setActiveIndex(0);
            event.currentTarget.select();
          }}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(0);
            if (!event.target.value) onChange("");
          }}
          onKeyDown={handleKeyDown}
        />
        {value && !disabled ? (
          <button
            type="button"
            className={styles.comboClearButton}
            aria-label={text.inventoryClear}
            onClick={() => {
              onChange("");
              setQuery("");
              setOpen(true);
              setActiveIndex(0);
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      {open && !disabled ? (
        <div
          id={listboxId}
          role="listbox"
          className={styles.comboListbox}
        >
          {loading ? (
            <div className={styles.comboMessage}>{text.inventoryLoading}</div>
          ) : filteredItems.length === 0 ? (
            <div className={styles.comboMessage}>{text.inventoryEmpty}</div>
          ) : (
            filteredItems.map((item, index) => {
              const isSelected = String(item.id) === value;
              const isActive = index === safeActiveIndex;
              return (
                <button
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  id={`${listboxId}-${item.id}`}
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`${styles.comboOption} ${
                    isActive ? styles.comboOptionActive : ""
                  } ${isSelected ? styles.comboOptionSelected : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectItem(item)}
                >
                  <strong>
                    {item.item_name_vi || item.item_name || `#${item.id}`}
                  </strong>
                  <span>
                    {[item.item_name, item.code, item.unit]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {isSelected ? <em>{text.inventorySelected}</em> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

async function getJson(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    [key: string]: unknown;
  };

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || payload.message || "요청에 실패했습니다.");
  }

  return payload;
}

export default function AdminPosMappingsPage() {
  const { lang } = useLanguage();
  const pageText = mappingPageText[lang];
  const productListRef = useRef<HTMLElement>(null);
  const [actorUsername, setActorUsername] = useState("");
  const [actorRole, setActorRole] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [statusFilter, setStatusFilter] = useState<FilterValue>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recipeSavingKey, setRecipeSavingKey] = useState("");
  const [recipeInventorySelections, setRecipeInventorySelections] = useState<
    Record<number, string>
  >({});
  const [optionSaving, setOptionSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [validating, setValidating] = useState(false);
  const [deletingMappingId, setDeletingMappingId] = useState<number | null>(
    null
  );
  const [mappingActionId, setMappingActionId] = useState<number | null>(null);
  const [recipeSetupMappingId, setRecipeSetupMappingId] = useState<
    number | null
  >(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [optionEditor, setOptionEditor] =
    useState<OptionEditorState | null>(null);
  const [reconcileSummary, setReconcileSummary] =
    useState<ReconcileSummary | null>(null);
  const [validationResult, setValidationResult] =
    useState<ValidationResult | null>(null);

  useEffect(() => {
    const user = getUser() as
      | { username?: string; role?: string; name?: string }
      | null;
    const username = user?.username?.trim() || "";
    setActorUsername(username);
    setActorRole(user?.role?.trim() || "");
    if (!username) setLoading(false);
  }, []);

  const loadInventory = useCallback(async () => {
    const response = await fetch("/api/inventory/items", { cache: "no-store" });
    const payload = (await getJson(response)) as {
      data?: InventoryItem[];
    };
    setInventoryItems(
      [...(payload.data || [])].sort((left, right) =>
        getInventoryLabel(left).localeCompare(getInventoryLabel(right), "ko")
      )
    );
  }, []);

  const loadMappings = useCallback(async () => {
    if (!actorUsername) return;

    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        actorUsername,
        status: statusFilter,
        includeOptions: "true",
        limit: "500",
      });
      const response = await fetch(`/api/admin/pos/mappings?${params}`, {
        cache: "no-store",
      });
      const payload = (await getJson(response)) as {
        items?: CatalogItem[];
        summary?: Summary;
      };
      setItems(payload.items || []);
      setSummary({ ...EMPTY_SUMMARY, ...(payload.summary || {}) });
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "매핑 목록을 불러오지 못했습니다."
      );
    } finally {
      setLoading(false);
    }
  }, [actorUsername, statusFilter]);

  useEffect(() => {
    if (!actorUsername) return;

    void Promise.all([loadMappings(), loadInventory()]).catch(
      (loadError: unknown) => {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "관리 화면 데이터를 불러오지 못했습니다."
        );
      }
    );
  }, [actorUsername, loadInventory, loadMappings]);

  const inventoryById = useMemo(
    () =>
      new Map(
        inventoryItems.map((inventoryItem) => [
          Number(inventoryItem.id),
          inventoryItem,
        ])
      ),
    [inventoryItems]
  );

  const visibleItems = useMemo(() => {
    const activeFilteredItems =
      statusFilter === "inactive_product"
        ? items.filter(
            (item) =>
              item.status === "inactive_product" ||
              item.posProduct?.isActive === false
          )
        : items.filter(
            (item) =>
              item.status !== "inactive_product" &&
              item.posProduct?.isActive !== false
          );
    const keyword = normalizeVietnameseText(search);
    const searchedItems = keyword
      ? activeFilteredItems.filter((item) =>
          normalizeVietnameseText(
            [
              item.posProduct?.itemName,
              item.posProduct?.itemNameVi,
              item.posProduct?.itemCode,
              item.posProduct?.categoryName,
              item.mapping?.posItemName,
              item.mapping?.posItemCode,
            ]
              .filter(Boolean)
              .join(" ")
          ).includes(keyword)
        )
      : activeFilteredItems;

    return [...searchedItems].sort(compareCatalogItems);
  }, [items, search, statusFilter]);

  useEffect(() => {
    productListRef.current?.scrollTo({ top: 0 });
  }, [statusFilter]);

  const totalCatalogCount = Object.entries(summary)
    .filter(
      ([key]) =>
        key !== "orphaned" &&
        key !== "archived" &&
        key !== "needs_review" &&
        key !== "option_based"
    )
    .reduce((total, [, count]) => total + count, 0);

  function beginEdit(item: CatalogItem) {
    setNotice("");
    setError("");
    setOptionEditor(null);
    setEditor({
      itemKey: getItemKey(item),
      mappingType: item.mapping?.mappingType || "direct",
      inventoryItemId: item.mapping?.inventoryItemId
        ? String(item.mapping.inventoryItemId)
        : "",
      quantityMultiplier: String(item.mapping?.quantityMultiplier || 1),
      isActive: item.mapping?.isActive ?? true,
    });
  }

  function beginOptionEdit(item: CatalogItem, option: PosOption) {
    if (!item.posProduct) return;

    setNotice("");
    setError("");
    setEditor(null);
    setOptionEditor({
      optionKey: `${item.posProduct.id}:${option.optionId}`,
      mappingType:
        option.mappingType === "direct" ||
        option.mappingType === "recipe" ||
        option.mappingType === "manual" ||
        option.mappingType === "ignore"
          ? option.mappingType
          : "direct",
      inventoryItemId: option.inventoryItemId
        ? String(option.inventoryItemId)
        : "",
      quantityMultiplier: String(option.quantityMultiplier || 1),
      isActive: option.mapping?.isActive ?? true,
    });
  }

  async function saveMapping(event: FormEvent, item: CatalogItem) {
    event.preventDefault();
    if (!editor || !actorUsername) return;

    if (editor.mappingType === "direct" && !editor.inventoryItemId) {
      setError(pageText.directNeedsInventory);
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      const body = {
        actorUsername,
        mappingType: editor.mappingType,
        inventoryItemId:
          editor.mappingType === "direct"
            ? Number(editor.inventoryItemId)
            : null,
        quantityMultiplier: Number(editor.quantityMultiplier),
        isActive: editor.isActive,
        targetType: item.mapping?.targetType || "product",
        posProductId: item.posProduct?.id ?? undefined,
        posOptionId: item.mapping?.posOptionId ?? undefined,
      };
      const hasMapping = Boolean(item.mapping);
      const url = hasMapping
        ? `/api/admin/pos/mappings/${item.mapping?.id}`
        : "/api/admin/pos/mappings";
      const response = await fetch(url, {
        method: hasMapping ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await getJson(response)) as {
        mapping?: { id?: number; mappingType?: MappingType };
      };
      setEditor(null);
      setValidationResult(null);
      setNotice("매핑 설정을 저장했습니다.");
      if (
        editor.mappingType === "recipe" &&
        Number(payload.mapping?.id) > 0
      ) {
        setRecipeSetupMappingId(Number(payload.mapping?.id));
      }
      await loadMappings();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "매핑 설정을 저장하지 못했습니다."
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveOptionMapping(
    event: FormEvent,
    item: CatalogItem,
    option: PosOption
  ) {
    event.preventDefault();
    if (!optionEditor || !actorUsername || !item.posProduct) return;

    if (
      optionEditor.mappingType === "direct" &&
      !optionEditor.inventoryItemId
    ) {
      setError(pageText.optionDirectNeedsInventory);
      return;
    }

    setOptionSaving(true);
    setError("");
    setNotice("");
    try {
      const body = {
        actorUsername,
        mappingType: optionEditor.mappingType,
        inventoryItemId:
          optionEditor.mappingType === "direct"
            ? Number(optionEditor.inventoryItemId)
            : null,
        quantityMultiplier: Number(optionEditor.quantityMultiplier),
        isActive: optionEditor.isActive,
        targetType: "option",
        posProductId: item.posProduct.id,
        posOptionId: option.optionId,
      };
      const response = await fetch(
        option.mapping
          ? `/api/admin/pos/mappings/${option.mapping.id}`
          : "/api/admin/pos/mappings",
        {
          method: option.mapping ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const payload = (await getJson(response)) as {
        mapping?: { id?: number; mappingType?: MappingType };
      };
      setOptionEditor(null);
      setValidationResult(null);
      setNotice(`옵션 '${option.optionName}' 매핑을 저장했습니다.`);
      if (
        optionEditor.mappingType === "recipe" &&
        Number(payload.mapping?.id) > 0
      ) {
        setRecipeSetupMappingId(Number(payload.mapping?.id));
      }
      await loadMappings();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "옵션 매핑을 저장하지 못했습니다."
      );
    } finally {
      setOptionSaving(false);
    }
  }

  async function saveRecipe(
    event: FormEvent<HTMLFormElement>,
    mappingId: number,
    recipeId?: number
  ) {
    event.preventDefault();
    if (!actorUsername) return;

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const inventoryItemId = Number(form.get("inventoryItemId"));
    const quantityPerPosUnit = Number(form.get("quantityPerPosUnit"));
    const isRequired = form.get("isRequired") === "on";
    const isActive = recipeId ? form.get("isActive") === "on" : true;
    const savingKey = recipeId
      ? `recipe-${recipeId}`
      : `recipe-new-${mappingId}`;

    if (!recipeId && (!Number.isInteger(inventoryItemId) || inventoryItemId <= 0)) {
      setError(pageText.recipeNeedsInventory);
      return;
    }

    setRecipeSavingKey(savingKey);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        recipeId
          ? `/api/admin/pos/mappings/${mappingId}/recipes/${recipeId}`
          : `/api/admin/pos/mappings/${mappingId}/recipes`,
        {
          method: recipeId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actorUsername,
            ...(recipeId ? {} : { inventoryItemId }),
            quantityPerPosUnit,
            isRequired,
            isActive,
          }),
        }
      );
      await getJson(response);
      if (!recipeId) {
        formElement.reset();
        setRecipeInventorySelections((current) => ({
          ...current,
          [mappingId]: "",
        }));
      }
      setValidationResult(null);
      setNotice(recipeId ? "레시피 재료를 수정했습니다." : "레시피 재료를 추가했습니다.");
      await loadMappings();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "레시피 재료를 저장하지 못했습니다."
      );
    } finally {
      setRecipeSavingKey("");
    }
  }

  async function disableRecipe(mappingId: number, recipeId: number) {
    if (!actorUsername) return;

    const savingKey = `recipe-${recipeId}`;
    setRecipeSavingKey(savingKey);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/admin/pos/mappings/${mappingId}/recipes/${recipeId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actorUsername }),
        }
      );
      await getJson(response);
      setValidationResult(null);
      setNotice("레시피 재료를 비활성화했습니다.");
      await loadMappings();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "레시피 재료를 비활성화하지 못했습니다."
      );
    } finally {
      setRecipeSavingKey("");
    }
  }

  function renderComboChildren(item: CatalogItem) {
    if (item.mapping?.mappingType !== "combo") return null;
    return renderComboChildrenCompact(item);
    // Legacy layout below is retained only to minimize churn in this dirty file.
    const children = item.comboChildren || [];

    return (
      <section className={styles.comboChildren}>
        <header>
          <strong>구성 상품</strong>
          <span>구성 상품 기준 차감</span>
        </header>
        {children.length === 0 ? (
          <p className={styles.editorNotice}>
            POS Children 정보가 없어 구성 상품 매핑 확인이 필요합니다.
          </p>
        ) : (
          <div className={styles.comboChildRows}>
            {children.map((child) => (
              <div
                key={`${child.childId}-${child.childCode || ""}`}
                className={styles.comboChildRow}
              >
                <div>
                  <strong>
                    {child.childCode ? `[${child.childCode}] ` : ""}
                    {child.childName}
                  </strong>
                  <span>
                    x {child.quantity} ·{" "}
                    {child.mappingType
                      ? MAPPING_TYPE_LABELS[child.mappingType]
                      : "매핑 확인 필요"}
                  </span>
                </div>
                <span
                  className={`${styles.statusBadge} ${
                    child.validationStatus === "normal"
                      ? styles.statusNormal
                      : styles.statusNeedsReview
                  }`}
                >
                  {child.validationStatus === "normal"
                    ? "차감가능"
                    : "확인필요"}
                </span>
                {child.blockedReason ? (
                  <p>{child.blockedReason}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderComboChildrenCompact(item: CatalogItem) {
    if (item.mapping?.mappingType !== "combo") return null;
    const children = item.comboChildren || [];
    const comboText = COMBO_TEXT[lang];
    const summary = getComboSummary(children);

    return (
      <section className={styles.comboChildren}>
        <header>
          <div>
            <strong>{comboText.title}</strong>
            <span>{comboText.deduction}</span>
          </div>
          <p>
            <span>
              {comboText.summary} {children.length}{lang === "ko" ? "개" : ""} ·{" "}
              {comboText.applicable} {summary.applicable} ·{" "}
              {comboText.needsReview} {summary.needsReview}
              {summary.excluded > 0
                ? ` · ${comboText.excluded} ${summary.excluded}`
                : ""}
            </span>
          </p>
        </header>
        {children.length === 0 ? (
          <p className={styles.editorNotice}>{comboText.empty}</p>
        ) : (
          <div className={styles.comboChildRows}>
            {children.map((child) => {
              const displayName = stripDuplicateCode(
                child.childName,
                child.childCode
              );
              const childStatus = getComboChildStatus(child, comboText);

              return (
                <div
                  key={`${child.childId}-${child.childCode || ""}`}
                  className={styles.comboChildRow}
                >
                  <div className={styles.comboChildName}>
                    <strong>
                      {child.childCode ? `[${child.childCode}] ` : ""}
                      {displayName}
                    </strong>
                    <span>x {child.quantity}</span>
                  </div>
                  <div className={styles.comboChildState}>
                    <strong>
                      {child.mappingType
                        ? DISPLAY_MAPPING_TYPE_LABELS[lang][child.mappingType]
                        : comboText.mappingNeeded}
                    </strong>
                    <span>{childStatus}</span>
                  </div>
                  <button
                    type="button"
                    className={styles.comboChildAction}
                    onClick={() => {
                      setSearch(child.childCode || child.childName);
                    }}
                  >
                    {child.validationStatus === "normal"
                      ? comboText.check
                      : comboText.setup}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  function renderRecipeManager(mapping: CatalogMapping, title = "레시피 관리") {
    const activeRecipeCount = mapping.recipes.filter(
      (recipe) => recipe.isActive
    ).length;

    return (
      <details
        className={`${styles.recipeManager} ${
          recipeSetupMappingId === mapping.id
            ? styles.recipeManagerPending
            : ""
        }`}
        open={recipeSetupMappingId === mapping.id ? true : undefined}
        onToggle={(event) => {
          if (
            !event.currentTarget.open &&
            recipeSetupMappingId === mapping.id
          ) {
            setRecipeSetupMappingId(null);
          }
        }}
      >
        <summary>
          <span>{title}</span>
          {activeRecipeCount === 0 ? (
            <strong>레시피 재료 필요</strong>
          ) : (
            <em>활성 재료 {activeRecipeCount}개</em>
          )}
        </summary>
        <div className={styles.recipeBody}>
          {mapping.recipes.length === 0 ? (
            <p className={styles.inlineEmpty}>
              등록된 레시피 재료가 없습니다.
            </p>
          ) : (
            <div className={styles.recipeRows}>
              {mapping.recipes.map((recipe) => {
                const recipeInventory =
                  recipe.inventoryItem ||
                  inventoryById.get(recipe.inventoryItemId);
                const recipeSaving =
                  recipeSavingKey === `recipe-${recipe.id}`;

                return (
                  <form
                    key={`${recipe.id}-${recipe.version ?? 1}`}
                    className={`${styles.recipeRow} ${
                      recipe.isActive ? "" : styles.recipeRowInactive
                    }`}
                    onSubmit={(event) =>
                      void saveRecipe(event, mapping.id, recipe.id)
                    }
                  >
                    <div className={styles.recipeInventory}>
                      <span>Inventory 품목</span>
                      <strong>
                        {recipeInventory
                          ? getInventoryLabel(recipeInventory)
                          : `품목 #${recipe.inventoryItemId}`}
                      </strong>
                    </div>
                    <label>
                      <span>판매 1개당 차감</span>
                      <input
                        name="quantityPerPosUnit"
                        type="number"
                        min="0.0001"
                        step="any"
                        defaultValue={recipe.quantityPerPosUnit}
                        required
                      />
                    </label>
                    <label className={styles.checkboxField}>
                      <input
                        name="isRequired"
                        type="checkbox"
                        defaultChecked={recipe.isRequired}
                      />
                      <span>필수</span>
                    </label>
                    <label className={styles.checkboxField}>
                      <input
                        name="isActive"
                        type="checkbox"
                        defaultChecked={recipe.isActive}
                      />
                      <span>활성</span>
                    </label>
                    <div className={styles.recipeActions}>
                      <button type="submit" disabled={recipeSaving}>
                        {recipeSaving ? "저장 중..." : "저장"}
                      </button>
                      {recipe.isActive ? (
                        <button
                          type="button"
                          className={styles.dangerButton}
                          disabled={recipeSaving}
                          onClick={() =>
                            void disableRecipe(mapping.id, recipe.id)
                          }
                        >
                          비활성화
                        </button>
                      ) : null}
                    </div>
                  </form>
                );
              })}
            </div>
          )}

          <form
            className={styles.recipeAddForm}
            onSubmit={(event) => void saveRecipe(event, mapping.id)}
          >
            <label className={styles.inventoryField}>
              <span>추가할 Inventory 품목</span>
              <InventoryCombobox
                items={inventoryItems}
                value={recipeInventorySelections[mapping.id] || ""}
                name="inventoryItemId"
                required
                loading={loading && inventoryItems.length === 0}
                text={pageText}
                onChange={(inventoryItemId) =>
                  setRecipeInventorySelections((current) => ({
                    ...current,
                    [mapping.id]: inventoryItemId,
                  }))
                }
              />
            </label>
            <label>
              <span>판매 1개당 차감</span>
              <input
                name="quantityPerPosUnit"
                type="number"
                min="0.0001"
                step="any"
                defaultValue="1"
                required
              />
            </label>
            <label className={styles.checkboxField}>
              <input name="isRequired" type="checkbox" defaultChecked />
              <span>필수 재료</span>
            </label>
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={recipeSavingKey === `recipe-new-${mapping.id}`}
            >
              {recipeSavingKey === `recipe-new-${mapping.id}`
                ? "추가 중..."
                : "재료 추가"}
            </button>
          </form>
        </div>
      </details>
    );
  }

  async function deleteOrphanedMapping(item: CatalogItem) {
    if (
      !actorUsername ||
      !item.mapping ||
      item.status !== "orphaned" ||
      (actorRole !== "owner" && actorRole !== "master")
    ) {
      return;
    }

    if (!window.confirm(pageText.deleteConfirm)) return;

    setDeletingMappingId(item.mapping.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/admin/pos/mappings/${item.mapping.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actorUsername }),
        }
      );
      await getJson(response);
      setEditor(null);
      setValidationResult(null);
      setNotice(pageText.deleteSuccess);
      await loadMappings();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : pageText.deleteFailed
      );
    } finally {
      setDeletingMappingId(null);
    }
  }

  async function runMappingAction(
    item: CatalogItem,
    action: "relink" | "archive" | "restore",
    targetPosProductId?: number
  ) {
    if (
      !actorUsername ||
      !item.mapping ||
      (actorRole !== "owner" && actorRole !== "master")
    ) {
      return;
    }

    let archiveReason = "";
    if (action === "relink") {
      if (!targetPosProductId || !window.confirm(pageText.relinkConfirm)) return;
    } else if (action === "archive") {
      archiveReason = window.prompt(pageText.archiveReasonPrompt)?.trim() || "";
      if (!archiveReason) return;
    } else if (!window.confirm(pageText.restoreConfirm)) {
      return;
    }

    setMappingActionId(item.mapping.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/admin/pos/mappings/${item.mapping.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actorUsername,
            action,
            ...(action === "relink"
              ? { targetPosProductId, approved: true }
              : {}),
            ...(action === "archive" ? { archiveReason } : {}),
          }),
        }
      );
      await getJson(response);
      setEditor(null);
      setValidationResult(null);
      setNotice(pageText.actionSuccess);
      await loadMappings();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : pageText.deleteFailed
      );
    } finally {
      setMappingActionId(null);
    }
  }

  async function reconcileMappings() {
    if (!actorUsername) return;

    setReconciling(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/pos/mappings/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorUsername }),
      });
      const payload = (await getJson(response)) as ReconcileSummary;
      setReconcileSummary(payload);
      setValidationResult(null);
      setNotice("매핑 상태 재검사를 완료했습니다.");
      await loadMappings();
    } catch (reconcileError) {
      setError(
        reconcileError instanceof Error
          ? reconcileError.message
          : "매핑 상태 재검사에 실패했습니다."
      );
    } finally {
      setReconciling(false);
    }
  }

  async function validateMappings() {
    if (!actorUsername) return;

    setValidating(true);
    setError("");
    setNotice("");
    try {
      const params = new URLSearchParams({ actorUsername });
      const response = await fetch(
        `/api/admin/pos/mappings/validation?${params}`,
        { cache: "no-store" }
      );
      const payload = (await getJson(response)) as unknown as ValidationResult;
      setValidationResult(payload);
      setNotice("매핑 완전성 검증을 완료했습니다.");
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "매핑 완전성 검증에 실패했습니다."
      );
    } finally {
      setValidating(false);
    }
  }

  function focusValidationIssue(validationIssue: ValidationIssue) {
    setEditor(null);
    setOptionEditor(null);
    setStatusFilter(
      validationIssue.type === "orphaned_mapping" ? "orphaned" : "all"
    );
    setSearch(
      validationIssue.posItemCode ||
        validationIssue.posProductName ||
        validationIssue.optionName ||
        ""
    );
    window.setTimeout(() => {
      document
        .querySelector(`.${styles.controls}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  if (!actorUsername && !loading) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <div className={styles.alertError}>
            로그인 사용자 정보를 확인할 수 없습니다.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <Link href="/admin" className={styles.backLink}>
              관리자 메뉴
            </Link>
            <h1>POS 상품 재고 매핑</h1>
            <p>
              최신 POS 카탈로그를 기준으로 재고 차감 규칙을 관리합니다.
            </p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.validationButton}
              onClick={() => void validateMappings()}
              disabled={validating || loading}
            >
              {validating ? "검증 중..." : "매핑 검증"}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void reconcileMappings()}
              disabled={reconciling || loading}
            >
              {reconciling ? "재검사 중..." : "매핑 상태 재검사"}
            </button>
          </div>
        </header>

        <section className={styles.summaryBand} aria-label="매핑 상태 요약">
          <div>
            <span>POS 상품</span>
            <strong>{totalCatalogCount}</strong>
          </div>
          <div>
            <span>{DISPLAY_FILTER_LABELS[lang].unmapped}</span>
            <strong>{summary.unmapped}</strong>
          </div>
          <div>
            <span>{DISPLAY_MAPPING_TYPE_LABELS[lang].direct}</span>
            <strong>{summary.mapped}</strong>
          </div>
          <div>
            <span>{DISPLAY_MAPPING_TYPE_LABELS[lang].recipe}</span>
            <strong>{summary.recipe_mapped}</strong>
          </div>
          <div>
            <span>{DISPLAY_MAPPING_TYPE_LABELS[lang].combo}</span>
            <strong>{summary.combo_mapped}</strong>
          </div>
          <div>
            <span>{DISPLAY_FILTER_LABELS[lang].option_based}</span>
            <strong>{summary.option_based}</strong>
          </div>
          <div>
            <span>{DISPLAY_STATUS_LABELS[lang].needs_review}</span>
            <strong>{summary.needs_review}</strong>
          </div>
          <div>
            <span>{DISPLAY_STATUS_LABELS[lang].orphaned}</span>
            <strong>{summary.orphaned}</strong>
          </div>
        </section>

        {reconcileSummary ? (
          <section className={styles.reconcileResult}>
            <strong>{pageText.reconcileTitle}</strong>
            <span>{pageText.reconcileLinked} {reconcileSummary.linkedCount}</span>
            <span>{DISPLAY_STATUS_LABELS[lang].needs_review} {reconcileSummary.needsReviewCount}</span>
            <span>{DISPLAY_STATUS_LABELS[lang].orphaned} {reconcileSummary.orphanedCount}</span>
            <span>{DISPLAY_STATUS_LABELS[lang].inactive_product} {reconcileSummary.inactiveProductCount}</span>
            <span>{pageText.reconcileDuplicateCode} {reconcileSummary.duplicateCodeCount}</span>
            <span>{pageText.reconcileSkipped} {reconcileSummary.skippedCount}</span>
          </section>
        ) : null}

        {validationResult ? (
          <section className={styles.validationPanel}>
            <div className={styles.validationHeader}>
              <div>
                <span>최근 매핑 검증</span>
                <strong>
                  {validationResult.summary.readyForPreview
                    ? "Preview 준비 완료"
                    : "Preview 전 매핑 보완 필요"}
                </strong>
              </div>
              <span
                className={
                  validationResult.summary.readyForPreview
                    ? styles.validationReady
                    : styles.validationBlocked
                }
              >
                {validationResult.summary.readyForPreview ? "READY" : "BLOCKED"}
              </span>
            </div>

            <div className={styles.validationSummary}>
              <div>
                <span>활성 상품</span>
                <strong>{validationResult.summary.activeProducts}</strong>
              </div>
              <div>
                <span>{DISPLAY_MAPPING_TYPE_LABELS[lang].direct}</span>
                <strong>{validationResult.summary.mappedCount}</strong>
              </div>
              <div>
                <span>{DISPLAY_MAPPING_TYPE_LABELS[lang].recipe}</span>
                <strong>{validationResult.summary.recipeMappedCount}</strong>
              </div>
              <div>
                <span>미매핑 상품</span>
                <strong>{validationResult.summary.unmappedCount}</strong>
              </div>
              <div>
                <span>미매핑 옵션</span>
                <strong>{validationResult.summary.optionUnmappedCount}</strong>
              </div>
              <div className={styles.validationErrorCount}>
                <span>오류</span>
                <strong>{validationResult.summary.errorCount}</strong>
              </div>
              <div className={styles.validationWarningCount}>
                <span>경고</span>
                <strong>{validationResult.summary.warningCount}</strong>
              </div>
              <div>
                <span>정보</span>
                <strong>{validationResult.summary.infoCount}</strong>
              </div>
            </div>

            {validationResult.issues.length > 0 ? (
              <div className={styles.validationIssues}>
                {validationResult.issues.map((validationIssue, index) => (
                  <button
                    key={`${validationIssue.type}-${validationIssue.mappingId ?? "none"}-${validationIssue.optionId ?? "none"}-${validationIssue.recipeId ?? "none"}-${index}`}
                    type="button"
                    className={styles[`validation_${validationIssue.severity}`]}
                    onClick={() => focusValidationIssue(validationIssue)}
                  >
                    <span>{validationIssue.severity.toUpperCase()}</span>
                    <div>
                      <strong>
                        {validationIssue.posProductName ||
                          validationIssue.posItemCode ||
                          `Mapping #${validationIssue.mappingId ?? "-"}`}
                        {validationIssue.optionName
                          ? ` / ${validationIssue.optionName}`
                          : ""}
                      </strong>
                      <p>{validationIssue.message}</p>
                    </div>
                    <code>
                      {validationIssue.posItemCode || "-"}
                      {validationIssue.mappingId
                        ? ` · M${validationIssue.mappingId}`
                        : ""}
                    </code>
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.validationEmpty}>
                해결해야 할 매핑 문제가 없습니다.
              </p>
            )}
          </section>
        ) : null}

        {error ? <div className={styles.alertError}>{error}</div> : null}
        {notice ? <div className={styles.alertSuccess}>{notice}</div> : null}

        <section className={styles.controls}>
          <label className={styles.searchField}>
            <span>{DISPLAY_UI_TEXT[lang].search}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={DISPLAY_UI_TEXT[lang].searchPlaceholder}
            />
          </label>
          <div className={styles.filters} aria-label={pageText.filterAriaLabel}>
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={
                  statusFilter === filter.value ? styles.filterActive : ""
                }
                onClick={() => {
                  setEditor(null);
                  setOptionEditor(null);
                  setStatusFilter(filter.value);
                }}
              >
                {DISPLAY_FILTER_LABELS[lang][filter.value]}
                {filter.summaryKey ? ` ${summary[filter.summaryKey]}` : ""}
              </button>
            ))}
          </div>
          <p className={styles.filterDescription} aria-live="polite">
            {DISPLAY_FILTER_DESCRIPTIONS[lang][statusFilter]}
          </p>
        </section>

        <div className={styles.listHeader}>
          <strong>
            {visibleItems.length}
            {DISPLAY_UI_TEXT[lang].itemCount}
          </strong>
          <span>{DISPLAY_UI_TEXT[lang].listDescription}</span>
        </div>

        {loading ? (
          <div className={styles.emptyState}>매핑 목록을 불러오는 중입니다.</div>
        ) : visibleItems.length === 0 ? (
          <div className={styles.emptyState}>조건에 맞는 상품이 없습니다.</div>
        ) : (
          <section ref={productListRef} className={styles.productList}>
            {visibleItems.map((item) => {
              const itemKey = getItemKey(item);
              const isEditing = editor?.itemKey === itemKey;
              const productName =
                item.posProduct?.itemName ||
                item.mapping?.posItemName ||
                "이름 없는 POS 상품";
              const productCode =
                item.posProduct?.itemCode ||
                item.mapping?.posItemCode ||
                "-";
              const inventoryItem = item.mapping?.inventoryItemId
                ? inventoryById.get(Number(item.mapping.inventoryItemId))
                : null;
              const canDeleteOrphaned =
                item.status === "orphaned" &&
                Boolean(item.mapping) &&
                item.canHardDelete === true &&
                (actorRole === "owner" || actorRole === "master");
              const canManageMapping =
                actorRole === "owner" || actorRole === "master";
              const hasLegacyCandidate =
                (item.legacyCandidates?.length || 0) > 0;
              const canArchiveOrphaned =
                item.status === "orphaned" &&
                Boolean(item.mapping) &&
                !hasLegacyCandidate &&
                item.canHardDelete !== true &&
                canManageMapping;
              const canRestoreArchived =
                item.status === "archived" &&
                Boolean(item.mapping) &&
                canManageMapping;
              const optionBasedDeduction = isOptionBasedDeductionItem(item);
              const mappingTypeLabel = optionBasedDeduction
                ? DISPLAY_FILTER_LABELS[lang].option_based
                : item.mappingType
                  ? DISPLAY_MAPPING_TYPE_LABELS[lang][item.mappingType]
                  : null;

              return (
                <article key={itemKey} className={styles.productRow}>
                  <div className={styles.productMain}>
                    <div className={styles.productIdentity}>
                      <div className={styles.titleLine}>
                        <h2>{productName}</h2>
                        {mappingTypeLabel ? (
                          <span
                            className={`${styles.statusBadge} ${styles.typeBadge}`}
                          >
                            {mappingTypeLabel}
                          </span>
                        ) : null}
                        <span
                          className={`${styles.statusBadge} ${
                            item.status === "orphaned" ||
                            item.status === "archived"
                              ? styles[`status_${item.status}`]
                              : styles[
                                  `validation_${item.validationStatus}`
                                ]
                          }`}
                        >
                          {item.status === "orphaned" ||
                          item.status === "archived"
                            ? DISPLAY_STATUS_LABELS[lang][item.status]
                            : DISPLAY_VALIDATION_STATUS_LABELS[lang][
                                item.validationStatus
                              ]}
                        </span>
                        {item.posProduct && !item.posProduct.isActive ? (
                          <span className={styles.inactiveBadge}>POS 비활성</span>
                        ) : null}
                      </div>
                      <div className={styles.metaLine}>
                        <span>코드 {productCode}</span>
                        <span>
                          {item.posProduct?.categoryName || "카테고리 없음"}
                        </span>
                        <span>{item.posProduct?.unitName || "단위 없음"}</span>
                      </div>
                      {getDisplayBlockedReason(item, lang) ? (
                        <p className={styles.blockedReason}>
                          {getDisplayBlockedReason(item, lang)}
                        </p>
                      ) : null}
                      {optionBasedDeduction ? (
                        <p className={styles.optionBasedNotice}>
                          {OPTION_BASED_DESCRIPTION[lang]}
                        </p>
                      ) : null}
                      {hasLegacyCandidate ? (
                        <p className={styles.relinkWarning}>
                          <strong>{pageText.relinkCandidate}:</strong>{" "}
                          {item.legacyCandidates
                            ?.map(
                              (candidate) =>
                                `${candidate.itemCode || "-"} ${candidate.itemName}`
                            )
                            .join(", ")}
                        </p>
                      ) : null}
                      {item.status === "archived" && item.mapping ? (
                        <p className={styles.archiveDetails}>
                          <strong>
                            {item.mapping.archiveReason || "-"}
                          </strong>
                          <span>
                            {item.mapping.archivedAt
                              ? new Date(
                                  item.mapping.archivedAt
                                ).toLocaleString()
                              : "-"}
                            {item.mapping.archivedBy
                              ? ` / ${item.mapping.archivedBy}`
                              : ""}
                          </span>
                        </p>
                      ) : null}
                    </div>

                    <div className={styles.mappingInfo}>
                      <div>
                        <span>매핑 유형</span>
                        <strong>
                          {optionBasedDeduction
                            ? DISPLAY_FILTER_LABELS[lang].option_based
                            : item.mapping?.mappingType
                              ? DISPLAY_MAPPING_TYPE_LABELS[lang][
                                  item.mapping.mappingType
                                ]
                              : DISPLAY_STATUS_LABELS[lang].unmapped}
                          {item.mapping && !item.mapping.isActive
                            ? " (비활성)"
                            : ""}
                        </strong>
                      </div>
                      <div>
                        <span>Inventory 품목</span>
                        <strong>
                          {inventoryItem
                            ? getInventoryLabel(inventoryItem)
                            : item.mapping?.inventoryItemId
                              ? `품목 #${item.mapping.inventoryItemId}`
                              : "-"}
                        </strong>
                      </div>
                      <div>
                        <span>차감 배수</span>
                        <strong>
                          {item.mapping?.quantityMultiplier ?? "-"}
                        </strong>
                      </div>
                    </div>

                    <button
                      type="button"
                      className={styles.editButton}
                      disabled={item.status === "archived"}
                      onClick={() =>
                        isEditing ? setEditor(null) : beginEdit(item)
                      }
                    >
                      {isEditing ? "닫기" : item.mapping ? "수정" : "매핑 설정"}
                    </button>
                    {item.status === "orphaned" &&
                    hasLegacyCandidate &&
                    canManageMapping
                      ? item.legacyCandidates?.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            className={styles.relinkButton}
                            disabled={mappingActionId === item.mapping?.id}
                            onClick={() =>
                              void runMappingAction(
                                item,
                                "relink",
                                candidate.id
                              )
                            }
                          >
                            {pageText.relinkMapping} {candidate.itemCode}
                          </button>
                        ))
                      : null}
                    {canArchiveOrphaned ? (
                      <button
                        type="button"
                        className={styles.archiveButton}
                        disabled={mappingActionId === item.mapping?.id}
                        onClick={() => void runMappingAction(item, "archive")}
                      >
                        {pageText.archiveMapping}
                      </button>
                    ) : null}
                    {canRestoreArchived ? (
                      <button
                        type="button"
                        className={styles.relinkButton}
                        disabled={mappingActionId === item.mapping?.id}
                        onClick={() => void runMappingAction(item, "restore")}
                      >
                        {pageText.restoreMapping}
                      </button>
                    ) : null}
                    {canDeleteOrphaned ? (
                      <button
                        type="button"
                        className={`${styles.editButton} ${styles.dangerButton}`}
                        disabled={
                          deletingMappingId === item.mapping?.id ||
                          hasLegacyCandidate
                        }
                        title={
                          hasLegacyCandidate
                            ? pageText.relinkCandidate
                            : undefined
                        }
                        onClick={() => void deleteOrphanedMapping(item)}
                      >
                        {deletingMappingId === item.mapping?.id
                          ? pageText.deletingMapping
                          : pageText.deleteMapping}
                      </button>
                    ) : null}
                  </div>

                  {isEditing && editor ? (
                    <form
                      className={styles.editor}
                      onSubmit={(event) => void saveMapping(event, item)}
                    >
                      <label>
                        <span>매핑 유형</span>
                        <select
                          value={editor.mappingType}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              mappingType: event.target.value as MappingType,
                            })
                          }
                        >
                          <option value="direct">{DISPLAY_MAPPING_TYPE_LABELS[lang].direct}</option>
                          <option value="recipe">{DISPLAY_MAPPING_TYPE_LABELS[lang].recipe}</option>
                          <option value="combo">{DISPLAY_MAPPING_TYPE_LABELS[lang].combo}</option>
                          <option value="manual">{DISPLAY_MAPPING_TYPE_LABELS[lang].manual}</option>
                          <option value="ignore">{DISPLAY_MAPPING_TYPE_LABELS[lang].ignore}</option>
                        </select>
                      </label>
                      <label className={styles.inventoryField}>
                        <span>Inventory 품목</span>
                        <InventoryCombobox
                          items={inventoryItems}
                          value={editor.inventoryItemId}
                          disabled={editor.mappingType !== "direct"}
                          required={editor.mappingType === "direct"}
                          loading={loading && inventoryItems.length === 0}
                          text={pageText}
                          onChange={(inventoryItemId) =>
                            setEditor({
                              ...editor,
                              inventoryItemId,
                            })
                          }
                        />
                      </label>
                      <label>
                        <span>차감 배수</span>
                        <input
                          type="number"
                          min="0.0001"
                          step="any"
                          value={editor.quantityMultiplier}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              quantityMultiplier: event.target.value,
                            })
                          }
                          required
                        />
                      </label>
                      <label className={styles.checkboxField}>
                        <input
                          type="checkbox"
                          checked={editor.isActive}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              isActive: event.target.checked,
                            })
                          }
                        />
                        <span>매핑 활성</span>
                      </label>
                      <div className={styles.editorActions}>
                        <button
                          type="button"
                          onClick={() => setEditor(null)}
                          disabled={saving}
                        >
                          취소
                        </button>
                        <button
                          type="submit"
                          className={styles.primaryButton}
                          disabled={saving}
                        >
                          {saving ? "저장 중..." : "저장"}
                        </button>
                      </div>
                      {editor.mappingType === "recipe" ? (
                        <p className={styles.editorNotice}>
                          {pageText.recipeNotice}
                        </p>
                      ) : null}
                      {false ? (
                        <p className={styles.editorNotice}>
                          Recipe 유형 저장은 가능하지만 세부 재료 설정은 다음
                          단계에서 관리합니다. 재료가 없으면 검토 필요 상태로
                          표시됩니다.
                        </p>
                      ) : null}
                    </form>
                  ) : null}

                  {item.mapping?.mappingType === "recipe" ? (
                    <details
                      className={`${styles.recipeManager} ${
                        recipeSetupMappingId === item.mapping.id
                          ? styles.recipeManagerPending
                          : ""
                      }`}
                      open={
                        recipeSetupMappingId === item.mapping.id
                          ? true
                          : undefined
                      }
                      onToggle={(event) => {
                        if (
                          !event.currentTarget.open &&
                          recipeSetupMappingId === item.mapping?.id
                        ) {
                          setRecipeSetupMappingId(null);
                        }
                      }}
                    >
                      <summary>
                        <span>레시피 관리</span>
                        {item.mapping.recipes.filter(
                          (recipe) => recipe.isActive
                        ).length === 0 ? (
                          <strong>레시피 재료 필요</strong>
                        ) : (
                          <em>
                            활성 재료{" "}
                            {
                              item.mapping.recipes.filter(
                                (recipe) => recipe.isActive
                              ).length
                            }
                            개
                          </em>
                        )}
                      </summary>
                      <div className={styles.recipeBody}>
                        {item.mapping.recipes.length === 0 ? (
                          <p className={styles.inlineEmpty}>
                            등록된 레시피 재료가 없습니다.
                          </p>
                        ) : (
                          <div className={styles.recipeRows}>
                            {item.mapping.recipes.map((recipe) => {
                              const recipeInventory =
                                recipe.inventoryItem ||
                                inventoryById.get(recipe.inventoryItemId);
                              const recipeSaving =
                                recipeSavingKey === `recipe-${recipe.id}`;

                              return (
                                <form
                                  key={`${recipe.id}-${recipe.version ?? 1}`}
                                  className={`${styles.recipeRow} ${
                                    recipe.isActive
                                      ? ""
                                      : styles.recipeRowInactive
                                  }`}
                                  onSubmit={(event) =>
                                    void saveRecipe(
                                      event,
                                      item.mapping!.id,
                                      recipe.id
                                    )
                                  }
                                >
                                  <div className={styles.recipeInventory}>
                                    <span>Inventory 품목</span>
                                    <strong>
                                      {recipeInventory
                                        ? getInventoryLabel(recipeInventory)
                                        : `품목 #${recipe.inventoryItemId}`}
                                    </strong>
                                  </div>
                                  <label>
                                    <span>판매 1개당 차감</span>
                                    <input
                                      name="quantityPerPosUnit"
                                      type="number"
                                      min="0.0001"
                                      step="any"
                                      defaultValue={recipe.quantityPerPosUnit}
                                      required
                                    />
                                  </label>
                                  <label className={styles.checkboxField}>
                                    <input
                                      name="isRequired"
                                      type="checkbox"
                                      defaultChecked={recipe.isRequired}
                                    />
                                    <span>필수</span>
                                  </label>
                                  <label className={styles.checkboxField}>
                                    <input
                                      name="isActive"
                                      type="checkbox"
                                      defaultChecked={recipe.isActive}
                                    />
                                    <span>활성</span>
                                  </label>
                                  <div className={styles.recipeActions}>
                                    <button
                                      type="submit"
                                      disabled={recipeSaving}
                                    >
                                      {recipeSaving ? "저장 중..." : "저장"}
                                    </button>
                                    {recipe.isActive ? (
                                      <button
                                        type="button"
                                        className={styles.dangerButton}
                                        disabled={recipeSaving}
                                        onClick={() =>
                                          void disableRecipe(
                                            item.mapping!.id,
                                            recipe.id
                                          )
                                        }
                                      >
                                        비활성화
                                      </button>
                                    ) : null}
                                  </div>
                                </form>
                              );
                            })}
                          </div>
                        )}

                        <form
                          className={styles.recipeAddForm}
                          onSubmit={(event) =>
                            void saveRecipe(event, item.mapping!.id)
                          }
                        >
                          <label className={styles.inventoryField}>
                            <span>추가할 Inventory 품목</span>
                            <InventoryCombobox
                              items={inventoryItems}
                              value={
                                recipeInventorySelections[item.mapping.id] || ""
                              }
                              name="inventoryItemId"
                              required
                              loading={loading && inventoryItems.length === 0}
                              text={pageText}
                              onChange={(inventoryItemId) =>
                                setRecipeInventorySelections((current) => ({
                                  ...current,
                                  [item.mapping!.id]: inventoryItemId,
                                }))
                              }
                            />
                          </label>
                          <label>
                            <span>판매 1개당 차감</span>
                            <input
                              name="quantityPerPosUnit"
                              type="number"
                              min="0.0001"
                              step="any"
                              defaultValue="1"
                              required
                            />
                          </label>
                          <label className={styles.checkboxField}>
                            <input
                              name="isRequired"
                              type="checkbox"
                              defaultChecked
                            />
                            <span>필수 재료</span>
                          </label>
                          <button
                            type="submit"
                            className={styles.primaryButton}
                            disabled={
                              recipeSavingKey ===
                              `recipe-new-${item.mapping.id}`
                            }
                          >
                            {recipeSavingKey ===
                            `recipe-new-${item.mapping.id}`
                              ? "추가 중..."
                              : "재료 추가"}
                          </button>
                        </form>
                      </div>
                    </details>
                  ) : null}

                  {renderComboChildren(item)}

                  {item.options && item.options.length > 0 ? (
                    <details className={styles.options}>
                      <summary>POS 옵션 {item.options.length}개</summary>
                      <div className={styles.optionList}>
                        {item.options.map((option) => {
                          const optionKey = `${item.posProduct?.id}:${option.optionId}`;
                          const isOptionEditing =
                            optionEditor?.optionKey === optionKey;
                          const optionInventory =
                            option.inventoryItem ||
                            (option.inventoryItemId
                              ? inventoryById.get(option.inventoryItemId)
                              : null);

                          return (
                            <div
                              key={`${itemKey}-${option.optionId}`}
                              className={styles.optionRow}
                            >
                              <div className={styles.optionIdentity}>
                                <span>{option.groupName}</span>
                                <strong>{option.optionName}</strong>
                                <code>{option.code || option.optionId}</code>
                              </div>
                              <div className={styles.optionMappingSummary}>
                                <span
                                  className={`${styles.statusBadge} ${styles[`status_${option.status}`]}`}
                                >
                                  {DISPLAY_OPTION_STATUS_LABELS[lang][option.status]}
                                </span>
                                <strong>
                                  {optionInventory
                                    ? getInventoryLabel(optionInventory)
                                    : option.mappingType === "recipe"
                                      ? DISPLAY_MAPPING_TYPE_LABELS[lang].recipe
                                      : "-"}
                                </strong>
                                <em>
                                  {option.quantityMultiplier
                                    ? `배수 ${option.quantityMultiplier}`
                                    : ""}
                                </em>
                              </div>
                              <button
                                type="button"
                                className={styles.editButton}
                                onClick={() =>
                                  isOptionEditing
                                    ? setOptionEditor(null)
                                    : beginOptionEdit(item, option)
                                }
                              >
                                {isOptionEditing
                                  ? "닫기"
                                  : option.mapping
                                    ? "수정"
                                    : "설정"}
                              </button>

                              {option.blockedReason ? (
                                <p className={styles.optionWarning}>
                                  {option.blockedReason}
                                </p>
                              ) : null}

                              {isOptionEditing && optionEditor ? (
                                <form
                                  className={styles.optionEditor}
                                  onSubmit={(event) =>
                                    void saveOptionMapping(event, item, option)
                                  }
                                >
                                  <label>
                                    <span>매핑 유형</span>
                                    <select
                                      value={optionEditor.mappingType}
                                      onChange={(event) =>
                                        setOptionEditor({
                                          ...optionEditor,
                                          mappingType: event.target
                                            .value as OptionMappingType,
                                        })
                                      }
                                    >
                                      <option value="direct">{DISPLAY_MAPPING_TYPE_LABELS[lang].direct}</option>
                                      <option value="recipe">{DISPLAY_MAPPING_TYPE_LABELS[lang].recipe}</option>
                                      <option value="manual">{DISPLAY_MAPPING_TYPE_LABELS[lang].manual}</option>
                                      <option value="ignore">{DISPLAY_MAPPING_TYPE_LABELS[lang].ignore}</option>
                                    </select>
                                  </label>
                                  <label className={styles.inventoryField}>
                                    <span>Inventory 품목</span>
                                    <InventoryCombobox
                                      items={inventoryItems}
                                      value={optionEditor.inventoryItemId}
                                      disabled={
                                        optionEditor.mappingType !== "direct"
                                      }
                                      required={
                                        optionEditor.mappingType === "direct"
                                      }
                                      loading={
                                        loading && inventoryItems.length === 0
                                      }
                                      text={pageText}
                                      onChange={(inventoryItemId) =>
                                        setOptionEditor({
                                          ...optionEditor,
                                          inventoryItemId,
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    <span>차감 배수</span>
                                    <input
                                      type="number"
                                      min="0.0001"
                                      step="any"
                                      value={
                                        optionEditor.quantityMultiplier
                                      }
                                      onChange={(event) =>
                                        setOptionEditor({
                                          ...optionEditor,
                                          quantityMultiplier:
                                            event.target.value,
                                        })
                                      }
                                      required
                                    />
                                  </label>
                                  <label className={styles.checkboxField}>
                                    <input
                                      type="checkbox"
                                      checked={optionEditor.isActive}
                                      onChange={(event) =>
                                        setOptionEditor({
                                          ...optionEditor,
                                          isActive: event.target.checked,
                                        })
                                      }
                                    />
                                    <span>매핑 활성</span>
                                  </label>
                                  <div className={styles.editorActions}>
                                    <button
                                      type="button"
                                      onClick={() => setOptionEditor(null)}
                                      disabled={optionSaving}
                                    >
                                      취소
                                    </button>
                                    <button
                                      type="submit"
                                      className={styles.primaryButton}
                                      disabled={optionSaving}
                                    >
                                      {optionSaving ? "저장 중..." : "저장"}
                                    </button>
                                  </div>
                                  {optionEditor.mappingType === "recipe" ? (
                                    <p className={styles.editorNotice}>
                                      {pageText.optionRecipeNotice}
                                    </p>
                                  ) : null}
                                  {false ? (
                                    <p className={styles.editorNotice}>
                                      Recipe 옵션은 저장 후 아래 재료 관리에서
                                      구성합니다. 재료가 없으면 검토 필요로
                                      남습니다.
                                    </p>
                                  ) : null}
                                </form>
                              ) : null}
                              {option.mapping?.mappingType === "recipe"
                                ? renderRecipeManager(
                                    option.mapping,
                                    "옵션 레시피 관리"
                                  )
                                : null}
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}
