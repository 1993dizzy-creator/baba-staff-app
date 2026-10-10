export type PurchaseSupplierChange = {
  valid: boolean;
  requiresConfirmation: boolean;
  beforeSupplier: string | null;
  afterSupplier: string | null;
  beforePartnerId: string | null;
  afterPartnerId: string | null;
  confirmationFingerprint: string;
};
export type PurchaseRepairCandidate = {
  safe: boolean; code: string; inventoryLogId: number; businessDate: string;
  quantity: number; effectiveQuantity: number; unit: string | null; price: number; supplier: string | null;
  oldAmount: number | null; newAmount: number | null; delta: number | null;
  quantityDelta?: number;
  newSupplier?: string | null;
  supplierChange?: PurchaseSupplierChange;
};
export type PurchaseRepairPreview = { candidates: PurchaseRepairCandidate[]; recommended: boolean };

export function purchaseRepairState(code: string, vi: boolean, cancelled = false) {
  if (code === "REBOOKED" || code === "PURCHASE_CANCELLED") return vi ? "Đã điều chỉnh sổ kế toán" : "장부 정정 완료";
  if (cancelled || code === "PURCHASE_ORIGINAL_CANCELLED") return vi ? "Phiếu nhập gốc đã bị hủy" : "원본 입고 취소됨";
  if (code === "SUPPLIER_CHANGE_CONFIRMATION_REQUIRED") return vi ? "Cần xác nhận nhà cung cấp thực tế" : "실제 지급 거래처 확인 필요";
  if (code === "PURCHASE_AMOUNT_CONFIRMATION_REQUIRED") return vi ? "Cần xác nhận thay đổi số tiền" : "금액 변경 확인 필요";
  return vi ? "Cần xác nhận phiếu nhập gốc" : "원본 입고 연결 확인 필요";
}

export function canReviewPurchaseCorrection(code: string) {
  return ["SUPPLIER_CHANGE_CONFIRMATION_REQUIRED", "PURCHASE_CORRECTION_REFERENCE_REQUIRED", "PURCHASE_AMOUNT_CONFIRMATION_REQUIRED", "PURCHASE_ORIGINAL_CANCELLED", "MONTH_CLOSED", "PAYABLE_ALREADY_PAID"].includes(code);
}

