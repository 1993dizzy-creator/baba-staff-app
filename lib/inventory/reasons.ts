export const INVENTORY_REASON_VALUES = [
  "purchase",
  "stock_check",
  "service",
  "other",
  "sale_deduction",
  "unclassified",
] as const;

export type InventoryReasonValue = (typeof INVENTORY_REASON_VALUES)[number];

export const INVENTORY_SOURCE_VALUES = [
  "quick_save",
  "edit_form",
  "create",
  "delete",
  "photo",
  "pos_sales",
  "keg_replace",
  "system",
] as const;

export type InventorySourceValue = (typeof INVENTORY_SOURCE_VALUES)[number];

export const INVENTORY_REGISTRATION_TYPES = [
  "existing_stock",
  "new_purchase",
] as const;

export type InventoryRegistrationType =
  (typeof INVENTORY_REGISTRATION_TYPES)[number];

export type QuickReasonValue = Exclude<
  InventoryReasonValue,
  "sale_deduction" | "unclassified"
>;

export const QUICK_REASON_VALUES = [
  "purchase",
  "stock_check",
  "service",
  "other",
] as const satisfies readonly QuickReasonValue[];

export const INVENTORY_REASON_EMOJIS = {
  purchase: "🛒",
  stock_check: "✅",
  service: "🎁",
  other: "✏️",
  sale_deduction: "🔴",
  unclassified: "❔",
} satisfies Record<InventoryReasonValue, string>;

export const INVENTORY_REASON_META = {
  purchase: { emoji: INVENTORY_REASON_EMOJIS.purchase },
  stock_check: { emoji: INVENTORY_REASON_EMOJIS.stock_check },
  service: { emoji: INVENTORY_REASON_EMOJIS.service },
  other: { emoji: INVENTORY_REASON_EMOJIS.other },
  sale_deduction: { emoji: INVENTORY_REASON_EMOJIS.sale_deduction },
  unclassified: { emoji: INVENTORY_REASON_EMOJIS.unclassified },
} satisfies Record<InventoryReasonValue, { emoji: string }>;

export const INVENTORY_REASON_LABELS = {
  ko: {
    purchase: "구매입고",
    stock_check: "재고확인",
    service: "서비스/증정",
    other: "기타",
    sale_deduction: "판매차감",
    unclassified: "미분류",
  },
  vi: {
    purchase: "Nhap mua",
    stock_check: "Kiem tra kho",
    service: "Dich vu/tang",
    other: "Khac",
    sale_deduction: "Trừ kho bán hàng",
    unclassified: "Chua phan loai",
  },
} satisfies Record<
  "ko" | "vi",
  Record<InventoryReasonValue, string>
>;

export function normalizeInventoryReason(
  value: unknown,
  fallback: InventoryReasonValue = "unclassified"
): InventoryReasonValue {
  if (value === "check") return "stock_check";
  return INVENTORY_REASON_VALUES.includes(value as InventoryReasonValue)
    ? (value as InventoryReasonValue)
    : fallback;
}

export function normalizeInventorySource(
  value: unknown,
  fallback: InventorySourceValue = "system"
): InventorySourceValue {
  return INVENTORY_SOURCE_VALUES.includes(value as InventorySourceValue)
    ? (value as InventorySourceValue)
    : fallback;
}

export function getReasonByRegistrationType(
  value: unknown
): InventoryReasonValue {
  if (value === "new_purchase") return "purchase";
  return "stock_check";
}

export function isPurchaseReason(value: unknown) {
  return normalizeInventoryReason(value) === "purchase";
}

export function getCompactReasonLabel(
  reason: InventoryReasonValue | null | undefined,
  lang: "ko" | "vi"
): string {
  if (lang === "vi") {
    if (reason === "purchase") return "Nhập";
    if (reason === "stock_check") return "Kiểm";
    if (reason === "service") return "Tặng";
    if (reason === "other") return "Khác";
    if (reason === "sale_deduction") return "Trừ bán";
    return "Khác";
  }
  if (reason === "purchase") return "입고";
  if (reason === "stock_check") return "확인";
  if (reason === "service") return "증정";
  if (reason === "other") return "기타";
  if (reason === "sale_deduction") return "판매차감";
  return "기타";
}

