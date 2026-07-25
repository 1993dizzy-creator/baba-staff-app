"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Container from "@/components/Container";
import { StorePosShadowGate } from "@/components/StorePosShadowPanel";
import { useLanguage } from "@/lib/language-context";
import {
  addStoreDays,
  calculateStoreBusinessDate,
} from "@/lib/store-settings/business-time";
import { groupStoreHours } from "@/lib/store-settings/hours-summary";
import { formatVietnamTime } from "@/lib/common/business-time";
import {
  DEFAULT_STORE_ATTENDANCE_POLICY,
  DEFAULT_STORE_HOURS,
  STORE_TIMEZONE,
  type StoreBusinessHour,
  type StoreSetting,
  type StoreSettingAuditLog,
  type StoreSettingsOverview,
} from "@/lib/store-settings/types";
import { resolveDisplayStatus } from "@/lib/attendance/shadow";
import type {
  AttendanceShadowComparison,
  AttendanceShadowSummary,
} from "@/lib/attendance/shadow";
import { getCompletedBusinessDateRange } from "@/lib/attendance/shadow-period";
import { ui } from "@/lib/styles/ui";

type Tab = "hours" | "attendance" | "shadow";
type ApiData = {
  overview: StoreSettingsOverview;
  capabilities: {
    mutate: boolean;
    audit: boolean;
    posShadow: boolean;
  };
};
type UserOption = { id: number; name: string; username: string };
type ShadowData = {
  businessDate?: string;
  startBusinessDate: string;
  endBusinessDate: string;
  businessDayCount: number;
  historicalManualOverrideWarning: boolean;
  setting: {
    revision: number | null;
    fallbackUsed: boolean;
    attendancePolicy: {
      lateGraceMinutes: number;
      earlyLeaveGraceMinutes: number;
      missingCheckoutGraceMinutes: number;
      defaultNormalCheckoutTime: string;
    };
    storeOpenTime: string | null;
    storeCloseTime: string | null;
    businessDayCutoffTime: string;
  };
  override: {
    actualCloseTime: string;
    reason: string | null;
  } | null;
  summary: AttendanceShadowSummary;
  dateSummaries: Array<{
    businessDate: string;
    settingsRevision: number | null;
    fallbackUsed: boolean;
    storeOpenTime: string | null;
    storeCloseTime: string | null;
    businessDayCutoffTime: string;
    hasBusinessOverride: boolean;
    attendancePolicy: {
      lateGraceMinutes: number;
      earlyLeaveGraceMinutes: number;
      missingCheckoutGraceMinutes: number;
      defaultNormalCheckoutTime: string;
    };
    totalRecords: number;
    compared: number;
    matched: number;
    mismatched: number;
    excluded: number;
  }>;
  differenceTypeCounts: Record<string, number>;
  rows: AttendanceShadowComparison[];
};

const weekdayNames = {
  ko: ["일", "월", "화", "수", "목", "금", "토"],
  vi: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"],
} as const;
const weekdayAriaNames = {
  ko: ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"],
  vi: ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"],
} as const;
const weekdayColor = (weekday: number) =>
  weekday === 0 ? "#dc2626" : weekday === 6 ? "#2563eb" : "#111827";

// 현재 매출·재고 전환이 완료되어 POS 연동 비교 UI는 비활성화한다.
// 필요 시 다시 활성화할 수 있도록 관련 코드와 API는 유지한다.
const SHOW_POS_INTEGRATION_COMPARE = false;

const differenceLabels = {
  ko: {
    late_minutes: "지각 시간 차이",
    early_leave_minutes: "조퇴 시간 차이",
    legacy_90_minute_threshold: "기존 90분 기준 차이",
    special_close: "특별 조기마감 차이",
    employee_store_close: "직원 예정시간·매장 마감 차이",
    unresolved_at: "미퇴근 판정시각 차이",
    manual_late_normalization: "수동 지각 정상처리 제외",
    leave: "휴무 제외",
    other: "기타",
  },
  vi: {
    late_minutes: "Chênh lệch phút đi muộn",
    early_leave_minutes: "Chênh lệch phút về sớm",
    legacy_90_minute_threshold: "Chênh lệch ngưỡng cũ 90 phút",
    special_close: "Chênh lệch đóng cửa sớm đặc biệt",
    employee_store_close: "Chênh lệch giờ nhân viên và cửa hàng",
    unresolved_at: "Chênh lệch mốc chưa chấm ra",
    manual_late_normalization: "Loại trừ chuẩn hóa đi muộn thủ công",
    leave: "Loại trừ ngày nghỉ",
    other: "Khác",
  },
} as const;

function differenceLabel(lang: "ko" | "vi", value: string) {
  return differenceLabels[lang][
    value as keyof (typeof differenceLabels)["ko"]
  ] ?? value;
}

function exclusionReasonLabel(
  lang: "ko" | "vi",
  reason: AttendanceShadowComparison["exclusionReason"]
) {
  const t = copy[lang];
  if (reason === "leave") return t.exclusionLeave;
  if (reason === "no_check_in") return t.exclusionNoCheckIn;
  return t.exclusionOther;
}

// ISO 시각은 항상 UTC이므로 문자열을 그대로 잘라 쓰면 서버 응답의 UTC 시각이
// 그대로 노출된다. 공용 formatVietnamTime으로 변환해서 표시한다.
const hhmm = formatVietnamTime;

// "YYYY-MM-DD" 영업일 date-key는 이미 캘린더 날짜 문자열이라 시간대 변환이
// 필요 없다 — 앞 두 자리 연도만 잘라 좁은 카드에서 밀도를 줄인다.
function shortDate(dateKey: string) {
  return dateKey.length === 10 ? dateKey.slice(2) : dateKey;
}

function displayStatusLabel(
  lang: "ko" | "vi",
  input: {
    status: string;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    unresolved: boolean;
  }
) {
  const t = copy[lang];
  return t.statusLabels[resolveDisplayStatus(input)] ?? input.status;
}

function changeTypeBadgeLabel(
  lang: "ko" | "vi",
  primaryDifference: AttendanceShadowComparison["summary"]["primaryDifference"]
) {
  const t = copy[lang];
  switch (primaryDifference) {
    case "late":
      return t.changeTypeLate;
    case "early_leave":
      return t.changeTypeEarly;
    case "unresolved":
      return t.changeTypeUnresolved;
    case "status":
      return t.changeTypeStatus;
    case "multiple":
      return t.changeTypeMultiple;
    default:
      return t.matched;
  }
}

