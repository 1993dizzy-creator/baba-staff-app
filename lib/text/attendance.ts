export const attendanceText = {
  ko: {
    workBefore: "출근전",
    working: "근무중",
    workDone: "퇴근완료",
    workEarlyLeave: "조퇴",
    workLeave: "휴무",
    workNormal: "정상",
    workLate: "지각",
    checkIn: "출근",
    checkOut: "퇴근",
    workTime: "근무",

    checkInTimeLabel: "출근시간",
    checkOutTimeLabel: "퇴근시간",
    workDurationLabel: "근무시간",
    updateCheckIn: "출근 수정",
    updateCheckOut: "퇴근 수정",
    checkInProcess: "출근 처리",
    checkOutProcess: "퇴근 처리",
    standardCheckIn: "정시 출근",
    standardCheckOut: "정시 퇴근",

  
    absent: "미출근",
    viewDetail: "상세보기",
    monthFormat: "{year}년 {month}월",
    lateText: "지각 {minutes}분",
    earlyLeaveText: "조퇴 {minutes}분",

    checkInButton: "출근하기",
    checkInButtonDesc: "출근 시간 기록",
    checkOutButton: "퇴근하기",
    checkOutButtonDesc: "퇴근 시간 기록",

    monthSummaryTitle: "이번 달 근태 요약",
    monthCalendar: "월간 휴무 캘린더",
    staffSummary: "직원별 휴무 요약",

    summaryWorkDays: "근무일",
    summaryTotalWorkTime: "총 근무시간",


    checkInFail: "출근 기록에 실패했습니다.",
    checkOutFail: "퇴근 기록에 실패했습니다.",
    gpsFail: "GPS 위치를 가져올 수 없습니다. 위치 권한을 허용해주세요.",
    checkInOutOfRange: "출근 가능 범위를 벗어났습니다. 현재 거리: {distance}m",
    checkOutOutOfRange: "퇴근 가능 범위를 벗어났습니다. 현재 거리: {distance}m",

    positions: {
      staff: "직원",
      manager: "매니저",
      leader: "리더",
    },

    approvalPending: "승인대기",
    approvalApproved: "승인완료",
    approve: "승인",
    cancelApproval: "승인취소",
    cancelRequest: "신청취소",

    leaveRequest: "휴무신청",
    leaveCancel: "휴무취소",
    leaveCancelConfirm: "이 휴무 신청을 취소할까요?",
    leaveReasonRequired: "금/토요일 휴무는 사유를 입력해주세요.",
  },

  vi: {
    workBefore: "Chưa vào ca",
    working: "Đang làm",
    workDone: "Đã tan ca",
    workEarlyLeave: "Về sớm",
    workLeave: "Nghỉ",
    workNormal: "Đúng giờ",
    workLate: "Đi muộn",
    checkIn: "Vào",
    checkOut: "Về",
    workTime: "Làm",

    checkInTimeLabel: "Giờ vào",
    checkOutTimeLabel: "Giờ ra",
    workDurationLabel: "Thời gian làm",
    checkInProcess: "Xử lý vào ca",
    checkOutProcess: "Xử lý ra ca",
    standardCheckIn: "Vào đúng giờ",
    standardCheckOut: "Ra đúng giờ",
    updateCheckIn: "Sửa giờ vào",
    updateCheckOut: "Sửa giờ ra",


    absent: "Vắng",
    viewDetail: "Xem chi tiết",
    monthFormat: "Tháng {month}/{year}",
    lateText: "Muộn {minutes} phút",
    earlyLeaveText: "Về sớm {minutes} phút",

    checkInButton: "Vào ca",
    checkInButtonDesc: "Ghi nhận giờ vào",
    checkOutButton: "Tan ca",
    checkOutButtonDesc: "Ghi nhận giờ ra",


    monthSummaryTitle: "Tóm tắt chấm công tháng này",
    monthCalendar: "Lịch nghỉ tháng",
    staffSummary: "Tổng hợp theo nhân viên",

    summaryWorkDays: "Ngày làm",
    summaryTotalWorkTime: "Tổng giờ làm",

    checkInFail: "Không thể ghi nhận giờ vào.",
    checkOutFail: "Không thể ghi nhận giờ ra.",
    gpsFail: "Không thể lấy vị trí GPS. Vui lòng bật quyền vị trí.",
    checkInOutOfRange: "Bạn đang ở ngoài phạm vi chấm công. Khoảng cách hiện tại: {distance}m",
    checkOutOutOfRange: "Bạn đang ở ngoài phạm vi chấm công. Khoảng cách hiện tại: {distance}m",

    positions: {
      staff: "Nhân viên",
      manager: "Quản lý",
      leader: "Trưởng nhóm",
    },

    approvalPending: "Chờ duyệt",
    approvalApproved: "Đã duyệt",
    approve: "Duyệt",
    cancelApproval: "Hủy duyệt",
    cancelRequest: "Hủy đơn",

    leaveRequest: "Đăng ký nghỉ",
    leaveCancel: "Hủy ngày nghỉ",
    leaveCancelConfirm: "Hủy yêu cầu nghỉ này?",
    leaveReasonRequired: "Vui lòng nhập lý do nghỉ.",
  },
} as const;