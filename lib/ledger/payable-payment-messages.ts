export const PAYMENT_REFRESH_MESSAGES = {
  ko: "지급 화면을 새로고침해 주세요. 기존 지급 요청이 있으면 새로고침 후 먼저 결과를 확인해 주세요.",
  vi: "Vui lòng tải lại trang thanh toán. Nếu có yêu cầu cũ, hãy kiểm tra kết quả trước khi ghi khoản mới.",
};

export function payablePaymentErrorMessage(code: string, vi: boolean): string {
  if (code === "IDEMPOTENCY_KEY_REQUIRED") return PAYMENT_REFRESH_MESSAGES[vi ? "vi" : "ko"];
  if (code === "IDEMPOTENCY_STATE_INVALID") return vi
    ? "Cần kiểm tra bản ghi yêu cầu thanh toán. Không tạo yêu cầu mới; vui lòng liên hệ quản trị viên."
    : "지급 요청 기록을 확인해야 합니다. 새 요청을 만들지 말고 관리자에게 확인해 주세요.";
  // Existing load failures already contain localized text.
  if (!/^[A-Z_]+$/.test(code)) return code;
  return vi ? "Chưa xác nhận thanh toán. Hãy kiểm tra yêu cầu cũ nếu có."
    : "지급 결과를 확인하지 못했습니다. 기존 요청이 있으면 결과를 확인해 주세요.";
}