const copy = {
  ko: {
    title: "매장 통합설정",
    intro: "운영시간과 근태 판정 기준을 같은 설정 버전으로 관리합니다.",
    tabs: { hours: "운영시간", attendance: "근태설정", shadow: "근태비교" },
    current: "🏪 현재 매장 운영시간",
    attendancePolicyTitle: "⏰ 지각·퇴근 판정 기준",
    scheduled: "📅 예약 설정",
    newSetting: "🗓️ 운영시간 변경",
    newAttendanceSetting: "✏️ 설정 예약",
    timezone: "시간대",
    cutoff: "영업일 마감",
    businessHours: "요일별 운영시간",
    effective: "적용 시작일",
    metaTimezone: "시간대",
    metaCutoff: "마감",
    metaEffective: "적용일",
    open: "영업",
    closed: "휴무",
    save: "통합설정 예약",
    saveAttendance: "통합설정 예약",
    saving: "저장 중…",
    cancel: "예약 취소",
    loading: "설정을 불러오는 중…",
    empty: "예약된 설정이 없습니다.",
    fallback: "근태 정책 테이블이 없거나 값이 없으면 기본 정책을 사용합니다.",
    dbPending: "근태설정 DB 적용 전입니다. 입력값은 유지되며 저장되지 않았습니다.",
    conflict: "다른 사용자가 설정을 변경했습니다. 새로고침 후 다시 시도해주세요.",
    invalid: "입력값을 다시 확인해주세요.",
    failed: "설정을 처리하지 못했습니다.",
    created: "생성",
    cancelled: "취소",
    history: "🧾 변경 기록",
    hideHistory: "이력 닫기",
    confirmCancel: "예약 설정을 취소하시겠습니까?",
    lateGrace: "지각 기준",
    minutes: "분",
    lateHelp: "직원별 예정 출근시간을 넘긴 뒤 설정된 시간부터 지각으로 처리합니다.",
    earlyLeaveGrace: "조퇴 기준",
    earlyLeaveHelp: "직원별 기준 퇴근시간보다 설정된 시간 이상 일찍 퇴근하면 조퇴로 처리합니다.",
    missingCheckoutGrace: "미퇴근 기준",
    missingCheckoutHelp: "직원별 기준 퇴근시간이 지난 뒤 설정된 시간까지 퇴근 기록이 없으면 미퇴근으로 처리합니다.",
    scheduleNotice: "예약 설정은 선택한 영업일부터 적용되며 기존 기록은 변경하지 않습니다.",
    before: "변경 전",
    after: "변경 후",
    comparisonTitle: "📊 근태 기준 비교",
    comparisonSummary: "📈 비교 요약",
    shadowDate: "영업일",
    startDate: "시작 영업일",
    endDate: "종료 영업일",
    completedNotice: "진행 중인 영업일을 제외한 최근 완료 영업일 7일이 기본값입니다.",
    historyWarning: "기존 기록 중 일부는 수동 정상처리 여부를 식별할 수 없어 비교 결과에 포함될 수 있습니다.",
    manualExcluded: "수동 지각 정상처리 제외",
    leaveExcluded: "휴무 제외",
    excludedRows: "제외 기록",
    dateSummary: "날짜별 요약",
    differenceFilter: "차이 유형",
    allDifferences: "전체 유형",
    employee: "직원",
    allEmployees: "전체 직원",
    compare: "비교 실행",
    comparing: "비교 중…",
    legacy: "기존 근태 기준",
    configured: "새 매장설정 기준",
    revision: "설정 변경번호",
    specialClose: "특별 조기마감",
    defaultClose: "직원 예정 퇴근 적용",
    storeClose: "매장 예정 종료",
    total: "전체",
    matched: "일치",
    mismatched: "불일치",
    statusChanged: "상태 변경",
    lateChanged: "지각 변경",
    earlyChanged: "조퇴 판정 변경",
    unresolvedChanged: "미퇴근 기준 변경",
    autoCloseChanged: "종료 기준 변경",
    noRows: "비교할 출근 기록이 없습니다.",
    status: "상태",
    late: "지각",
    early: "조퇴",
    unresolved: "미퇴근",
    closeSource: "종료 기준",
    overrideSource: "특별 조기마감",
    configuredSource: "요일별 매장 종료",
    fallbackSource: "직원 예정 퇴근 적용",
    fallbackSetting: "기본 설정 적용",
    fallbackBadge: "기본 설정",
    cutoffShort: "마감",
    specialCloseShort: "조기마감",
    statTotal: "전체",
    statMatched: "일치",
    statMismatched: "불일치",
    statExcluded: "제외",
    excludedBadge: "비교 제외",
    notComparedStatus: "근태 계산 대상 아님",
    exclusionLeave: "휴무 기록",
    exclusionNoCheckIn: "출근 기록 없음",
    exclusionOther: "비교 대상 아님",
    manualLateBadge: "수동 지각 정상처리",
    changeTypeLate: "지각 판정 변경",
    changeTypeEarly: "조퇴 판정 변경",
    changeTypeUnresolved: "미퇴근 판정 변경",
    changeTypeStatus: "상태 판정 변경",
    changeTypeMultiple: "복수 판정 변경",
    changedFieldsCount: "개 판정 변경",
    actualCheckIn: "실제 출근",
    actualCheckOut: "실제 퇴근",
    noCheckOutRecord: "퇴근 기록 없음",
    expectedCheckIn: "예정 출근",
    standardCheckout: "기준 퇴근",
    judgmentTime: "판정 시각",
    earlySuffix: "일찍 퇴근",
    lateSuffix: "늦음",
    legacyPrefix: "기존",
    configuredPrefix: "새 기준",
    normalLabel: "정상",
    showDetails: "상세 보기",
    hideDetails: "상세 닫기",
    statusLabels: {
      working: "근무 중",
      done: "정상 완료",
      late: "지각",
      early_leave: "조퇴",
      late_and_early_leave: "지각·조퇴",
      unresolved: "미퇴근",
      leave: "휴무",
    },
    confirmScheduleTitle: "통합설정을 예약할까요?",
    confirmScheduleBody1: "선택한 영업일부터 현재 입력된 운영시간과 근태 기준이 함께 적용됩니다.",
    confirmScheduleBody2: "변경하지 않은 값도 현재 화면에 표시된 값으로 새 통합설정 버전에 포함됩니다.",
    confirmHoursSection: "운영시간",
    confirmAttendanceSection: "근태 기준",
    modalCancel: "취소",
    modalConfirm: "예약하기",
  },
  vi: {
    title: "Cài đặt tích hợp cửa hàng",
    intro:
      "Quản lý giờ hoạt động và quy tắc chấm công trong cùng một phiên bản.",
    tabs: {
      hours: "Giờ mở cửa",
      attendance: "Chấm công",
      shadow: "So sánh",
    },
    current: "🏪 Giờ hoạt động hiện tại",
    attendancePolicyTitle: "⏰ Tiêu chuẩn đi muộn và tan ca",
    scheduled: "📅 Cài đặt đã lên lịch",
    newSetting: "🗓️ Thay đổi giờ mở cửa",
    newAttendanceSetting: "✏️ Lên lịch cài đặt",
    timezone: "Múi giờ",
    cutoff: "Giờ chốt ngày kinh doanh",
    businessHours: "Giờ hoạt động theo ngày",
    effective: "Ngày bắt đầu áp dụng",
    metaTimezone: "Múi giờ",
    metaCutoff: "Giờ chốt",
    metaEffective: "Ngày áp dụng",
    open: "Mở cửa",
    closed: "Nghỉ",
    save: "Lên lịch cài đặt chung",
    saveAttendance: "Lên lịch cài đặt chung",
    saving: "Đang lưu…",
    cancel: "Hủy lịch",
    loading: "Đang tải cài đặt…",
    empty: "Không có cài đặt đã lên lịch.",
    fallback:
      "Dùng chính sách mặc định nếu bảng hoặc dữ liệu chấm công chưa tồn tại.",
    dbPending:
      "Cơ sở dữ liệu cài đặt chấm công chưa được áp dụng. Dữ liệu nhập được giữ lại nhưng chưa lưu.",
    conflict:
      "Cài đặt đã được thay đổi. Vui lòng tải lại và thử lại.",
    invalid: "Vui lòng kiểm tra lại dữ liệu.",
    failed: "Không thể xử lý cài đặt.",
    created: "Tạo",
    cancelled: "Hủy",
    history: "🧾 Lịch sử thay đổi",
    hideHistory: "Đóng lịch sử",
    confirmCancel: "Bạn có muốn hủy cài đặt đã lên lịch không?",
    lateGrace: "Tiêu chuẩn đi muộn",
    minutes: "phút",
    lateHelp: "Nhân viên được tính là đi muộn sau số phút đã cài đặt kể từ giờ bắt đầu ca.",
    earlyLeaveGrace: "Tiêu chuẩn về sớm",
    earlyLeaveHelp: "Nhân viên được tính là về sớm khi chấm công ra sớm hơn giờ tan ca tiêu chuẩn quá số phút đã cài đặt.",
    missingCheckoutGrace: "Tiêu chuẩn thiếu chấm công ra",
    missingCheckoutHelp: "Nếu không có chấm công ra trong số phút đã cài đặt sau giờ tan ca tiêu chuẩn, hệ thống sẽ ghi nhận thiếu chấm công ra.",
    scheduleNotice: "Cài đặt áp dụng từ ngày đã chọn và không thay đổi dữ liệu cũ.",
    before: "Trước khi đổi",
    after: "Sau khi đổi",
    comparisonTitle: "📊 So sánh tiêu chuẩn chấm công",
    comparisonSummary: "📈 Tóm tắt so sánh",
    shadowDate: "Ngày kinh doanh",
    startDate: "Ngày kinh doanh bắt đầu",
    endDate: "Ngày kinh doanh kết thúc",
    completedNotice: "Mặc định là 7 ngày kinh doanh đã hoàn tất gần nhất, không gồm ngày đang diễn ra.",
    historyWarning: "Một số bản ghi cũ không thể xác định việc chuẩn hóa thủ công và có thể vẫn được tính vào kết quả.",
    manualExcluded: "Loại trừ chuẩn hóa đi muộn thủ công",
    leaveExcluded: "Loại trừ ngày nghỉ",
    excludedRows: "Bản ghi bị loại trừ",
    dateSummary: "Tóm tắt theo ngày",
    differenceFilter: "Loại chênh lệch",
    allDifferences: "Tất cả loại",
    employee: "Nhân viên",
    allEmployees: "Tất cả nhân viên",
    compare: "Chạy so sánh",
    comparing: "Đang so sánh…",
    legacy: "Tiêu chuẩn chấm công cũ",
    configured: "Tiêu chuẩn cài đặt mới",
    revision: "Phiên bản cài đặt",
    specialClose: "Đóng cửa sớm đặc biệt",
    defaultClose: "Áp dụng giờ tan ca dự kiến",
    storeClose: "Giờ đóng cửa dự kiến",
    total: "Tổng",
    matched: "Khớp",
    mismatched: "Không khớp",
    statusChanged: "Đổi trạng thái",
    lateChanged: "Đổi đi muộn",
    earlyChanged: "Đổi về sớm",
    unresolvedChanged: "Đổi chưa chấm ra",
    autoCloseChanged: "Đổi mốc kết thúc",
    noRows: "Không có bản ghi vào ca để so sánh.",
    status: "Trạng thái",
    late: "Đi muộn",
    early: "Về sớm",
    unresolved: "Chưa chấm ra",
    closeSource: "Căn cứ kết thúc",
    overrideSource: "Đóng sớm đặc biệt",
    configuredSource: "Giờ đóng cửa theo ngày",
    fallbackSource: "Áp dụng giờ tan ca dự kiến",
    fallbackSetting: "Áp dụng cài đặt mặc định",
    fallbackBadge: "Mặc định",
    cutoffShort: "Chốt",
    specialCloseShort: "Đóng sớm",
    statTotal: "Tổng",
    statMatched: "Khớp",
    statMismatched: "Lệch",
    statExcluded: "Loại",
    excludedBadge: "Loại khỏi so sánh",
    notComparedStatus: "Không tính chấm công",
    exclusionLeave: "Nghỉ phép",
    exclusionNoCheckIn: "Không có giờ vào",
    exclusionOther: "Không thuộc đối tượng so sánh",
    manualLateBadge: "Đã chuẩn hóa đi muộn",
    changeTypeLate: "Thay đổi đánh giá đi muộn",
    changeTypeEarly: "Thay đổi đánh giá về sớm",
    changeTypeUnresolved: "Thay đổi đánh giá thiếu chấm công ra",
    changeTypeStatus: "Thay đổi trạng thái",
    changeTypeMultiple: "Thay đổi nhiều tiêu chí",
    changedFieldsCount: "tiêu chí thay đổi",
    actualCheckIn: "Giờ vào thực tế",
    actualCheckOut: "Giờ ra thực tế",
    noCheckOutRecord: "Không có giờ ra",
    expectedCheckIn: "Giờ vào dự kiến",
    standardCheckout: "Giờ tan ca tiêu chuẩn",
    judgmentTime: "Thời điểm xác định",
    earlySuffix: "về sớm",
    lateSuffix: "đi muộn",
    legacyPrefix: "Trước đây",
    configuredPrefix: "Theo tiêu chuẩn mới",
    normalLabel: "Bình thường",
    showDetails: "Xem chi tiết",
    hideDetails: "Đóng chi tiết",
    statusLabels: {
      working: "Đang làm việc",
      done: "Hoàn tất bình thường",
      late: "Đi muộn",
      early_leave: "Về sớm",
      late_and_early_leave: "Đi muộn & về sớm",
      unresolved: "Chưa chấm công ra",
      leave: "Nghỉ phép",
    },
    confirmScheduleTitle: "Bạn có muốn lên lịch cài đặt chung không?",
    confirmScheduleBody1: "Từ ngày kinh doanh đã chọn, giờ hoạt động và tiêu chuẩn chấm công đang hiển thị sẽ được áp dụng cùng nhau.",
    confirmScheduleBody2: "Các giá trị không thay đổi cũng sẽ được lưu vào phiên bản cài đặt chung mới.",
    confirmHoursSection: "Giờ mở cửa",
    confirmAttendanceSection: "Tiêu chuẩn chấm công",
    modalCancel: "Hủy",
    modalConfirm: "Đặt lịch",
  },
} as const;

