export const attendanceText = {
  ko: {
    pageTitle: "근태",
    pageDescription: "출근, 퇴근, 근태 현황을 확인하세요.",

    tabs: {
      myAttendance: "내 근태",
      summary: "전체현황",
      staff: "출근명부",
      leave: "휴무관리",
    },

    todayCardTitle: "오늘 근태",
    todayDate: "2025.05.20 (화)",

    statusLabel: "상태",
    statusBefore: "출근전",
    statusWorking: "근무중",
    statusDone: "퇴근완료",

    checkInTimeLabel: "출근시간",
    checkOutTimeLabel: "퇴근시간",
    workDurationLabel: "근무시간",

    lateText: "지각 {minutes}분",

    checkInButton: "출근하기",
    checkInButtonDesc: "출근 시간 기록",
    checkOutButton: "퇴근하기",
    checkOutButtonDesc: "퇴근 시간 기록",

    calendarTitle: "2025년 5월",
    calendarWeekdays: ["일", "월", "화", "수", "목", "금", "토"],

    legendNormal: "정상",
    legendLate: "지각",
    legendEarlyLeave: "조퇴",
    legendLeave: "휴무",

    monthSummaryTitle: "이번 달 근태 요약",

    summaryWorkDays: "근무일",
    summaryTotalWorkTime: "총 근무시간",
    summaryLate: "지각",
    summaryEarlyLeave: "조퇴",
    summaryLeave: "휴무",
  },

  vi: {
    pageTitle: "Chấm công",
    pageDescription: "Kiểm tra giờ vào, giờ ra và tình trạng chấm công.",

    tabs: {
      myAttendance: "Cá nhân",
      summary: "Tổng quan",
      staff: "Nhân viên",
      leave: "Nghỉ phép",
    },

    todayCardTitle: "Chấm công hôm nay",
    todayDate: "2025.05.20 (Th 3)",

    statusLabel: "Trạng thái",
    statusBefore: "Chưa vào ca",
    statusWorking: "Đang làm",
    statusDone: "Đã tan ca",

    checkInTimeLabel: "Giờ vào",
    checkOutTimeLabel: "Giờ ra",
    workDurationLabel: "Thời gian làm",

    lateText: "Muộn {minutes} phút",

    checkInButton: "Vào ca",
    checkInButtonDesc: "Ghi nhận giờ vào",
    checkOutButton: "Tan ca",
    checkOutButtonDesc: "Ghi nhận giờ ra",

    calendarTitle: "Tháng 5 năm 2025",
    calendarWeekdays: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"],

    legendNormal: "Bình thường",
    legendLate: "Đi muộn",
    legendEarlyLeave: "Về sớm",
    legendLeave: "Nghỉ",

    monthSummaryTitle: "Tóm tắt chấm công tháng này",

    summaryWorkDays: "Ngày làm",
    summaryTotalWorkTime: "Tổng giờ làm",
    summaryLate: "Đi muộn",
    summaryEarlyLeave: "Về sớm",
    summaryLeave: "Nghỉ",
  },
} as const;