export type InventoryReasonBadgeMeta = {
  text: string;
  style: { background: string; color: string; border: string };
};

const REASON_BADGE_STYLE = {
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #e5e7eb",
} as const;

export function getKegReplaceLabel(lang: "ko" | "vi"): string {
  return lang === "vi" ? "Đổi keg" : "케그 교체";
}

export function getInventoryReasonBadgeMeta(
  reason: string | null | undefined,
  source: string | null | undefined,
  lang: "ko" | "vi"
): InventoryReasonBadgeMeta | null {
  const effectiveReason: InventoryReasonValue =
    source === "pos_sales"
      ? "sale_deduction"
      : INVENTORY_REASON_VALUES.includes(reason as InventoryReasonValue)
      ? (reason as InventoryReasonValue)
      : "unclassified";

  if (effectiveReason === "unclassified") return null;

  const sourceLabel = source === "keg_replace" ? getKegReplaceLabel(lang) : "";

  return {
    text: [
      `${INVENTORY_REASON_EMOJIS[effectiveReason]} ${getCompactReasonLabel(effectiveReason, lang)}`,
      sourceLabel,
    ].filter(Boolean).join(" · "),
    style: REASON_BADGE_STYLE,
  };
}

const AUTO_NOTE_REASON_LABELS: ReadonlySet<string> = new Set([
  // Full labels from INVENTORY_REASON_LABELS (both langs)
  "구매입고", "재고확인", "서비스/증정", "기타", "판매차감", "미분류",
  "Nhap mua", "Kiem tra kho", "Dich vu/tang", "Khac", "Trừ kho bán hàng", "Chua phan loai",
  // Compact labels (getCompactReasonLabel)
  "입고", "확인", "증정", "Nhập", "Kiểm", "Tặng", "Trừ bán",
  // Additional variants seen in stored notes
  "서비스", "Kiểm tra kho", "Khác", "v.v.",
]);

export function isAutoGeneratedInventoryNote(note: string): boolean {
  if (!note) return false;
  const match = note.trim().match(/^[+\-][\d.,]+ \(([^)]+)\)$/);
  if (!match) return false;
  return AUTO_NOTE_REASON_LABELS.has(match[1].trim());
}

/** Classification edits are not an atomic purchase correction operation. */
export function inventoryReasonChangeIssue(row: {reason?: unknown; change_quantity?: unknown; correction_of_inventory_log_id?: unknown}, nextReason: string) {
  const previous = normalizeInventoryReason(row.reason);
  if (nextReason === "purchase" && row.correction_of_inventory_log_id == null &&
      (!Number.isFinite(Number(row.change_quantity)) || Number(row.change_quantity) <= 0)) return "inventory_nonpositive_purchase_classification";
  if (previous === nextReason) return null;
  if (row.correction_of_inventory_log_id != null) return "inventory_purchase_correction_log_protected";
  if (previous === "purchase" || nextReason === "purchase") return "inventory_purchase_reclassification_requires_review";
  return null;
}

export type InventoryPurchaseErrorDetails = {
  blockReason?: string;
  candidateCount?: number;
  candidateCountExact?: boolean;
};