function requireFreshServerSession(response: Response) {
  if (response.status !== 401) return false;
  window.localStorage.removeItem("baba_user");
  window.alert(
    "보안을 위해 다시 로그인해주세요. / Vui lòng đăng nhập lại để bảo mật."
  );
  window.location.href = "/login";
  return true;
}

export default function StoreSettingsPage() {
  const { lang } = useLanguage();
  const t = copy[lang];
  const [tab, setTab] = useState<Tab>("hours");
  const [data, setData] = useState<ApiData | null>(null);
  const [hours, setHours] = useState<StoreBusinessHour[]>(
    DEFAULT_STORE_HOURS.map((item) => ({ ...item }))
  );
  const [cutoff, setCutoff] = useState("03:00");
  const [effective, setEffective] = useState("");
  const [lateGrace, setLateGrace] = useState(0);
  const [earlyLeaveGrace, setEarlyLeaveGrace] = useState(0);
  const [missingCheckoutGrace, setMissingCheckoutGrace] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<StoreSettingAuditLog[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/admin/store-settings", {
        cache: "no-store",
      });
      if (requireFreshServerSession(response)) return;
      const json = (await response.json()) as ApiData & {
        code?: string;
      };
      if (!response.ok) throw new Error(json.code || "failed");
      setData(json);
      const current = json.overview.current;
      setHours(
        (current?.hours?.length ? current.hours : DEFAULT_STORE_HOURS).map(
          (item) => ({ ...item })
        )
      );
      setCutoff(current?.businessDayCutoffTime || "03:00");
      setLateGrace(
        current?.attendancePolicy?.lateGraceMinutes ??
          DEFAULT_STORE_ATTENDANCE_POLICY.lateGraceMinutes
      );
      setEarlyLeaveGrace(
        current?.attendancePolicy?.earlyLeaveGraceMinutes ??
          DEFAULT_STORE_ATTENDANCE_POLICY.earlyLeaveGraceMinutes
      );
      setMissingCheckoutGrace(
        current?.attendancePolicy?.missingCheckoutGraceMinutes ??
          DEFAULT_STORE_ATTENDANCE_POLICY.missingCheckoutGraceMinutes
      );
      setEffective(addStoreDays(json.overview.businessDate, 1));
    } catch {
      setError(t.failed);
    }
  }, [t.failed]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateHour(
    weekday: number,
    patch: Partial<StoreBusinessHour>
  ) {
    setHours((items) =>
      items.map((item) =>
        item.weekday === weekday ? { ...item, ...patch } : item
      )
    );
  }

  function requestSave() {
    if (!data) return;
    if (
      !Number.isInteger(lateGrace) ||
      lateGrace < 0 ||
      lateGrace > 180 ||
      !Number.isInteger(earlyLeaveGrace) ||
      earlyLeaveGrace < 0 ||
      earlyLeaveGrace > 180 ||
      !Number.isInteger(missingCheckoutGrace) ||
      missingCheckoutGrace < 0 ||
      missingCheckoutGrace > 360 ||
      !effective
    ) {
      setError(t.invalid);
      return;
    }
    setError("");
    setConfirmOpen(true);
  }

  async function save() {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/store-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone: STORE_TIMEZONE,
          businessDayCutoffTime: cutoff,
          effectiveFromBusinessDate: effective,
          expectedRevision: data.overview.latestRevision,
          hours,
          attendancePolicy: {
            lateGraceMinutes: lateGrace,
            earlyLeaveGraceMinutes: earlyLeaveGrace,
            missingCheckoutGraceMinutes: missingCheckoutGrace,
            // 더 이상 Shadow 계산에서 쓰이지 않는 deprecated 필드. UI에 입력란은
            // 없지만, 기존 RPC 시그니처 호환을 위해 값을 계속 보내야 한다.
            // 사용자가 지각/조퇴/미퇴근만 바꿔도 이 값이 임의로 덮어써지지
            // 않도록 현재 적용 중인 값을 그대로 보존해서 전송한다.
            defaultNormalCheckoutTime:
              data.overview.current?.attendancePolicy
                ?.defaultNormalCheckoutTime ??
              DEFAULT_STORE_ATTENDANCE_POLICY.defaultNormalCheckoutTime,
          },
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.code || "failed");
      await load();
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "";
      setError(
        code === "VERSION_CONFLICT"
          ? t.conflict
          : code === "ATTENDANCE_SETTINGS_DB_PENDING"
            ? t.dbPending
          : ["INVALID_SETTINGS", "INVALID_EFFECTIVE_DATE"].includes(code)
            ? t.invalid
            : t.failed
      );
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  async function cancelScheduled() {
    if (
      !data?.overview.scheduled ||
      !window.confirm(t.confirmCancel)
    ) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/admin/store-settings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settingVersionId: data.overview.scheduled.id,
          expectedRevision: data.overview.latestRevision,
        }),
      });
      if (!response.ok) throw new Error();
      setLogs(null);
      await load();
    } catch {
      setError(t.failed);
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory() {
    if (logs) {
      setLogs(null);
      return;
    }
    try {
      const response = await fetch("/api/admin/store-settings/audit", {
        cache: "no-store",
      });
      const json = await response.json();
      if (!response.ok) throw new Error();
      setLogs(json.logs || []);
    } catch {
      setError(t.failed);
    }
  }

  if (!data && !error) {
    return (
      <Container>
        <p style={styles.status}>{t.loading}</p>
      </Container>
    );
  }

  return (
    <Container noPaddingTop>
      {error ? <p style={styles.error}>{error}</p> : null}
      {data?.overview.fallbackUsed ? (
        <p style={styles.warning}>{t.fallback}</p>
      ) : null}

      <nav style={styles.subNav} aria-label={t.title}>
        <div style={styles.subNavRow}>
          {(Object.keys(t.tabs) as Tab[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              style={{
                ...styles.subNavTab,
                ...(tab === value ? styles.subNavTabActive : null),
              }}
            >
              {t.tabs[value]}
            </button>
          ))}
        </div>
      </nav>

      {data && tab === "hours" ? (
        <HoursTab
          data={data}
          hours={hours}
          cutoff={cutoff}
          effective={effective}
          busy={busy}
          lang={lang}
          logs={logs}
          onCutoff={setCutoff}
          onEffective={setEffective}
          onHour={updateHour}
          onSave={requestSave}
          onCancel={cancelScheduled}
          onHistory={toggleHistory}
        />
      ) : null}

      {data && tab === "attendance" ? (
        <AttendanceTab
          data={data}
          lateGrace={lateGrace}
          earlyLeaveGrace={earlyLeaveGrace}
          missingCheckoutGrace={missingCheckoutGrace}
          effective={effective}
          busy={busy}
          lang={lang}
          onLateGrace={setLateGrace}
          onEarlyLeaveGrace={setEarlyLeaveGrace}
          onMissingCheckoutGrace={setMissingCheckoutGrace}
          onEffective={setEffective}
          onSave={requestSave}
        />
      ) : null}

      {data && tab === "shadow" ? (
        <ShadowTab
          businessDate={data.overview.businessDate}
          lang={lang}
        />
      ) : null}

      {confirmOpen ? (
        <ConfirmScheduleModal
          lang={lang}
          effective={effective}
          hours={hours}
          cutoff={cutoff}
          lateGrace={lateGrace}
          earlyLeaveGrace={earlyLeaveGrace}
          missingCheckoutGrace={missingCheckoutGrace}
          busy={busy}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={save}
        />
      ) : null}
    </Container>
  );
}

