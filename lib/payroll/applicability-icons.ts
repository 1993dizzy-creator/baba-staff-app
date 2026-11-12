// 급여관리 카드(components/payroll/CompensationCard.tsx)의 "조회 월 적용 대상" 아이콘 줄과 같은 판정·표시.
// 판정은 급여관리와 같은 공용 함수(getPayrollApplicabilityBadges, shouldShowAttendancePerfectScoreBadge)에
// 같은 overview 입력을 넣어 얻는다. 새 계산을 하지 않으며, 직원관리 목록은 이 결과를 그대로 그린다.
import { getPayrollApplicabilityBadges } from "./payroll-dashboard.ts";
import { shouldShowAttendancePerfectScoreBadge } from "./attendance-bonus.ts";

export type PayrollApplicabilityIcon = {
  key: "attendance" | "meal" | "insurance" | "tax";
  /** 화면 표시: 💯 · 🍚 · 🛡️ · TNCN */
  symbol: string;
  /** KO/VI title·aria-label */
  description: string;
};

export type PayrollApplicabilityEmployee = {
  userId: number;
  insuranceEnrolled?: boolean;
  tax?: { status: string; taxMode: string | null } | null;
  attendanceStanding?: { perfectAttendanceCurrent: boolean } | null;
  automaticIncentives?: readonly { category: string; sourceSnapshot: Record<string, unknown> }[];
};

export function payrollApplicabilityIcons(input: {
  employee: PayrollApplicabilityEmployee;
  month: string;
  future: boolean;
  monthClosed: boolean;
  attendanceBonusEligible: boolean;
  mealAllowanceEligible: boolean;
  lang: "ko" | "vi";
}): PayrollApplicabilityIcon[] {
  const { employee, month, future, monthClosed, attendanceBonusEligible, mealAllowanceEligible, lang } = input;
  const vi = lang === "vi";
  const icons: PayrollApplicabilityIcon[] = [];
  const badges = getPayrollApplicabilityBadges({ employee, month, monthClosed, attendanceBonusEligible, mealAllowanceEligible, lang });
  const attendanceBadge = badges.find((badge) => badge.key === "attendance");
  // CompensationCard: 미래 월이 아니고 개근 배지가 있으면 그 설명으로 💯, 아니면 기존 "현재까지 완벽 근태" 💯 규칙.
  if (!future && attendanceBadge) icons.push({ key: "attendance", symbol: "💯", description: attendanceBadge.description });
  else if (shouldShowAttendancePerfectScoreBadge(attendanceBonusEligible, employee.attendanceStanding?.perfectAttendanceCurrent === true)) {
    icons.push({ key: "attendance", symbol: "💯", description: vi ? "Chấm công hoàn hảo đến hiện tại" : "현재까지 완벽 근태" });
  }
  if (future) {
    // CompensationCard의 미래 월 분기: 식대 대상만 표시한다(mealAllowanceBadgeLabel과 같은 문구).
    if (mealAllowanceEligible) icons.push({ key: "meal", symbol: "🍚", description: vi ? "Đối tượng trợ cấp ăn" : "식대 대상" });
    return icons;
  }
  for (const badge of badges) {
    if (badge.key === "meal") icons.push({ key: "meal", symbol: "🍚", description: badge.description });
    else if (badge.key === "insurance") icons.push({ key: "insurance", symbol: "🛡️", description: badge.description });
    else if (badge.key === "tax") icons.push({ key: "tax", symbol: badge.label, description: badge.description });
  }
  return icons;
}