export function inventoryPurchaseErrorMessage(code: string | undefined, lang: "ko" | "vi", details?: InventoryPurchaseErrorDetails) {
  const vi = lang === "vi";
  if (code === "purchase_correction_ambiguous" && details?.candidateCountExact === true &&
      Number.isSafeInteger(details.candidateCount) && Number(details.candidateCount) > 1) {
    const count = details.candidateCount;
    return vi
      ? `Hôm nay có ${count} phiếu nhập phù hợp với mặt hàng này. Hệ thống không thể xác định phiếu cần điều chỉnh nên chưa lưu. Vui lòng liên hệ quản lý.`
      : `오늘 이 품목의 정정 가능한 입고 기록이 ${count}건 있습니다. 어느 입고를 정정해야 할지 자동으로 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.`;
  }
  const reviewMessages: Record<string,[string,string]> = {
    payment_completed: ["이미 지급 완료된 입고이므로 자동 정정할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Phiếu nhập đã được thanh toán nên không thể tự động điều chỉnh và chưa lưu. Vui lòng liên hệ quản lý."],
    payment_allocated: ["이미 지급액이 배분된 입고이므로 자동 정정할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Phiếu nhập đã có khoản thanh toán được phân bổ nên không thể tự động điều chỉnh và chưa lưu. Vui lòng liên hệ quản lý."],
    payment_state: ["연결된 지급 기록이 미지급 상태가 아니므로 자동 정정할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Khoản thanh toán liên kết không ở trạng thái chưa thanh toán nên chưa lưu điều chỉnh. Vui lòng liên hệ quản lý."],
    month_closed: ["입고 또는 연결된 장부의 해당 월이 마감되어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Tháng của phiếu nhập hoặc sổ liên quan đã chốt nên chưa lưu. Vui lòng liên hệ quản lý."],
    ledger_transaction_missing: ["연결된 장부 거래를 찾을 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không tìm thấy giao dịch sổ liên kết nên chưa lưu. Vui lòng liên hệ quản lý."],
    ledger_amount_changed: ["연결된 장부 금액이 입고 기록과 달라 자동 정정할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Số tiền trên sổ liên kết khác với phiếu nhập nên chưa lưu điều chỉnh. Vui lòng liên hệ quản lý."],
    ledger_status_changed: ["연결된 장부 거래의 상태 또는 유형을 확인해야 하므로 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Cần kiểm tra trạng thái hoặc loại giao dịch sổ liên kết nên chưa lưu. Vui lòng liên hệ quản lý."],
    purchase_dismissed: ["검토에서 제외된 입고 기록이므로 자동 정정하지 않았습니다. 관리자에게 문의해 주세요.", "Phiếu nhập đã bị loại khỏi xét duyệt nên chưa tự động điều chỉnh. Vui lòng liên hệ quản lý."],
    purchase_details_changed: ["원입고의 거래처·단위 등 정정 조건이 일치하지 않아 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Nhà cung cấp, đơn vị hoặc điều kiện của phiếu nhập gốc không khớp nên chưa lưu. Vui lòng liên hệ quản lý."],
    correction_history_limit: ["정정 이력이 많아 안전한 정정 수량을 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Lịch sử điều chỉnh quá nhiều nên không xác định được số lượng an toàn và chưa lưu. Vui lòng liên hệ quản lý."],
    invalid_correction_history: ["기존 정정 이력의 수량을 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không xác minh được số lượng trong lịch sử điều chỉnh nên chưa lưu. Vui lòng liên hệ quản lý."],
    supplier_mapping_required: ["거래처의 장부 상대방·지급 방식 연결 또는 이전 거래처 기록을 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không xác minh được liên kết sổ, phương thức thanh toán hoặc nhà cung cấp trước đó nên chưa lưu. Vui lòng liên hệ quản lý."],
    ledger_review_pending: ["이 입고의 이전 수정이 장부 관리자 확인을 기다리고 있어 저장하지 않았습니다. 관리자가 장부에서 확인한 뒤 다시 수정해 주세요.", "Lần sửa trước của phiếu nhập này đang chờ quản lý xác nhận sổ nên chưa lưu. Hãy sửa lại sau khi quản lý xác nhận."],
    receipt_edit_review: ["입고와 연결된 장부 상태를 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không xác minh được trạng thái sổ liên kết với phiếu nhập nên chưa lưu. Vui lòng liên hệ quản lý."],
    physical_count_unverified: ["입고·재고확인의 시간 순서를 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không xác minh được thứ tự thời gian nhập hàng và kiểm kho nên chưa lưu. Vui lòng liên hệ quản lý."],
    billed_amount_invalid: ["실청구금액을 확인할 수 없어 저장하지 않았습니다. 수량이 0보다 클 때만 금액을 직접 입력할 수 있습니다.", "Không xác minh được số tiền thực tính nên chưa lưu. Chỉ nhập tay số tiền khi số lượng lớn hơn 0."],
  };
  if (code === "purchase_correction_review_required" && details?.blockReason && Object.hasOwn(reviewMessages, details.blockReason))
    return reviewMessages[details.blockReason][vi ? 1 : 0];
  if (code === "purchase_correction_ambiguous" && details?.blockReason === "candidate_limit")
    return vi ? "Có quá nhiều phiếu nhập để xác định chính xác phiếu cần sửa nên chưa lưu. Vui lòng liên hệ quản lý."
      : "입고 기록이 많아 정정할 원본을 정확히 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.";
  if (["QUANTITY_CONFLICT", "quantity_conflict"].includes(code ?? ""))
    return vi ? "Tồn kho đã được thay đổi bởi thao tác khác nên chưa lưu. Dữ liệu bạn nhập được giữ nguyên; hãy kiểm tra tồn kho mới nhất trước khi thử lại."
      : "다른 작업으로 재고 수량이 변경되어 저장하지 않았습니다. 입력값은 유지했습니다. 최신 재고를 확인한 뒤 다시 시도해 주세요.";
  if (["INVENTORY_CONFLICT", "inventory_conflict"].includes(code ?? ""))
    return vi ? "Thông tin mặt hàng đã được thay đổi bởi thao tác khác nên chưa lưu. Dữ liệu bạn nhập được giữ nguyên; hãy kiểm tra thông tin mới nhất trước khi thử lại."
      : "다른 작업으로 품목 정보가 변경되어 저장하지 않았습니다. 입력값은 유지했습니다. 최신 정보를 확인한 뒤 다시 시도해 주세요.";
  const messages: Record<string, [string, string]> = {
    inventory_nonpositive_purchase_classification: ["감소·0 수량 기록을 신규 입고로 분류할 수 없습니다. 마이너스 입고는 수량 입력 화면에서 원입고에 연결해 정정해주세요.", "Không thể phân loại số lượng giảm hoặc bằng 0 thành nhập mới. Hãy sửa số lượng và liên kết lô nhập gốc."],
    inventory_purchase_reclassification_requires_review: ["입고 분류 변경은 지급·월마감·정정 이력 검토가 필요합니다. 이력의 분류 버튼 대신 원입고 수량 정정 절차를 사용해주세요.", "Đổi phân loại nhập cần kiểm tra thanh toán, chốt tháng và lịch sử sửa. Hãy dùng quy trình sửa lô nhập gốc thay vì đổi nhãn nhật ký."],
    inventory_purchase_correction_log_protected: ["원입고에 연결된 정정 기록의 분류는 변경할 수 없습니다. 원입고 정정 절차를 사용해주세요.", "Không thể đổi phân loại nhật ký sửa đã liên kết. Hãy dùng quy trình sửa lô nhập gốc."],
    purchase_correction_later_stock_check: ["원입고 이후 재고확인이 있어 현재 실재고를 변경하는 정정을 차단했습니다. 관리자에게 원입고·장부 검토를 요청해주세요.", "Đã kiểm kho sau lô nhập này nên không thể sửa làm thay đổi tồn thực tế. Hãy nhờ quản lý kiểm tra lô nhập và sổ."],
    purchase_correction_exceeds_purchase: ["원입고의 남은 유효 수량을 초과해 줄일 수 없습니다. 원입고와 정정 이력을 다시 확인해주세요.", "Không thể giảm quá số lượng còn hiệu lực của lô nhập. Hãy kiểm tra lô gốc và các lần sửa."],
    purchase_correction_ambiguous: ["오늘 입고 기록을 하나로 확인할 수 없습니다. 관리자에게 확인해주세요.", "Không xác định được một lô nhập hôm nay. Vui lòng hỏi quản lý."],
    invalid_purchase_reference: ["원입고 또는 정정 조건을 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không xác minh được phiếu nhập gốc hoặc điều kiện điều chỉnh nên chưa lưu. Vui lòng liên hệ quản lý."],
    invalid_purchase_correction: ["입고 정정 요청 조건을 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không xác minh được điều kiện yêu cầu điều chỉnh nên chưa lưu. Vui lòng liên hệ quản lý."],
    not_found: ["품목 또는 원입고 기록을 찾을 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Không tìm thấy mặt hàng hoặc phiếu nhập gốc nên chưa lưu. Vui lòng liên hệ quản lý."],
    forbidden: ["입고 정정 권한이 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Bạn không có quyền điều chỉnh phiếu nhập nên chưa lưu. Vui lòng liên hệ quản lý."],
    invalid_payload: ["정정할 입력값이 유효하지 않아 저장하지 않았습니다. 수량·거래처·단가를 확인해 주세요.", "Dữ liệu điều chỉnh không hợp lệ nên chưa lưu. Vui lòng kiểm tra số lượng, nhà cung cấp và đơn giá."],
    no_change: ["변경된 내용이 없습니다.", "Không có thay đổi."],
    inventory_receipt_edit_protected: ["입고 수정으로 정정된 입고의 단가·거래처는 당일 로그의 [입고 수정]에서만 변경할 수 있습니다.", "Đơn giá và nhà cung cấp của phiếu nhập đã sửa chỉ được đổi bằng [Sửa nhập hàng] trong nhật ký trong ngày."],
    supplier_change_forbidden: ["입고 거래처 변경은 대표·관리자(owner/master)만 할 수 있습니다.", "Chỉ owner/master mới được đổi nhà cung cấp của phiếu nhập."],
    inventory_quantity_negative: ["현재 재고가 줄일 수량보다 적어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Tồn kho hiện tại nhỏ hơn số lượng cần giảm nên chưa lưu. Vui lòng liên hệ quản lý."],
    purchase_correction_root_not_found: ["오늘 조건에 맞는 입고 기록이 없습니다. 관리자에게 확인해주세요.", "Không có lô nhập hôm nay phù hợp. Vui lòng hỏi quản lý."],
    purchase_correction_review_required: ["서버에서 자동 정정의 안전성을 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.", "Hệ thống chưa xác minh được điều kiện điều chỉnh an toàn nên chưa lưu. Vui lòng liên hệ quản lý."],
    invalid_billed_amount: ["실청구금액이 올바르지 않아 저장하지 않았습니다. 0보다 큰 금액을 입력하거나 자동계산을 복원해 주세요.", "Số tiền thực tính không hợp lệ nên chưa lưu. Hãy nhập số tiền lớn hơn 0 hoặc khôi phục tự động."],
    purchase_billed_amount_edit_required: ["실청구금액을 직접 입력한 입고는 수량을 이곳에서 줄일 수 없습니다. 재고 로그의 [입고 수정]에서 수량과 실청구금액을 함께 정정해 주세요.", "Phiếu nhập có số tiền thực tính nhập tay không thể giảm số lượng ở đây. Hãy sửa số lượng và số tiền cùng lúc bằng [Sửa nhập hàng] trong nhật ký."],
    inventory_billed_amount_protected: ["실청구금액을 직접 입력한 입고의 단가·수량은 당일 로그의 [입고 수정]에서만 변경할 수 있습니다.", "Đơn giá và số lượng của phiếu nhập có số tiền thực tính nhập tay chỉ được đổi bằng [Sửa nhập hàng] trong nhật ký trong ngày."],
  };
  return code ? messages[code]?.[lang === "vi" ? 1 : 0] ?? null : null;
}
