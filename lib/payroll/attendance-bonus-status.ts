export type AttendanceBonusStatusPolicy = {
  minimumActualWorkdays: number;
  allowedLateCount: number;
  allowedEarlyLeaveCount: number;
  bonusAmount: number;
};

export type AttendanceBonusMonthlyStanding = {
  actualWorkDays: number;
  lateCount: number;
  earlyLeaveCount: number;
  unauthorizedAbsenceCount: number;
  blockingCount: number;
  perfectAttendanceCurrent: boolean;
};

export function attendanceBonusMonthlyStatus(input: {
  vi: boolean;
  isEligible: boolean;
  eligibilityEffectiveMonth: string | null;
  payrollMonth: string;
  monthClosed: boolean;
  policy: AttendanceBonusStatusPolicy | null;
  standing: AttendanceBonusMonthlyStanding | null;
}) {
  const { vi, policy, standing } = input;
  if (!input.isEligible) return vi ? "Không áp dụng" : "미대상";
  if (input.eligibilityEffectiveMonth && input.eligibilityEffectiveMonth > input.payrollMonth) {
    return vi ? "Chưa áp dụng" : "적용 전";
  }
  if (!policy) return vi ? "Chưa thiết lập chính sách chung" : "공통 정책 미설정";
  if (!standing) return vi ? "Cần kiểm tra chấm công" : "근태 확인 필요";

  const failures: string[] = [];
  if (standing.blockingCount > 0) failures.push(vi ? "cần kiểm tra chấm công" : "근태 확인 필요");
  if (standing.lateCount > policy.allowedLateCount) failures.push(vi ? `đi muộn ${standing.lateCount} lần` : `지각 ${standing.lateCount}회`);
  if (standing.earlyLeaveCount > policy.allowedEarlyLeaveCount) failures.push(vi ? `về sớm ${standing.earlyLeaveCount} lần` : `조퇴 ${standing.earlyLeaveCount}회`);
  if (standing.unauthorizedAbsenceCount > 0) failures.push(vi ? `vắng không phép ${standing.unauthorizedAbsenceCount} lần` : `무단결근 ${standing.unauthorizedAbsenceCount}회`);
  const workdaysMet = standing.actualWorkDays >= policy.minimumActualWorkdays;

  if (input.monthClosed) {
    if (failures.length === 0 && workdaysMet) {
      return vi
        ? `Đã xác nhận chi trả · ${policy.bonusAmount.toLocaleString("en-US")} VND`
        : `지급 확정 · ${policy.bonusAmount.toLocaleString("en-US")} VND`;
    }
    return vi ? "Không chi trả · Không đạt điều kiện" : "미지급 · 조건 미충족";
  }
  if (failures.length > 0) {
    return `${vi ? "Không đạt điều kiện" : "조건 미충족"} · ${failures.join(" · ")}`;
  }
  const progress = `${standing.actualWorkDays}/${policy.minimumActualWorkdays}${vi ? " ngày" : "일"}`;
  if (workdaysMet) return `${vi ? "Đang đáp ứng điều kiện chi trả" : "지급 조건 충족 중"} · ${progress}`;
  if (standing.perfectAttendanceCurrent) return `💯 ${vi ? "Đang duy trì" : "유지 중"} · ${progress}`;
  return `${vi ? "Đang duy trì điều kiện" : "조건 유지 중"} · ${progress}`;
}