export function purchaseRepairError(code: string, vi: boolean) {
  const messages: Record<string, [string, string]> = {
    SUPPLIER_CHANGE_CONFIRMATION_REQUIRED: ["변경 후 실제 지급 거래처를 확인해야 합니다.", "Hãy xác nhận nhà cung cấp thực tế sau thay đổi."],
    SUPPLIER_CHANGE_CONFIRMATION_STALE: ["입고 또는 장부가 변경되어 확인 정보가 만료되었습니다. 최신 정보를 다시 조회하고 거래처를 확인하세요.", "Thông tin nhập hàng hoặc sổ đã thay đổi. Tải lại và xác nhận nhà cung cấp mới."],
    INVALID_SUPPLIER_CONFIRMATION: ["거래처 확인 정보가 올바르지 않습니다. 최신 정보를 다시 조회하세요.", "Thông tin xác nhận nhà cung cấp không hợp lệ. Hãy tải lại."],
    MANUAL_LEDGER_OVERRIDE: ["장부금액을 수동 수정한 내역이 있어 자동 정정을 차단했습니다. 원입고와 장부를 확인하세요.", "Số tiền sổ đã được sửa thủ công. Kiểm tra phiếu nhập gốc và sổ."],
    SUPPLIER_MISMATCH: ["수정 이력의 이전 거래처가 원입고 거래처와 일치하지 않습니다.", "Nhà cung cấp trước trong lịch sử không khớp phiếu nhập gốc."],
    SUPPLIER_REFERENCE_REQUIRED: ["실제 거래처와 이전 거래처를 확인할 근거가 부족합니다. 입고 이력을 확인하세요.", "Thiếu căn cứ về nhà cung cấp trước và sau. Kiểm tra lịch sử nhập."],
    SUPPLIER_CORRECTION_ORDER_REQUIRED: ["이후 거래처 정정 이력이 있습니다. 정정 순서를 먼저 확인하세요.", "Có điều chỉnh nhà cung cấp sau đó. Kiểm tra thứ tự điều chỉnh."],
    QUANTITY_CORRECTION_REQUIRED: ["수량 변경은 재고의 구매입고 정정 절차로 처리해야 합니다.", "Thay đổi số lượng cần dùng quy trình điều chỉnh nhập mua trong kho."],
    INVALID_CANDIDATE_STATE: ["원입고의 확정 장부를 찾지 못했습니다. 장부 상태를 확인하세요.", "Không tìm thấy bút toán đã xác nhận của phiếu nhập gốc."],
    INVALID_TRANSACTION_STATE: ["장부 상태가 정정 가능한 상태가 아닙니다.", "Trạng thái bút toán không cho phép điều chỉnh."],
    INVALID_PAYABLE_STATE: ["미납금과 장부의 금액·거래처가 일치하지 않습니다. 지급 이력을 확인하세요.", "Công nợ không khớp số tiền hoặc nhà cung cấp trong sổ. Kiểm tra thanh toán."],
    FORBIDDEN: ["이 작업은 owner/master만 처리할 수 있습니다.", "Chỉ owner/master được xử lý thao tác này."],
    PREVIEW_FAILED: ["연결 정보를 불러오지 못했습니다. 다시 시도해 주세요.", "Không thể tải thông tin liên kết. Hãy thử lại."],
    REPAIR_PREVIEW_UNAVAILABLE: ["원입고 확인 정보를 불러오지 못했습니다. 다시 조회하세요.", "Không thể tải thông tin phiếu nhập gốc. Hãy thử lại."],
  };
  if (messages[code]) return messages[code][vi ? 1 : 0];
  if (code === "MONTH_CLOSED") return vi ? "Tháng liên quan đã chốt sổ." : "관련 월의 장부가 마감되었습니다.";
  if (code === "PAYABLE_ALREADY_PAID") return vi ? "Công nợ đã thanh toán hoặc có phân bổ. Không thể sửa tự động." : "지급 또는 배분 내역이 있어 자동 수정할 수 없습니다.";
  if (code === "PURCHASE_CORRECTION_EXCEEDS_PURCHASE") return vi ? "Số lượng sửa vượt quá lô nhập gốc." : "수정수량이 원입고의 남은 수량을 초과합니다.";
  if (code === "ISSUE_ALREADY_LINKED") return vi ? "Thay đổi này đã được liên kết. Hãy tải lại." : "이미 연결된 수정입니다. 새로고침해 주세요.";
  return vi ? "Không thể liên kết an toàn. Vui lòng kiểm tra lịch sử kho và sổ kế toán." : "안전하게 연결할 수 없습니다. 재고 이력과 장부를 확인해 주세요.";
}

export function canConfirmPurchaseSupplierChange(candidate: PurchaseRepairCandidate | undefined): boolean {
  const change = candidate?.supplierChange;
  return candidate?.code === "SUPPLIER_CHANGE_CONFIRMATION_REQUIRED" && change?.valid === true &&
    change.requiresConfirmation === true && /^[a-f0-9]{64}$/.test(change.confirmationFingerprint) &&
    !!(change.afterSupplier?.trim() || change.afterPartnerId);
}

export function canSubmitPurchaseRepair(candidate: PurchaseRepairCandidate | undefined, supplierConfirmed: boolean): boolean {
  if (!candidate) return false;
  if (![candidate.effectiveQuantity, candidate.oldAmount, candidate.newAmount, candidate.delta, candidate.quantityDelta ?? 0]
    .every(value => typeof value === "number" && Number.isFinite(value))) return false;
  if (candidate.code === "SUPPLIER_CHANGE_CONFIRMATION_REQUIRED") return supplierConfirmed && canConfirmPurchaseSupplierChange(candidate);
  return candidate.safe === true && candidate.code === "READY" && candidate.supplierChange?.requiresConfirmation !== true;
}
