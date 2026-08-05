// attendance_tracking_enabled 판정을 여러 route에 중복 작성하지 않기 위한 공통 함수.
// 자기 자신의 근태(출근·휴무 신청)를 만드는 경로와, 관리자가 다른 직원의 새 근태
// 기록을 만드는 경로 양쪽에서 동일하게 사용한다. 기존 열린 기록의 퇴근·보정·취소·조회는
// 이 판정과 무관하게 항상 허용되므로, 이 함수는 "신규 근태 기록 생성"을 막을지 결정할
// 때만 사용해야 한다.

export type AttendanceTrackingUser = {
  attendance_tracking_enabled: boolean | null;
  is_system_account: boolean | null;
};

export const ATTENDANCE_TRACKING_DISABLED_CODE = "ATTENDANCE_TRACKING_DISABLED";

export function isAttendanceTrackingUser(user: AttendanceTrackingUser): boolean {
  return user.attendance_tracking_enabled === true && user.is_system_account !== true;
}

export function getAttendanceTrackingDisabledMessage(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Nhân viên này không sử dụng chấm công."
    : "근태를 사용하지 않는 직원입니다.";
}
