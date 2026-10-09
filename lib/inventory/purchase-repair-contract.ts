export type PurchaseRepairCandidate = {
  safe: boolean; code: string; inventoryLogId: number; businessDate: string;
  quantity: number; effectiveQuantity: number; unit: string | null; price: number; supplier: string | null;
  oldAmount: number | null; newAmount: number | null; delta: number | null;
  quantityDelta?: number;
  newSupplier?: string | null;
};
export type PurchaseRepairPreview = { candidates: PurchaseRepairCandidate[]; recommended: boolean };

export function purchaseRepairState(code: string, vi: boolean, cancelled = false) {
  if (code === "REBOOKED" || code === "PURCHASE_CANCELLED") return vi ? "Đã điều chỉnh sổ kế toán" : "장부 정정 완료";
  if (cancelled || code === "PURCHASE_ORIGINAL_CANCELLED") return vi ? "Phiếu nhập gốc đã bị hủy" : "원본 입고 취소됨";
  if (code === "PURCHASE_AMOUNT_CONFIRMATION_REQUIRED") return vi ? "Cần xác nhận thay đổi số tiền" : "금액 변경 확인 필요";
  return vi ? "Cần xác nhận phiếu nhập gốc" : "원본 입고 연결 확인 필요";
}

export function canReviewPurchaseCorrection(code: string) {
  return ["PURCHASE_CORRECTION_REFERENCE_REQUIRED", "PURCHASE_AMOUNT_CONFIRMATION_REQUIRED", "PURCHASE_ORIGINAL_CANCELLED", "MONTH_CLOSED", "PAYABLE_ALREADY_PAID"].includes(code);
}

export function purchaseRepairError(code: string, vi: boolean) {
  if (code === "MONTH_CLOSED") return vi ? "Tháng liên quan đã chốt sổ." : "관련 월의 장부가 마감되었습니다.";
  if (code === "PAYABLE_ALREADY_PAID") return vi ? "Công nợ đã thanh toán hoặc có phân bổ. Không thể sửa tự động." : "지급 또는 배분 내역이 있어 자동 수정할 수 없습니다.";
  if (code === "PURCHASE_CORRECTION_EXCEEDS_PURCHASE") return vi ? "Số lượng sửa vượt quá lô nhập gốc." : "수정수량이 원입고의 남은 수량을 초과합니다.";
  if (code === "ISSUE_ALREADY_LINKED") return vi ? "Thay đổi này đã được liên kết. Hãy tải lại." : "이미 연결된 수정입니다. 새로고침해 주세요.";
  return vi ? "Không thể liên kết an toàn. Vui lòng kiểm tra lịch sử kho và sổ kế toán." : "안전하게 연결할 수 없습니다. 재고 이력과 장부를 확인해 주세요.";
}
