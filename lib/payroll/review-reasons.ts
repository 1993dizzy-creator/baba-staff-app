// /admin/payroll "확인 필요" 사유 표시 전용. 새 급여 검토 기준을 만들지 않고, overview가 이미 내려준
// 판정(calculationStatus · warningCodes · contract · combinedSalary)을 분류·요약만 한다.
// - calculationStatus === "calculable" 이면 사유가 없다(필터 "확인 필요"와 같은 기준).
// - 사유 라벨은 기존 reviewLabel()을 그대로 쓰고, 여기서는 해결 위치(카테고리)만 정한다.
import { reviewLabel, type PayrollUiLang } from "./ui-labels.ts";

export type PayrollReviewCategory = "attendance" | "extraWork" | "contract" | "insuranceTax" | "level" | "notStarted" | "other";

export type PayrollReviewReasonInput = {
  calculationStatus: "calculable" | "requires_review" | "unavailable";
  contract: unknown | null;
  warningCodes: readonly string[];
  amounts: { combinedSalary: number | null };
};

export type PayrollReviewReasons = {
  /** 카테고리 순서 = 헤더 표시 우선순위 */
  categories: PayrollReviewCategory[];
  /** 상세에 보여줄 전체 사유(중복 제거, 기존 reviewLabel 문구) */
  details: { category: PayrollReviewCategory; code: string; label: string }[];
};

const CATEGORY_ORDER: PayrollReviewCategory[] = ["notStarted", "contract", "level", "attendance", "extraWork", "insuranceTax", "other"];

const CODE_CATEGORY: Record<string, PayrollReviewCategory> = {
  NO_PAYROLL_CONTRACT: "contract",
  CONTRACT_OVERLAP: "contract",
  SCHEDULE_HISTORY_UNAVAILABLE: "contract",
  EMPLOYEE_LEVEL_BASE_DATE_REQUIRED: "level",
  MISSING_CHECK_IN: "attendance",
  MISSING_CHECK_OUT: "attendance",
  INVALID_TIME_RANGE: "attendance",
  UNRESOLVED_ATTENDANCE: "attendance",
  PENDING_LEAVE_APPROVAL: "attendance",
  LEAVE_PAYROLL_TREATMENT_UNSPECIFIED: "attendance",
  OVERTIME_APPROVAL_UNAVAILABLE: "attendance",
  LATE_POLICY_REVIEW: "attendance",
  EARLY_LEAVE_POLICY_REVIEW: "attendance",
  EARLY_LEAVE_REVIEW_REQUIRED: "attendance",
  STORED_STATUS_POLICY_MISMATCH: "attendance",
  STORED_LATE_MINUTES_MISMATCH: "attendance",
  STORED_EARLY_LEAVE_MINUTES_MISMATCH: "attendance",
  STORED_WORK_MINUTES_MISMATCH: "attendance",
  PART_TIME_EXTRA_WORK_REVIEW_REQUIRED: "extraWork",
  PART_TIME_EXTRA_WORK_DECISION_STALE: "extraWork",
  TAX_PROFILE_REQUIRES_REVIEW: "insuranceTax",
  TAX_POLICY_MISSING: "insuranceTax",
  TAX_POLICY_INVALID: "insuranceTax",
  OVERTIME_TAX_EXEMPTION_REQUIRES_REVIEW: "insuranceTax",
};

export function payrollReviewCategoryForCode(code: string): PayrollReviewCategory {
  return CODE_CATEGORY[code] ?? "other";
}

export function getPayrollReviewReasons(employee: PayrollReviewReasonInput, future: boolean, lang: PayrollUiLang): PayrollReviewReasons {
  if (employee.calculationStatus === "calculable") return { categories: [], details: [] };
  const details: PayrollReviewReasons["details"] = [];
  const push = (category: PayrollReviewCategory, code: string, label: string) => {
    if (!details.some((item) => item.code === code)) details.push({ category, code, label });
  };
  if (future) {
    push("notStarted", "PERIOD_NOT_STARTED", lang === "vi" ? "Tháng lương chưa bắt đầu nên chưa tính." : "조회 월이 시작되지 않아 아직 계산하지 않습니다.");
  } else if (!employee.contract) {
    push("contract", "NO_PAYROLL_CONTRACT", reviewLabel(lang, "NO_PAYROLL_CONTRACT"));
  } else if (employee.amounts.combinedSalary === null) {
    push("level", "EMPLOYEE_LEVEL_BASE_DATE_REQUIRED", reviewLabel(lang, "EMPLOYEE_LEVEL_BASE_DATE_REQUIRED"));
  }
  if (!future) for (const code of employee.warningCodes) push(payrollReviewCategoryForCode(code), code, reviewLabel(lang, code));
  if (details.length === 0) push("other", "REVIEW_REQUIRED", reviewLabel(lang, "REVIEW_REQUIRED"));
  const categories = CATEGORY_ORDER.filter((category) => details.some((item) => item.category === category));
  return { categories, details };
}

export function payrollReviewCategoryLabel(category: PayrollReviewCategory, lang: PayrollUiLang) {
  const ko: Record<PayrollReviewCategory, string> = {
    notStarted: "계산 전",
    contract: "급여계약 확인 필요",
    level: "레벨 기준일 필요",
    attendance: "근태 미완료",
    extraWork: "추가근무 승인 대기",
    insuranceTax: "보험/TNCN 설정 확인 필요",
    other: "급여 데이터 확인 필요",
  };
  const vi: Record<PayrollReviewCategory, string> = {
    notStarted: "Chưa tính",
    contract: "Cần kiểm tra hợp đồng",
    level: "Cần ngày cơ sở cấp",
    attendance: "Chấm công chưa hoàn tất",
    extraWork: "Chờ duyệt làm thêm",
    insuranceTax: "Cần kiểm tra BH/TNCN",
    other: "Cần kiểm tra dữ liệu lương",
  };
  return (lang === "vi" ? vi : ko)[category];
}

/** 해결 화면 링크. extraWork는 카드 내부 영역이라 href가 없다. */
export function payrollReviewCategoryHref(category: PayrollReviewCategory, userId: number, month: string): string | null {
  if (category === "attendance") return `/admin/payroll/attendance/${userId}?month=${month}`;
  if (category === "contract" || category === "insuranceTax") return `/admin/payroll/settings?tab=employee&userId=${userId}&month=${month}`;
  if (category === "level") return "/admin/users";
  return null;
}
