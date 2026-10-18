import { purchaseRepairError } from "../inventory/purchase-repair-contract";

// Presentation-only translations. Unknown codes must not imply an unverified cause.
export function purchaseReviewExplanation(code: string, vi: boolean, amountChanged: boolean) {
  if (code === "PURCHASE_AMOUNT_CONFIRMATION_REQUIRED") return amountChanged
    ? vi ? "Không thể tự động ghi nhận an toàn số tiền nhập đã sửa vào sổ hiện tại. Hãy kiểm tra bút toán."
      : "수정된 입고금액을 기존 장부에 안전하게 자동 반영할 수 없습니다. 장부 기록을 확인해 주세요."
    : vi ? "Hãy đối chiếu nội dung sửa phiếu nhập với bút toán hiện tại." : "입고 수정 내용과 기존 장부 기록을 대조해 주세요.";
  if (code === "SUPPLIER_CHANGE_CONFIRMATION_REQUIRED") return vi
    ? "Hãy xác nhận nhà cung cấp thực tế sau thay đổi trước khi điều chỉnh sổ và công nợ."
    : "장부와 미지급금을 수정하기 전에 변경 후 실제 지급 거래처를 확인해 주세요.";
  if (code === "PURCHASE_CORRECTION_REFERENCE_REQUIRED") return vi
    ? "Cần xác nhận liên kết giữa thay đổi, phiếu nhập gốc và bút toán." : "수정 내역이 어떤 원입고와 장부에 연결되는지 확인해 주세요.";
  if (code === "PURCHASE_ORIGINAL_CANCELLED") return vi
    ? "Phiếu nhập gốc đã bị hủy. Hãy kiểm tra việc điều chỉnh bút toán và công nợ liên quan."
    : "원입고가 취소됐습니다. 연결된 장부와 미지급금의 정정 내용을 확인해 주세요.";
  if (code === "READY") return vi ? "Hãy kiểm tra nội dung điều chỉnh trước khi xác nhận." : "확정하기 전에 장부 수정 내용을 확인해 주세요.";
  return purchaseRepairError(code, vi);
}

export function purchaseReviewEventLabel(kind: string, action: string | undefined, payableCancelled: boolean | undefined, vi: boolean) {
  const actions: Record<string, [string, string]> = {
    candidate_confirmed_verification_pending: ["입고 장부 등록 · 증빙 확인 대기", "Ghi nhận nhập kho · chờ kiểm tra chứng từ"],
    candidate_confirmed_payable: ["입고 장부·미지급금 등록", "Ghi nhận nhập kho và công nợ"],
    inventory_source_projected: ["입고 정보 장부 연동 검토", "Kiểm tra đồng bộ phiếu nhập với sổ"],
    inventory_purchase_auto_corrected: ["장부 자동 정정 완료", "Đã tự động điều chỉnh sổ"],
    inventory_purchase_correction_linked: ["원입고 연결 및 장부 정정", "Liên kết phiếu nhập gốc và điều chỉnh sổ"],
    inventory_source_rebooked: payableCancelled
      ? ["역분개·기존 미납취소", "Đảo bút toán và hủy công nợ cũ"] : ["역분개·장부 정정", "Đảo bút toán và điều chỉnh sổ"],
  };
  if (kind === "ledger") return actions[action || ""]?.[vi ? 1 : 0] || (vi ? "Ghi nhận xử lý sổ" : "장부 처리 기록");
  return ({ purchase: ["원입고", "Nhập gốc"], correction: ["입고 수정·취소", "Sửa / hủy phiếu nhập"],
    stock_check: ["재고조사 (입고 수량 집계 제외)", "Kiểm kê (không đổi số lượng nhập)"] } as Record<string, string[]>)[kind]?.[vi ? 1 : 0]
    || (vi ? "Lịch sử kho" : "재고 이력");
}
