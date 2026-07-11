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
    leaveBlockedByWork:
      "이미 출근 또는 근무 기록이 있는 날짜에는 휴무를 신청할 수 없습니다. 관리자에게 근태 보정을 요청해주세요.",
    checkInBlockedByLeave:
      "해당 날짜에 휴무 기록이 있습니다. 휴무 신청을 취소하거나 관리자에게 확인해주세요.",
    checkOrderInvalid:
      "출근 시간은 퇴근 시간보다 늦을 수 없습니다. 출퇴근 시간을 다시 확인해주세요.",
    processing: "처리 중...",
    selectedDate: "선택 날짜",
    attendanceDetail: "근태 상세",
    noRecord: "근태 기록 없음",
    note: "메모",
    saveNote: "메모 저장",
    markNormal: "지각 정상처리",
    correctionReason: "보정 사유",
    checkoutCorrection: "퇴근시간 보정",
    saveCorrection: "수정 저장",
    correctionDone: "보정되었습니다.",
    correctionFailed: "근태 보정에 실패했습니다.",

    noRecordHint: "해당 날짜의 근태 기록이 없습니다. 근무 기록을 추가하거나 휴무로 처리할 수 있습니다.",
    createRecordTab: "근무 기록 추가",
    createLeaveTab: "휴무 처리",
    createRecordSave: "근무 기록 저장",
    createLeaveSave: "휴무 저장",
    leaveReasonLabel: "휴무 사유",
    checkInRequired: "출근 일시를 입력해주세요.",
    scheduleCheckInMissingNotice: "직원의 예정 출근시간이 설정되어 있지 않습니다. 출근 일시를 직접 입력해주세요.",
    scheduleCheckOutMissingNotice: "직원의 예정 퇴근시간이 설정되어 있지 않습니다. 필요하면 퇴근 일시를 직접 입력해주세요.",

    unresolvedOpenRecordsBanner: "퇴근 미처리 기록 {count}건",
    unresolvedOpenRecordBadge: "⚠ 퇴근 미처리",
    unresolvedOpenRecordElapsed: "경과 {duration}",
    unresolvedOpenRecordGoCorrect: "보정하기",
    unresolvedOpenRecordDetailButton: "상세확인",
    unresolvedOpenRecordAutoButton: "자동보정",
    unresolvedOpenRecordAutoProcessing: "자동보정 중...",
    unresolvedOpenRecordAutoConfirm:
      "이 기록의 퇴근시간을 다음 날 01:00으로 자동 보정하시겠습니까?",
    unresolvedOpenRecordAutoFailed: "자동보정에 실패했습니다.",

    inactiveUserSuffix: "비활성",
    orphanRecordLabel: "삭제된 사용자 #{id}",
    orphanRecordNoLinkInfo: "연결 정보 없음",
    orphanRecordDeleteButton: "기록 삭제",
    orphanRecordDeleteConfirm:
      "연결된 직원 정보가 없는 근태 기록입니다. 이 기록을 영구 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.",
    orphanRecordDeleting: "삭제 중...",
    orphanRecordDeleteFailed: "기록 삭제에 실패했습니다.",

    checkInDateTimeLabel: "출근 일시",
    checkOutDateTimeLabel: "퇴근 일시",
    markUnresolved: "퇴근 미처리로 표시",
    workDateConflict: "해당 날짜에 이미 근태 기록이 있습니다.",
    invalidDateTime: "날짜와 시간을 다시 확인해주세요.",

    longShiftWarning: "장시간 근무",
    longShiftWarningWithDuration: "⚠ 장시간 근무 {duration}",
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
    leaveReasonRequired: "Vui lòng nhập lý do khi đăng ký nghỉ vào thứ Sáu hoặc thứ Bảy.",
    leaveBlockedByWork:
      "Không thể đăng ký nghỉ vào ngày đã có dữ liệu chấm công hoặc đang làm việc. Vui lòng liên hệ quản lý để điều chỉnh chấm công.",
    checkInBlockedByLeave:
      "Ngày này đã có yêu cầu nghỉ. Vui lòng hủy yêu cầu nghỉ hoặc liên hệ quản lý để xác nhận.",
    checkOrderInvalid:
      "Giờ vào không được muộn hơn giờ ra. Vui lòng kiểm tra lại giờ chấm công.",
    processing: "Đang xử lý...",
    selectedDate: "Ngày đã chọn",
    attendanceDetail: "Chi tiết chấm công",
    noRecord: "Không có dữ liệu chấm công",
    note: "Ghi chú",
    saveNote: "Lưu ghi chú",
    markNormal: "Chuyển đi muộn thành bình thường",
    correctionReason: "Lý do chỉnh sửa",
    checkoutCorrection: "Sửa giờ ra",
    saveCorrection: "Lưu chỉnh sửa",
    correctionDone: "Đã chỉnh sửa.",
    correctionFailed: "Không thể chỉnh sửa chấm công.",

    noRecordHint: "Ngày này chưa có dữ liệu chấm công. Có thể thêm ca làm việc hoặc xử lý nghỉ phép.",
    createRecordTab: "Thêm ca làm việc",
    createLeaveTab: "Xử lý nghỉ phép",
    createRecordSave: "Lưu ca làm việc",
    createLeaveSave: "Lưu nghỉ phép",
    leaveReasonLabel: "Lý do nghỉ",
    checkInRequired: "Vui lòng nhập giờ vào.",
    scheduleCheckInMissingNotice: "Chưa thiết lập giờ vào dự kiến cho nhân viên này. Vui lòng nhập giờ vào trực tiếp.",
    scheduleCheckOutMissingNotice: "Chưa thiết lập giờ ra dự kiến cho nhân viên này. Vui lòng nhập giờ ra nếu cần.",

    unresolvedOpenRecordsBanner: "{count} ca chưa ghi nhận giờ tan ca",
    unresolvedOpenRecordBadge: "⚠ Chưa ghi nhận giờ tan ca",
    unresolvedOpenRecordElapsed: "Đã qua {duration}",
    unresolvedOpenRecordGoCorrect: "Chỉnh sửa",
    unresolvedOpenRecordDetailButton: "Xem chi tiết",
    unresolvedOpenRecordAutoButton: "Tự động điều chỉnh",
    unresolvedOpenRecordAutoProcessing: "Đang điều chỉnh...",
    unresolvedOpenRecordAutoConfirm:
      "Bạn có muốn tự động điều chỉnh giờ tan ca của bản ghi này thành 01:00 ngày hôm sau không?",
    unresolvedOpenRecordAutoFailed: "Tự động điều chỉnh thất bại.",

    inactiveUserSuffix: "Đã ngừng hoạt động",
    orphanRecordLabel: "Người dùng đã bị xóa #{id}",
    orphanRecordNoLinkInfo: "Không có thông tin liên kết",
    orphanRecordDeleteButton: "Xóa bản ghi",
    orphanRecordDeleteConfirm:
      "Bản ghi chấm công này không còn thông tin nhân viên liên kết. Bạn có muốn xóa vĩnh viễn bản ghi này không? Thao tác này không thể hoàn tác.",
    orphanRecordDeleting: "Đang xóa...",
    orphanRecordDeleteFailed: "Xóa bản ghi thất bại.",

    checkInDateTimeLabel: "Ngày giờ vào",
    checkOutDateTimeLabel: "Ngày giờ ra",
    markUnresolved: "Đánh dấu chưa tan ca",
    workDateConflict: "Ngày này đã có dữ liệu chấm công.",
    invalidDateTime: "Vui lòng kiểm tra lại ngày giờ.",

    longShiftWarning: "Ca làm việc quá dài",
    longShiftWarningWithDuration: "⚠ Ca làm việc quá dài: {duration}",
  },
} as const;