function HoursTab(props: {
  data: ApiData;
  hours: StoreBusinessHour[];
  cutoff: string;
  effective: string;
  busy: boolean;
  lang: "ko" | "vi";
  logs: StoreSettingAuditLog[] | null;
  onCutoff: (value: string) => void;
  onEffective: (value: string) => void;
  onHour: (weekday: number, patch: Partial<StoreBusinessHour>) => void;
  onSave: () => void;
  onCancel: () => void;
  onHistory: () => void;
}) {
  const t = copy[props.lang];

  return (
    <>
      {SHOW_POS_INTEGRATION_COMPARE ? <StorePosShadowGate /> : null}
      <SettingCard
        title={t.current}
        setting={props.data.overview.current}
        lang={props.lang}
      />
      <section style={styles.card}>
        <div style={{ ...styles.cardHeader, marginBottom: 10 }}>
          <h2 style={{ ...styles.sectionTitle, margin: 0, flex: 1, minWidth: 0 }}>
            {t.scheduled}
          </h2>
          {props.data.overview.scheduled &&
          props.data.capabilities.mutate ? (
            <button style={styles.danger} onClick={props.onCancel}>
              {t.cancel}
            </button>
          ) : null}
        </div>
        {props.data.overview.scheduled ? (
          <SettingBody
            setting={props.data.overview.scheduled}
            lang={props.lang}
          />
        ) : (
          <p style={styles.muted}>{t.empty}</p>
        )}
      </section>

      {props.data.capabilities.mutate &&
      !props.data.overview.scheduled ? (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>{t.newSetting}</h2>
          <div style={styles.metaGrid3}>
            <CompactField label={t.metaTimezone}>
              <input
                style={styles.compactInput}
                value={STORE_TIMEZONE}
                disabled
              />
            </CompactField>
            <CompactField label={t.metaCutoff}>
              <input
                type="time"
                style={styles.compactInput}
                value={props.cutoff}
                onChange={(event) => props.onCutoff(event.target.value)}
              />
            </CompactField>
            <CompactField label={t.metaEffective}>
              <input
                type="date"
                style={styles.compactInput}
                min={addStoreDays(calculateStoreBusinessDate(new Date()), 1)}
                value={props.effective}
                onChange={(event) => props.onEffective(event.target.value)}
              />
            </CompactField>
          </div>
          <h3 style={styles.subheading}>{t.businessHours}</h3>
          <div style={styles.days}>
            {props.hours.map((hour) => {
              const defaults = DEFAULT_STORE_HOURS[hour.weekday];
              return (
                <div key={hour.weekday} style={styles.day}>
                  <strong
                    style={{ ...styles.dayName, color: weekdayColor(hour.weekday) }}
                  >
                    {weekdayNames[props.lang][hour.weekday]}
                  </strong>
                  <input
                    aria-label={`${weekdayAriaNames[props.lang][hour.weekday]} ${t.businessHours}`}
                    type="time"
                    style={styles.timeInput}
                    value={hour.openTime || ""}
                    disabled={hour.isClosed}
                    onChange={(event) =>
                      props.onHour(hour.weekday, {
                        openTime: event.target.value,
                      })
                    }
                  />
                  <span style={styles.dayDash}>–</span>
                  <input
                    aria-label={`${weekdayAriaNames[props.lang][hour.weekday]} ${t.businessHours}`}
                    type="time"
                    style={styles.timeInput}
                    value={hour.closeTime || ""}
                    disabled={hour.isClosed}
                    onChange={(event) =>
                      props.onHour(hour.weekday, {
                        closeTime: event.target.value,
                      })
                    }
                  />
                  <label style={styles.openToggle}>
                    <input
                      type="checkbox"
                      checked={!hour.isClosed}
                      onChange={(event) =>
                        props.onHour(
                          hour.weekday,
                          event.target.checked
                            ? {
                                isClosed: false,
                                openTime:
                                  hour.openTime || defaults.openTime,
                                closeTime:
                                  hour.closeTime || defaults.closeTime,
                              }
                            : {
                                isClosed: true,
                                openTime: null,
                                closeTime: null,
                              }
                        )
                      }
                    />
                    <span style={styles.openToggleText}>{t.open}</span>
                  </label>
                </div>
              );
            })}
          </div>
          <button
            style={ui.button}
            disabled={props.busy}
            onClick={props.onSave}
          >
            {props.busy ? t.saving : t.save}
          </button>
        </section>
      ) : null}

      {props.data.capabilities.audit ? (
        <section style={styles.card}>
          <button style={styles.historyButton} onClick={props.onHistory}>
            {props.logs ? t.hideHistory : t.history}
          </button>
          {props.logs ? (
            <div style={styles.history}>
              {props.logs.map((log) => (
                <div key={log.id} style={styles.historyRow}>
                  <strong>
                    {log.action === "created" ? t.created : t.cancelled}
                  </strong>
                  <span>#{log.setting_version_id}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function AttendanceTab(props: {
  data: ApiData;
  lateGrace: number;
  earlyLeaveGrace: number;
  missingCheckoutGrace: number;
  effective: string;
  busy: boolean;
  lang: "ko" | "vi";
  onLateGrace: (value: number) => void;
  onEarlyLeaveGrace: (value: number) => void;
  onMissingCheckoutGrace: (value: number) => void;
  onEffective: (value: string) => void;
  onSave: () => void;
}) {
  const t = copy[props.lang];
  const current =
    props.data.overview.current?.attendancePolicy ??
    DEFAULT_STORE_ATTENDANCE_POLICY;

  return (
    <>
      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t.attendancePolicyTitle}</h2>
        <div style={styles.policyCards}>
          <div style={styles.policyCard}>
            <strong style={styles.policyCardLabel}>⏰ {t.lateGrace}</strong>
            <span style={styles.policyValue}>
              {current.lateGraceMinutes}{t.minutes}
            </span>
            <small style={styles.help}>{t.lateHelp}</small>
          </div>
          <div style={styles.policyCard}>
            <strong style={styles.policyCardLabel}>🚪 {t.earlyLeaveGrace}</strong>
            <span style={styles.policyValue}>
              {current.earlyLeaveGraceMinutes}{t.minutes}
            </span>
            <small style={styles.help}>{t.earlyLeaveHelp}</small>
          </div>
          <div style={styles.policyCard}>
            <strong style={styles.policyCardLabel}>❓ {t.missingCheckoutGrace}</strong>
            <span style={styles.policyValue}>
              {current.missingCheckoutGraceMinutes}{t.minutes}
            </span>
            <small style={styles.help}>{t.missingCheckoutHelp}</small>
          </div>
        </div>
      </section>

      <section style={styles.card}>
        <h2 style={{ ...styles.sectionTitle, marginBottom: 10 }}>{t.scheduled}</h2>
        {props.data.overview.scheduled ? (
          <AttendanceScheduledBody
            setting={props.data.overview.scheduled}
            lang={props.lang}
          />
        ) : (
          <p style={styles.muted}>{t.empty}</p>
        )}
      </section>

      {props.data.capabilities.mutate &&
      !props.data.overview.scheduled ? (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>{t.newAttendanceSetting}</h2>
          <div style={styles.changePreview}>
            <Metric
              label={`${t.before} · ${t.lateGrace}`}
              value={`${current.lateGraceMinutes}${t.minutes}`}
            />
            <Metric
              label={`${t.after} · ${t.lateGrace}`}
              value={`${props.lateGrace}${t.minutes}`}
            />
            <Metric
              label={`${t.before} · ${t.earlyLeaveGrace}`}
              value={`${current.earlyLeaveGraceMinutes}${t.minutes}`}
            />
            <Metric
              label={`${t.after} · ${t.earlyLeaveGrace}`}
              value={`${props.earlyLeaveGrace}${t.minutes}`}
            />
            <Metric
              label={`${t.before} · ${t.missingCheckoutGrace}`}
              value={`${current.missingCheckoutGraceMinutes}${t.minutes}`}
            />
            <Metric
              label={`${t.after} · ${t.missingCheckoutGrace}`}
              value={`${props.missingCheckoutGrace}${t.minutes}`}
            />
          </div>
          <div style={styles.grid}>
            <Field label={`⏰ ${t.lateGrace}`}>
              <div style={styles.inlineInput}>
                <GraceMinutesInput
                  value={props.lateGrace}
                  min={0}
                  max={180}
                  onChange={props.onLateGrace}
                />
                <span>{t.minutes}</span>
              </div>
            </Field>
            <Field label={`🚪 ${t.earlyLeaveGrace}`}>
              <div style={styles.inlineInput}>
                <GraceMinutesInput
                  value={props.earlyLeaveGrace}
                  min={0}
                  max={180}
                  onChange={props.onEarlyLeaveGrace}
                />
                <span>{t.minutes}</span>
              </div>
            </Field>
            <Field label={`❓ ${t.missingCheckoutGrace}`}>
              <div style={styles.inlineInput}>
                <GraceMinutesInput
                  value={props.missingCheckoutGrace}
                  min={0}
                  max={360}
                  onChange={props.onMissingCheckoutGrace}
                />
                <span>{t.minutes}</span>
              </div>
            </Field>
            <Field label={t.effective}>
              <input
                type="date"
                style={styles.input}
                min={addStoreDays(calculateStoreBusinessDate(new Date()), 1)}
                value={props.effective}
                onChange={(event) => props.onEffective(event.target.value)}
              />
            </Field>
          </div>
          <p style={styles.help}>{t.scheduleNotice}</p>
          <button
            style={ui.button}
            disabled={props.busy}
            onClick={props.onSave}
          >
            {props.busy ? t.saving : t.saveAttendance}
          </button>
        </section>
      ) : null}
    </>
  );
}

function ConfirmScheduleModal(props: {
  lang: "ko" | "vi";
  effective: string;
  hours: StoreBusinessHour[];
  cutoff: string;
  lateGrace: number;
  earlyLeaveGrace: number;
  missingCheckoutGrace: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = copy[props.lang];
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(props.busy);
  busyRef.current = props.busy;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) props.onCancel();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    confirmButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hourGroups = groupStoreHours(props.hours);
  const weekdayLabel = (weekday: number) => weekdayNames[props.lang][weekday];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.confirmScheduleTitle}
      onClick={props.busy ? undefined : props.onCancel}
      style={styles.modalOverlay}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={styles.modalBox}
      >
        <h2 style={styles.modalTitle}>{t.confirmScheduleTitle}</h2>
        <p style={styles.modalBody}>{t.confirmScheduleBody1}</p>
        <p style={styles.modalBody}>{t.confirmScheduleBody2}</p>

        <div style={styles.modalHoursRow}>
          <span>{t.effective}</span>
          <strong>{props.effective}</strong>
        </div>

        <h3 style={styles.modalSectionTitle}>{t.confirmHoursSection}</h3>
        <div style={styles.modalHoursList}>
          {hourGroups.map((group) => (
            <div key={group.weekdays.join("-")} style={styles.modalHoursRow}>
              <span>
                {group.weekdays.length > 1
                  ? `${weekdayLabel(group.weekdays[0])}~${weekdayLabel(group.weekdays[group.weekdays.length - 1])}`
                  : weekdayLabel(group.weekdays[0])}
              </span>
              <span>
                {group.isClosed
                  ? t.closed
                  : `${group.openTime}~${group.closeTime}`}
              </span>
            </div>
          ))}
          <div style={styles.modalHoursRow}>
            <span>{t.cutoff}</span>
            <span>{props.cutoff}</span>
          </div>
        </div>

        <h3 style={styles.modalSectionTitle}>{t.confirmAttendanceSection}</h3>
        <div style={styles.modalHoursList}>
          <div style={styles.modalHoursRow}>
            <span>{t.lateGrace}</span>
            <span>{props.lateGrace}{t.minutes}</span>
          </div>
          <div style={styles.modalHoursRow}>
            <span>{t.earlyLeaveGrace}</span>
            <span>{props.earlyLeaveGrace}{t.minutes}</span>
          </div>
          <div style={styles.modalHoursRow}>
            <span>{t.missingCheckoutGrace}</span>
            <span>{props.missingCheckoutGrace}{t.minutes}</span>
          </div>
        </div>

        <div style={styles.modalActions}>
          <button
            type="button"
            style={{ ...ui.subButton, width: "auto", flex: 1 }}
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {t.modalCancel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            style={{ ...ui.button, width: "auto", flex: 1 }}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? t.saving : t.modalConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShadowTab(props: {
  businessDate: string;
  lang: "ko" | "vi";
}) {
  const t = copy[props.lang];
  const initialRange = useMemo(
    () => getCompletedBusinessDateRange(props.businessDate),
    [props.businessDate]
  );
  const [startDate, setStartDate] = useState(initialRange.startBusinessDate);
  const [endDate, setEndDate] = useState(initialRange.endBusinessDate);
  const [userId, setUserId] = useState("");
  const [differenceFilter, setDifferenceFilter] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [result, setResult] = useState<ShadowData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/attendance/users", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => setUsers(json.users || []))
      .catch(() => setUsers([]));
  }, []);

  async function runComparison() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        "/api/admin/store-settings/attendance-shadow",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startBusinessDate: startDate,
            endBusinessDate: endDate,
            userId: userId || undefined,
          }),
        }
      );
      if (requireFreshServerSession(response)) return;
      const json = await response.json();
      if (!response.ok) throw new Error(json.code || "failed");
      setResult(json);
    } catch {
      setError(t.failed);
    } finally {
      setBusy(false);
    }
  }

  const summaryItems = useMemo(() => {
    if (!result) return [];
    return [
      [t.total, result.summary.total],
      [t.matched, result.summary.matched],
      [t.mismatched, result.summary.mismatched],
      [t.statusChanged, result.summary.statusChanged],
      [t.lateChanged, result.summary.lateChanged],
      [t.earlyChanged, result.summary.earlyLeaveChanged],
      [t.unresolvedChanged, result.summary.unresolvedChanged],
      [t.manualExcluded, result.summary.manualLateExcluded],
      [t.leaveExcluded, result.summary.leaveExcluded],
    ] as const;
  }, [result, t]);

  return (
    <>
      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t.comparisonTitle}</h2>
        <p style={styles.help}>{t.completedNotice}</p>
        <div style={styles.grid}>
          <Field label={t.startDate}>
            <input
              type="date"
              max={endDate}
              value={startDate}
              style={styles.input}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </Field>
          <Field label={t.endDate}>
            <input
              type="date"
              max={initialRange.endBusinessDate}
              value={endDate}
              style={styles.input}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </Field>
          <Field label={t.employee}>
            <select
              value={userId}
              style={styles.input}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">{t.allEmployees}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name || user.username}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button
          style={ui.button}
          disabled={busy || !startDate || !endDate}
          onClick={runComparison}
        >
          {busy ? t.comparing : t.compare}
        </button>
        {error ? <p style={styles.error}>{error}</p> : null}
      </section>

      {result ? (
        <>
          <section style={styles.card}>
            <h2 style={styles.sectionTitle}>{t.comparisonSummary}</h2>
            {result.historicalManualOverrideWarning ? (
              <p style={styles.warning}>{t.historyWarning}</p>
            ) : null}
            <div style={styles.policyBanner}>
              <strong>{result.startBusinessDate} ~ {result.endBusinessDate}</strong>
              <span>{result.businessDayCount} {props.lang === "ko" ? "영업일" : "ngày"}</span>
            </div>
            <div style={styles.summaryGrid}>
              {summaryItems.map(([label, value]) => (
                <Metric key={label} label={label} value={String(value)} />
              ))}
            </div>
          </section>

          <section style={styles.card}>
            <h2 style={styles.sectionTitle}>📅 {t.dateSummary}</h2>
            <div style={styles.dateSummaryList}>
              {result.dateSummaries.map((day) => (
                <article key={day.businessDate} style={styles.dateCard}>
                  <div style={styles.dateCardHeader}>
                    <strong style={styles.dateCardDate}>{day.businessDate}</strong>
                    <span style={styles.dateCardBadge}>
                      {day.fallbackUsed
                        ? t.fallbackBadge
                        : `#${day.settingsRevision}`}
                    </span>
                  </div>
                  <small style={styles.dateCardHours}>
                    {day.storeOpenTime || "-"}–{day.storeCloseTime || "-"}
                    {" · "}
                    {t.cutoffShort} {day.businessDayCutoffTime}
                    {day.hasBusinessOverride ? ` · ${t.specialCloseShort}` : ""}
                  </small>
                  <small style={styles.dateCardHours}>
                    {t.late} {day.attendancePolicy.lateGraceMinutes}{t.minutes}
                    {" · "}
                    {t.early} {day.attendancePolicy.earlyLeaveGraceMinutes}{t.minutes}
                    {" · "}
                    {t.unresolved} {day.attendancePolicy.missingCheckoutGraceMinutes}{t.minutes}
                  </small>
                  <div style={styles.dateStatGrid}>
                    <div style={styles.dateStat}>
                      <small style={styles.dateStatLabel}>{t.statTotal}</small>
                      <strong style={styles.dateStatValue}>{day.totalRecords}</strong>
                    </div>
                    <div style={styles.dateStat}>
                      <small style={styles.dateStatLabel}>{t.statMatched}</small>
                      <strong style={styles.dateStatValue}>{day.matched}</strong>
                    </div>
                    <div style={styles.dateStat}>
                      <small style={styles.dateStatLabel}>{t.statMismatched}</small>
                      <strong style={styles.dateStatValue}>{day.mismatched}</strong>
                    </div>
                    <div style={styles.dateStat}>
                      <small style={styles.dateStatLabel}>{t.statExcluded}</small>
                      <strong style={styles.dateStatValue}>{day.excluded}</strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section style={styles.card}>
            <div style={styles.filterRow}>
              <h2 style={styles.filterLabel}>
                <span aria-hidden="true">⚠️</span>
                <span>{t.mismatched}</span>
              </h2>
              <select
                aria-label={t.differenceFilter}
                value={differenceFilter}
                style={styles.input}
                onChange={(event) => setDifferenceFilter(event.target.value)}
              >
                <option value="">{t.allDifferences}</option>
                {Object.keys(result.differenceTypeCounts).map((type) => (
                  <option key={type} value={type}>
                    {differenceLabel(props.lang, type)}
                  </option>
                ))}
              </select>
            </div>
            {result.rows.filter((row) =>
              row.comparisonStatus === "compared" &&
              Object.values(row.differences).some(Boolean) &&
              (!differenceFilter || row.differenceTypes.includes(differenceFilter))
            ).length === 0 ? (
              <p style={styles.muted}>{t.noRows}</p>
            ) : (
              <div style={styles.shadowList}>
                {result.rows
                  .filter((row) =>
                    row.comparisonStatus === "compared" &&
                    Object.values(row.differences).some(Boolean) &&
                    (!differenceFilter || row.differenceTypes.includes(differenceFilter))
                  )
                  .map((row) => (
                    <ShadowRow key={row.recordId} row={row} lang={props.lang} />
                  ))}
              </div>
            )}
          </section>

          <section style={styles.card}>
            <button
              style={ui.subButton}
              onClick={() => setShowExcluded((value) => !value)}
            >
              {t.excludedRows} ({result.rows.filter((row) =>
                row.comparisonStatus === "excluded" ||
                row.metricComparison.late.comparisonStatus === "excluded"
              ).length})
            </button>
            {showExcluded ? (
              <div style={{ ...styles.shadowList, marginTop: 12 }}>
                {result.rows
                  .filter((row) =>
                    row.comparisonStatus === "excluded" ||
                    row.metricComparison.late.comparisonStatus === "excluded"
                  )
                  .map((row) => (
                    <ShadowRow key={row.recordId} row={row} lang={props.lang} />
                  ))}
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}

function ShadowRow(props: {
  row: AttendanceShadowComparison;
  lang: "ko" | "vi";
}) {
  const t = copy[props.lang];
  const [showDetails, setShowDetails] = useState(false);

  if (props.row.comparisonStatus === "excluded") {
    return (
      <article style={styles.excludedRow}>
        <div style={styles.cardHeader}>
          <div>
            <strong>{props.row.userName}</strong>
            <small style={styles.rowMeta}>{props.row.businessDate}</small>
          </div>
          <span style={styles.excludedBadge}>{t.excludedBadge}</span>
        </div>
        <p style={styles.excludedMeta}>
          {exclusionReasonLabel(props.lang, props.row.exclusionReason)}
        </p>
        <p style={styles.excludedMeta}>{t.notComparedStatus}</p>
      </article>
    );
  }

  const sourceText = {
    override: `${t.specialClose} ${hhmm(props.row.configured.effectiveStoreCloseAt)} ${props.lang === "ko" ? "적용" : "áp dụng"}`,
    configured: `${t.storeClose} ${hhmm(props.row.configured.effectiveStoreCloseAt)}`,
    fallback: `${t.defaultClose} ${hhmm(props.row.configured.normalCheckoutThresholdAt)}`,
  }[props.row.configured.closeSource];
  const changed = Object.values(props.row.differences).some(Boolean);
  const lateExcluded =
    props.row.metricComparison.late.comparisonStatus === "excluded";
  const legacyLabel = displayStatusLabel(props.lang, props.row.legacy);
  const configuredLabel = displayStatusLabel(props.lang, props.row.configured);
  const primary = props.row.summary.primaryDifference;
  const binaryLabel = (isFlagged: boolean, flaggedLabel: string) =>
    isFlagged ? flaggedLabel : t.normalLabel;

  return (
    <article
      style={{
        ...styles.shadowRow,
        borderColor: changed ? "#f59e0b" : "#bbf7d0",
      }}
    >
      <div style={styles.cardHeader}>
        <div style={styles.shadowRowIdentity}>
          <strong style={styles.shadowRowName}>{props.row.userName}</strong>
          <small style={styles.rowMeta}>{props.row.businessDate}</small>
        </div>
        <span style={changed ? styles.changedBadge : styles.matchBadge}>
          {changed ? changeTypeBadgeLabel(props.lang, primary) : t.matched}
        </span>
      </div>

      {changed ? (
        <div style={styles.shadowRowSummary}>
          {primary === "late" ? (
            <>
              <p style={styles.summaryLine}>
                {t.actualCheckIn} {hhmm(props.row.checkInAt)}
              </p>
              <p style={styles.summaryLineMuted}>
                {t.expectedCheckIn} {hhmm(props.row.configured.scheduledStartAt)}
                {" · "}
                {props.row.configured.lateMinutes}{t.minutes} {t.lateSuffix}
              </p>
            </>
          ) : null}
          {primary === "early_leave" ? (
            <>
              <p style={styles.summaryLine}>
                {t.actualCheckOut} {hhmm(props.row.checkOutAt)}
              </p>
              <p style={styles.summaryLineMuted}>
                {t.standardCheckout} {hhmm(props.row.configured.normalCheckoutThresholdAt)}
                {" · "}
                {props.row.configured.earlyLeaveMinutes}{t.minutes} {t.earlySuffix}
              </p>
            </>
          ) : null}
          {primary === "unresolved" ? (
            <>
              <p style={styles.summaryLine}>{t.noCheckOutRecord}</p>
              <p style={styles.summaryLineMuted}>
                {t.standardCheckout} {hhmm(props.row.configured.normalCheckoutThresholdAt)}
                {" · "}
                {t.judgmentTime} {hhmm(props.row.configured.unresolvedAt)}
              </p>
            </>
          ) : null}
          {primary === "multiple" ? (
            <>
              <p style={styles.summaryLine}>
                {props.row.summary.changedFieldCount} {t.changedFieldsCount}
              </p>
              <ul style={styles.summaryBulletList}>
                {props.row.differences.lateMinutes ? (
                  <li>
                    {t.late}:{" "}
                    {binaryLabel(props.row.legacy.lateMinutes > 0, t.late)}
                    {" → "}
                    {binaryLabel(props.row.configured.lateMinutes > 0, t.late)}
                  </li>
                ) : null}
                {props.row.differences.earlyLeaveMinutes ? (
                  <li>
                    {t.early}:{" "}
                    {binaryLabel(props.row.legacy.earlyLeaveMinutes > 0, t.early)}
                    {" → "}
                    {binaryLabel(props.row.configured.earlyLeaveMinutes > 0, t.early)}
                  </li>
                ) : null}
                {props.row.differences.unresolved || props.row.differences.unresolvedAt ? (
                  <li>
                    {t.unresolved}:{" "}
                    {binaryLabel(props.row.legacy.unresolved, t.unresolved)}
                    {" → "}
                    {binaryLabel(props.row.configured.unresolved, t.unresolved)}
                  </li>
                ) : null}
                {props.row.differences.status ? (
                  <li>
                    {t.status}: {legacyLabel} → {configuredLabel}
                  </li>
                ) : null}
              </ul>
            </>
          ) : null}
          {primary !== "multiple" ? (
            <p style={styles.summaryTransition}>
              {t.legacyPrefix} {legacyLabel} → {t.configuredPrefix} {configuredLabel}
            </p>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        style={styles.detailsToggle}
        onClick={() => setShowDetails((value) => !value)}
      >
        {showDetails ? t.hideDetails : t.showDetails}
      </button>

      {showDetails ? (
        <div style={styles.comparisonGrid}>
          <div>
            <b>{t.legacy}</b>
            <p>{t.status}: {props.row.legacy.status}</p>
            <p>{t.late}: {props.row.legacy.lateMinutes}</p>
            <p>{t.early}: {props.row.legacy.earlyLeaveMinutes}</p>
            <p>{t.unresolved}: {String(props.row.legacy.unresolved)}</p>
          </div>
          <div>
            <b>{t.configured}</b>
            <p>
              {t.status}: {props.row.configured.status}
            </p>
            <p>
              {t.late}: {props.row.configured.lateMinutes}
              {lateExcluded ? (
                <span style={styles.neutralBadge}>{t.manualLateBadge}</span>
              ) : null}
            </p>
            <p>{t.early}: {props.row.configured.earlyLeaveMinutes}</p>
            <p>{t.unresolved}: {String(props.row.configured.unresolved)}</p>
            <p>{t.closeSource}: {sourceText}</p>
            <p>
              {t.revision}:{" "}
              {props.row.configured.settingsRevision === null
                ? t.fallbackSetting
                : `#${props.row.configured.settingsRevision}`}
            </p>
            {props.row.differenceTypes.length ? (
              <p>
                {props.row.differenceTypes
                  .map((type) => differenceLabel(props.lang, type))
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function SettingCard(props: {
  title: string;
  setting: StoreSetting | null;
  lang: "ko" | "vi";
}) {
  return (
    <section style={styles.card}>
      <h2 style={styles.sectionTitle}>{props.title}</h2>
      {props.setting ? (
        <SettingBody setting={props.setting} lang={props.lang} />
      ) : (
        <p style={styles.muted}>-</p>
      )}
    </section>
  );
}

function SettingBody(props: {
  setting: StoreSetting;
  lang: "ko" | "vi";
}) {
  const t = copy[props.lang];
  return (
    <div>
      <div style={styles.metaGrid3}>
        <CompactMetric label={t.metaTimezone} value={props.setting.timezone} />
        <CompactMetric
          label={t.metaCutoff}
          value={props.setting.businessDayCutoffTime}
        />
        <CompactMetric
          label={t.metaEffective}
          value={shortDate(props.setting.effectiveFromBusinessDate)}
        />
      </div>
      <h3 style={styles.subheading}>{t.businessHours}</h3>
      <div style={styles.hourList}>
        {props.setting.hours.map((hour) => (
          <span key={hour.weekday} style={styles.hourItem}>
            <b style={{ color: weekdayColor(hour.weekday) }}>
              {weekdayNames[props.lang][hour.weekday]}
            </b>
            <span>
              {hour.isClosed
                ? t.closed
                : `${hour.openTime}–${hour.closeTime}`}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// 근태설정 탭의 "예약 설정" 카드 — 운영시간 탭의 SettingBody와 같은 레이아웃·
// 폰트 규격을 쓰되, 요일별 운영시간 대신 근태 기준 3개를 보여준다. revision
// 번호 같은 세부 정보는 굳이 드러내지 않고 "예약된 값"만 직관적으로 보여준다.
function AttendanceScheduledBody(props: {
  setting: StoreSetting;
  lang: "ko" | "vi";
}) {
  const t = copy[props.lang];
  const policy = props.setting.attendancePolicy;
  return (
    <div style={styles.grid}>
      <Metric
        label={t.metaEffective}
        value={shortDate(props.setting.effectiveFromBusinessDate)}
      />
      <Metric
        label={`⏰ ${t.lateGrace}`}
        value={`${policy.lateGraceMinutes}${t.minutes}`}
      />
      <Metric
        label={`🚪 ${t.earlyLeaveGrace}`}
        value={`${policy.earlyLeaveGraceMinutes}${t.minutes}`}
      />
      <Metric
        label={`❓ ${t.missingCheckoutGrace}`}
        value={`${policy.missingCheckoutGraceMinutes}${t.minutes}`}
      />
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.label}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <span style={styles.metric}>
      <small style={styles.metricLabel}>{props.label}</small>
      <strong style={styles.metricValue}>{props.value}</strong>
    </span>
  );
}

// 좁은 모바일 폭에서도 시간대/마감/적용일 3칸이 줄바꿈 없이 한 줄에 들어가도록
// Field/Metric보다 폰트·패딩을 줄인 전용 변형. 다른 곳에서 쓰는 Field/Metric은
// 그대로 두고 이 두 곳(현재 운영시간 카드, 운영시간 변경 입력 카드)에만 쓴다.
function CompactMetric(props: { label: string; value: string }) {
  return (
    <span style={styles.compactMetric}>
      <small style={styles.compactMetricLabel}>{props.label}</small>
      <strong style={styles.compactMetricValue}>{props.value}</strong>
    </span>
  );
}

function CompactField(props: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.compactLabel}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

// 근태설정 숫자 input: 값이 정확히 0일 때만 포커스 시 비우고, blur 시 여전히
// 비어 있으면 0으로 되돌린다. 실제 숫자 state(payload/validation에 쓰이는 값)는
// 항상 그대로 유지되고 표시(value)만 바뀌므로 저장 로직에는 영향이 없다.
function GraceMinutesInput(props: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      type="number"
      min={props.min}
      max={props.max}
      step={1}
      required
      style={styles.input}
      value={focused && props.value === 0 ? "" : props.value}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event) => {
        const raw = event.target.value;
        props.onChange(raw === "" ? 0 : Number(raw));
      }}
    />
  );
}

const styles: Record<string, CSSProperties> = {
  metaGrid3: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 6,
    marginBottom: 12,
  },
  compactMetric: {
    display: "grid",
    gap: 2,
    padding: "8px 6px",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    background: "#f8fafc",
    minWidth: 0,
  },
  compactMetricLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    color: "#6b7280",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  compactMetricValue: {
    fontSize: 12.5,
    fontWeight: 800,
    color: "#111827",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  compactLabel: {
    display: "grid",
    gap: 3,
    fontSize: 10.5,
    fontWeight: 800,
    minWidth: 0,
  },
  compactInput: {
    ...ui.input,
    minWidth: 0,
    height: 34,
    padding: "6px 6px",
    fontSize: 12.5,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1300,
    padding: 16,
    background: "rgba(15, 23, 42, 0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modalBox: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "88vh",
    overflowY: "auto",
    padding: 20,
    borderRadius: 16,
    background: "#ffffff",
    boxShadow: "0 24px 60px rgba(0, 0, 0, 0.3)",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 800,
    margin: "0 0 10px",
  },
  modalBody: {
    margin: "0 0 8px",
    color: "#4b5563",
    fontSize: 13,
    lineHeight: 1.55,
  },
  modalSectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    margin: "16px 0 6px",
    color: "#374151",
  },
  modalHoursList: {
    display: "grid",
    gap: 6,
    padding: 10,
    borderRadius: 10,
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
  },
  modalHoursRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    fontSize: 13,
  },
  modalActions: {
    display: "flex",
    gap: 10,
    marginTop: 18,
  },
  filterRow: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "center",
    gap: 12,
  },
  filterLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontSize: 16,
    fontWeight: 800,
    margin: 0,
    minWidth: 0,
  },
  subNav: {
    borderBottom: "1px solid #e5e7eb",
    marginBottom: 12,
  },
  subNavRow: {
    display: "flex",
    justifyContent: "space-around",
  },
  subNavTab: {
    flex: 1,
    minWidth: 0,
    textAlign: "center",
    padding: "12px 0 10px",
    fontSize: 14,
    fontWeight: 600,
    color: "#9ca3af",
    background: "transparent",
    border: 0,
    borderBottom: "3px solid transparent",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  subNavTabActive: {
    fontWeight: 800,
    color: "#111827",
    borderBottom: "3px solid #111827",
  },
  card: {
    background: "#fff",
    border: "1px solid #d8dce3",
    borderRadius: 14,
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
    padding: 14,
    marginBottom: 12,
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  sectionTitle: { fontSize: 16, fontWeight: 800, margin: "0 0 8px" },
  subheading: {
    borderTop: "1px solid #e5e7eb",
    paddingTop: 12,
    margin: "12px 0 6px",
    fontSize: 13,
    fontWeight: 700,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 10,
    marginBottom: 12,
  },
  label: { display: "grid", gap: 5, fontSize: 12, fontWeight: 800 },
  input: { ...ui.input, minWidth: 0, height: 40, padding: "8px 10px" },
  inlineInput: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: 8,
  },
  days: {
    display: "grid",
    gap: 1,
    marginBottom: 12,
    background: "#e5e7eb",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    overflow: "hidden",
  },
  day: {
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr) 12px minmax(0, 1fr) minmax(64px, auto)",
    alignItems: "center",
    justifyItems: "center",
    gap: 6,
    padding: "8px 6px",
    background: "#fff",
    minHeight: 44,
  },
  dayName: {
    fontSize: 12,
    textAlign: "center",
  },
  dayDash: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#9ca3af",
    fontSize: 12,
  },
  timeInput: {
    ...ui.input,
    width: "100%",
    minWidth: 0,
    padding: 6,
    fontSize: 12,
    textAlign: "center",
  },
  openToggle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: "100%",
    fontSize: 11,
  },
  openToggleText: {
    whiteSpace: "nowrap",
  },
  hourList: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    gap: 5,
  },
  hourItem: {
    display: "grid",
    gap: 3,
    padding: "7px 3px",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    textAlign: "center",
    fontSize: 11,
  },
  policyCards: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
  },
  policyCard: {
    display: "grid",
    gap: 6,
    padding: 12,
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#f8fafc",
  },
  policyCardLabel: {
    fontSize: 13,
    fontWeight: 700,
    color: "#374151",
  },
  policyValue: {
    color: "#111827",
    fontSize: 16,
    fontWeight: 800,
  },
  changePreview: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
    gap: 6,
    marginBottom: 12,
  },
  metric: {
    display: "grid",
    gap: 4,
    padding: 10,
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#f8fafc",
    minWidth: 0,
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "#6b7280",
  },
  metricValue: {
    fontSize: 14,
    fontWeight: 700,
    color: "#111827",
  },
  help: {
    margin: "6px 0 12px",
    color: "#64748b",
    fontSize: 12,
    lineHeight: 1.5,
  },
  policyBanner: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "space-between",
    marginBottom: 12,
    fontSize: 12,
  },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
    gap: 6,
  },
  shadowList: { display: "grid", gap: 9 },
  shadowRow: {
    padding: "10px 12px",
    border: "1px solid",
    borderRadius: 12,
  },
  shadowRowIdentity: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
  },
  shadowRowName: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%",
  },
  shadowRowSummary: {
    marginTop: 8,
  },
  summaryLine: {
    margin: "0 0 2px",
    fontSize: 13,
    fontWeight: 700,
    color: "#111827",
  },
  summaryLineMuted: {
    margin: "0 0 2px",
    fontSize: 12,
    color: "#64748b",
  },
  summaryTransition: {
    margin: "6px 0 0",
    fontSize: 12,
    fontWeight: 700,
    color: "#92400e",
  },
  summaryBulletList: {
    margin: "4px 0 0",
    padding: "0 0 0 16px",
    fontSize: 12,
    color: "#374151",
    lineHeight: 1.6,
  },
  detailsToggle: {
    marginTop: 10,
    minHeight: 36,
    padding: "8px 4px",
    border: 0,
    background: "transparent",
    color: "#2563eb",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
    textAlign: "left",
  },
  dateSummaryList: { display: "grid", gap: 8 },
  dateCard: {
    display: "grid",
    gap: 6,
    padding: "10px 12px",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#fff",
  },
  dateCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  dateCardDate: {
    fontSize: 14,
    fontWeight: 800,
    color: "#111827",
  },
  dateCardBadge: {
    flexShrink: 0,
    padding: "2px 7px",
    borderRadius: 999,
    background: "#f1f5f9",
    color: "#475569",
    fontSize: 10,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  dateCardHours: {
    display: "block",
    color: "#64748b",
    fontSize: 11,
    lineHeight: 1.4,
  },
  dateStatGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 4,
    marginTop: 2,
  },
  dateStat: {
    display: "grid",
    justifyItems: "center",
    gap: 2,
    padding: "6px 2px",
    borderRadius: 8,
    background: "#f8fafc",
  },
  dateStatLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: "#94a3b8",
    whiteSpace: "nowrap",
  },
  dateStatValue: {
    fontSize: 14,
    fontWeight: 800,
    color: "#111827",
    lineHeight: 1,
  },
  excludedRow: {
    padding: 12,
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    background: "#f8fafc",
  },
  excludedBadge: {
    color: "#475569",
    background: "#e2e8f0",
    borderRadius: 999,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 700,
  },
  excludedMeta: {
    margin: "4px 0 0",
    color: "#64748b",
    fontSize: 12,
  },
  neutralBadge: {
    display: "inline-block",
    marginLeft: 6,
    padding: "1px 6px",
    borderRadius: 999,
    background: "#e2e8f0",
    color: "#475569",
    fontSize: 10,
    fontWeight: 700,
  },
  rowMeta: {
    display: "block",
    marginTop: 3,
    color: "#64748b",
    fontSize: 11,
  },
  comparisonGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
    marginTop: 9,
    fontSize: 12,
  },
  changedBadge: {
    color: "#92400e",
    background: "#fef3c7",
    borderRadius: 999,
    padding: "4px 8px",
    fontSize: 11,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  matchBadge: {
    color: "#166534",
    background: "#dcfce7",
    borderRadius: 999,
    padding: "4px 8px",
    fontSize: 11,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  danger: {
    border: "1px solid #dc2626",
    background: "#dc2626",
    color: "#ffffff",
    borderRadius: 10,
    padding: "8px 14px",
    minHeight: 36,
    fontSize: 13,
    fontWeight: 700,
    whiteSpace: "nowrap",
    flexShrink: 0,
    cursor: "pointer",
  },
  historyButton: {
    border: 0,
    background: "transparent",
    padding: 0,
    fontSize: 13,
    fontWeight: 800,
    cursor: "pointer",
  },
  history: { display: "grid", gap: 7, marginTop: 12 },
  historyRow: {
    display: "flex",
    justifyContent: "space-between",
    borderTop: "1px solid #eee",
    paddingTop: 7,
    fontSize: 12,
  },
  warning: {
    padding: 10,
    borderRadius: 10,
    background: "#fffbeb",
    color: "#92400e",
    fontSize: 12,
  },
  error: {
    padding: 10,
    borderRadius: 10,
    background: "#fef2f2",
    color: "#b91c1c",
    fontSize: 12,
  },
  muted: { color: "#64748b", fontSize: 13 },
  status: { padding: 24, textAlign: "center", color: "#64748b" },
};
