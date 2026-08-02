import type { PayrollUiLang } from "./ui-labels";

const messages: Record<PayrollUiLang, Record<string, string>> = {
  ko: {
    CONTRACT_PERIOD_CONFLICT: "같은 기간에 적용되는 급여계약이 이미 있습니다. 기존 계약의 적용일을 확인하거나 최신 계약을 정정해주세요.",
    INVALID_CONTRACT: "급여계약 입력값이 올바르지 않습니다. 입력 내용을 다시 확인해주세요.",
    FIXED_RAISE_REASON_REQUIRED: "고정 급여인상 총액 변경 사유를 입력해주세요.",
    INVALID_FIXED_MONTHLY_EFFECTIVE_DATE: "매월 고정 지급 계약은 매월 1일부터 적용할 수 있습니다.",
    PAYROLL_CONTRACT_CREATE_FAILED: "급여계약을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.",
    CONTRACT_NOT_LATEST: "가장 최신 급여계약만 직접 정정할 수 있습니다.",
    CONTRACT_ALREADY_USED: "이미 급여 계산에 사용된 계약은 직접 정정할 수 없습니다. 새 적용일로 계약을 등록하거나 기존 급여 장부를 먼저 확인해주세요.",
    CONTRACT_LOCKED_PAYROLL: "확정 또는 지급 완료 급여 장부에 사용된 계약은 정정할 수 없습니다.",
    CONTRACT_REVISION_CONFLICT: "다른 관리자가 이 계약을 먼저 변경했습니다. 최신 계약 정보를 다시 불러온 뒤 확인해주세요.",
    CONTRACT_EFFECTIVE_FROM_CHANGE_FORBIDDEN: "최신 계약 정정에서는 적용 시작일을 변경할 수 없습니다.",
    CONTRACT_CORRECTION_REASON_REQUIRED: "계약 정정 사유를 입력해주세요.",
    CONTRACT_CORRECTION_FORBIDDEN: "급여계약을 정정할 권한이 없습니다.",
    FORBIDDEN: "급여계약을 관리할 권한이 없습니다.",
    PAYROLL_CONTRACT_CORRECTION_FAILED: "급여계약을 정정하지 못했습니다. 잠시 후 다시 시도해주세요.",
    WORK_SCHEDULE_NOT_FOUND: "계약 적용일에 유효한 직원 근무시간이 없습니다. 직원관리에서 근무시간을 먼저 등록해주세요.",
    WORK_SCHEDULE_OVERLAP: "계약 적용일의 근무시간 이력이 겹칩니다. 직원 근무시간 이력을 확인해주세요.",
    INVALID_WORK_SCHEDULE: "직원 근무시간 또는 휴게시간이 올바르지 않아 하루 근무시간을 계산할 수 없습니다.",
  },
  vi: {
    CONTRACT_PERIOD_CONFLICT: "Đã có hợp đồng lương áp dụng trong cùng khoảng thời gian. Vui lòng kiểm tra ngày áp dụng của hợp đồng hiện tại hoặc chỉnh sửa hợp đồng mới nhất.",
    INVALID_CONTRACT: "Thông tin hợp đồng lương không hợp lệ. Vui lòng kiểm tra lại.",
    FIXED_RAISE_REASON_REQUIRED: "Vui lòng nhập lý do thay đổi tổng mức tăng lương cố định.",
    INVALID_FIXED_MONTHLY_EFFECTIVE_DATE: "Hợp đồng trả cố định hàng tháng chỉ có thể áp dụng từ ngày đầu tiên của tháng.",
    PAYROLL_CONTRACT_CREATE_FAILED: "Không thể lưu hợp đồng lương. Vui lòng thử lại sau.",
    CONTRACT_NOT_LATEST: "Chỉ có thể chỉnh sửa trực tiếp hợp đồng lương mới nhất.",
    CONTRACT_ALREADY_USED: "Hợp đồng đã được dùng để tính lương nên không thể chỉnh sửa trực tiếp. Vui lòng đăng ký hợp đồng với ngày áp dụng mới hoặc kiểm tra sổ lương hiện có.",
    CONTRACT_LOCKED_PAYROLL: "Không thể chỉnh sửa hợp đồng đã được dùng trong bảng lương đã chốt hoặc đã thanh toán.",
    CONTRACT_REVISION_CONFLICT: "Một quản trị viên khác đã thay đổi hợp đồng này. Vui lòng tải lại thông tin mới nhất rồi kiểm tra lại.",
    CONTRACT_EFFECTIVE_FROM_CHANGE_FORBIDDEN: "Không thể thay đổi ngày bắt đầu áp dụng khi chỉnh sửa hợp đồng mới nhất.",
    CONTRACT_CORRECTION_REASON_REQUIRED: "Vui lòng nhập lý do chỉnh sửa hợp đồng.",
    CONTRACT_CORRECTION_FORBIDDEN: "Bạn không có quyền chỉnh sửa hợp đồng lương.",
    FORBIDDEN: "Bạn không có quyền quản lý hợp đồng lương.",
    PAYROLL_CONTRACT_CORRECTION_FAILED: "Không thể chỉnh sửa hợp đồng lương. Vui lòng thử lại sau.",
    WORK_SCHEDULE_NOT_FOUND: "Không có lịch làm việc hợp lệ vào ngày áp dụng hợp đồng. Vui lòng thiết lập giờ làm việc trong quản lý nhân viên trước.",
    WORK_SCHEDULE_OVERLAP: "Lịch sử giờ làm việc bị trùng vào ngày áp dụng hợp đồng. Vui lòng kiểm tra lại.",
    INVALID_WORK_SCHEDULE: "Không thể tính giờ làm việc mỗi ngày vì giờ làm việc hoặc thời gian nghỉ không hợp lệ.",
  },
};

export function payrollContractErrorMessage(lang: PayrollUiLang, code: unknown, fallbackCode = "PAYROLL_CONTRACT_CORRECTION_FAILED") {
  const safeCode = typeof code === "string" ? code : "";
  return messages[lang][safeCode] ?? messages[lang][fallbackCode] ?? messages[lang].PAYROLL_CONTRACT_CORRECTION_FAILED;
}
