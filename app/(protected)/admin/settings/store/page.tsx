"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { getVietnamDateParts } from "@/lib/common/business-time";
import {
  addStoreDays,
  calculateStoreBusinessDate,
} from "@/lib/store-settings/business-time";
import { groupStoreHours } from "@/lib/store-settings/hours-summary";
import {
  DEFAULT_STORE_ATTENDANCE_POLICY,
  DEFAULT_STORE_HOURS,
  STORE_TIMEZONE,
  type StoreBusinessHour,
  type StoreSetting,
  type StoreSettingAuditLog,
  type StoreSettingsOverview,
} from "@/lib/store-settings/types";
import { ui } from "@/lib/styles/ui";
import {
  FIXED_HOLIDAY_DEFINITIONS,
  getHolidayGroupLabel,
} from "@/lib/store-settings/holidays-data";
import { countHolidayGroupSizes, isBabaPremiumHoliday } from "@/lib/store-settings/holidays-policy";
import {
  getVietnamHolidayChoices,
  type NationalDayOption,
  type TetOption,
} from "@/lib/store-settings/vietnam-holiday-calendar";

type Tab = "hours" | "attendance" | "holidays";
type ApiData = {
  overview: StoreSettingsOverview;
  capabilities: {
    mutate: boolean;
    audit: boolean;
  };
};
type StoreHoliday = {
  id: number;
  holidayDate: string;
  holidayCode: string;
  nameKo: string;
  nameVi: string;
  holidayGroup: string;
  isPaidHoliday: boolean;
  isEmployerSelected: boolean;
  /** BABA 내부 운영 지침 배율(매장 영업 + 200% 적용) — 법정 지급률이 아니다. null이면 미적용. */
  internalPayMultiplier: number | null;
};
type StoreHolidayCalendar = {
  year: number;
  countryCode: string;
};
type HolidaysApiData = {
  year: number;
  calendar: StoreHolidayCalendar | null;
  holidays: StoreHoliday[];
  capabilities: { mutate: boolean };
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

// "YYYY-MM-DD" 영업일 date-key는 이미 캘린더 날짜 문자열이라 시간대 변환이
// 필요 없다 — 앞 두 자리 연도만 잘라 좁은 카드에서 밀도를 줄인다.
function shortDate(dateKey: string) {
  return dateKey.length === 10 ? dateKey.slice(2) : dateKey;
}

const copy = {
  ko: {
    title: "매장 통합설정",
    intro: "운영시간과 근태 판정 기준을 같은 설정 버전으로 관리합니다.",
    tabs: { hours: "운영시간", attendance: "근태설정", holidays: "공휴일" },
    current: "🏪 현재 매장 운영시간",
    attendancePolicyTitle: "⏰ 현재 근태 기준",
    policyDescription: "기준 설명",
    policyDescriptionClose: "기준 설명 닫기",
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
    metaRevision: "변경번호",
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
    lateHelp: "예정 출근시간 + 설정값 이후 출근",
    earlyLeaveGrace: "조퇴 기준",
    earlyLeaveHelp: "기준 퇴근시간보다 설정값 이상 일찍 퇴근하면 조퇴",
    missingCheckoutGrace: "미퇴근 기준",
    missingCheckoutHelp: "기준 퇴근시간 + 설정값까지 퇴근 기록 없음",
    scheduleNotice: "예약 설정은 선택한 영업일부터 적용되며 기존 기록은 변경하지 않습니다.",
    before: "변경 전",
    after: "변경 후",
    confirmScheduleTitle: "통합설정을 예약할까요?",
    confirmScheduleBody1: "선택한 영업일부터 현재 입력된 운영시간과 근태 기준이 함께 적용됩니다.",
    confirmScheduleBody2: "변경하지 않은 값도 현재 화면에 표시된 값으로 새 통합설정 버전에 포함됩니다.",
    confirmHoursSection: "운영시간",
    confirmAttendanceSection: "근태 기준",
    modalCancel: "취소",
    modalConfirm: "예약하기",

    holidaysTitle: "법정공휴일",
    holidaysEmpty: "등록된 공휴일이 없습니다.",
    holidaysFailed: "공휴일 정보를 불러오지 못했습니다.",
    holidaysYearPrefix: "",
    holidaysYearSuffix: "년",
    operationPolicyTitle: "BABA 200% 적용일",
    operationPolicyDescription: "선택한 날짜는 매장 영업 및 내부 200% 적용일로 관리됩니다.",
    operationPolicySaving: "저장 중…",
    dayCountSuffix: "일",

    notPreparedPrefix: "아직 ",
    notPreparedSuffix: "년 공휴일이 준비되지 않았습니다.",
    prepareButtonPrefix: "",
    prepareButtonSuffix: "년 공휴일 준비",
    reminderPrefix: "⚠️ ",
    reminderSuffix: "년 공휴일 설정이 아직 없습니다.",
    prepareModalTitle: "공휴일 준비",
    hungKingsLabel: "흥왕기념일",
    tetStartLabel: "음력설 5일 선택",
    tetPreviewLabel: "설 전 {before}일 + 설날 및 이후 {after}일",
    nationalDayAdjacentLabel: "국경일 2일 선택",
    nationalDayOptionBefore: "09/01 + 09/02",
    nationalDayOptionAfter: "09/02 + 09/03",
    calculatedNotice: "음력 날짜를 베트남 표준시 기준으로 자동 계산한 사전 설정입니다. 추후 정부 공식 발표와 비교해 확인하세요.",
    prepareSubmit: "준비 완료",
    prepareSaving: "저장 중…",
    prepareCancel: "취소",
    prepareYearExists: "이미 해당 연도 공휴일이 준비되어 있습니다.",
    prepareInvalid: "입력값을 다시 확인해주세요.",
    prepareFailed: "공휴일 준비를 처리하지 못했습니다.",
  },
  vi: {
    title: "Cài đặt tích hợp cửa hàng",
    intro:
      "Quản lý giờ hoạt động và quy tắc chấm công trong cùng một phiên bản.",
    tabs: {
      hours: "Giờ mở cửa",
      attendance: "Chấm công",
      holidays: "Ngày lễ",
    },
    current: "🏪 Giờ hoạt động hiện tại",
    attendancePolicyTitle: "⏰ Tiêu chuẩn chấm công hiện tại",
    policyDescription: "Giải thích tiêu chuẩn",
    policyDescriptionClose: "Đóng phần giải thích",
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
    metaRevision: "Lần thay đổi",
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
    lateHelp: "Chấm công vào sau giờ vào dự kiến + giá trị cài đặt",
    earlyLeaveGrace: "Tiêu chuẩn về sớm",
    earlyLeaveHelp: "Về sớm ít nhất bằng số phút cài đặt so với giờ tan ca chuẩn",
    missingCheckoutGrace: "Tiêu chuẩn thiếu chấm công ra",
    missingCheckoutHelp: "Không có chấm công ra đến giờ tan ca chuẩn + giá trị cài đặt",
    scheduleNotice: "Cài đặt áp dụng từ ngày đã chọn và không thay đổi dữ liệu cũ.",
    before: "Trước khi đổi",
    after: "Sau khi đổi",
    confirmScheduleTitle: "Bạn có muốn lên lịch cài đặt chung không?",
    confirmScheduleBody1: "Từ ngày kinh doanh đã chọn, giờ hoạt động và tiêu chuẩn chấm công đang hiển thị sẽ được áp dụng cùng nhau.",
    confirmScheduleBody2: "Các giá trị không thay đổi cũng sẽ được lưu vào phiên bản cài đặt chung mới.",
    confirmHoursSection: "Giờ mở cửa",
    confirmAttendanceSection: "Tiêu chuẩn chấm công",
    modalCancel: "Hủy",
    modalConfirm: "Đặt lịch",

    holidaysTitle: "Ngày lễ hợp pháp",
    holidaysEmpty: "Chưa có ngày lễ nào.",
    holidaysFailed: "Không thể tải thông tin ngày lễ.",
    holidaysYearPrefix: "Năm ",
    holidaysYearSuffix: "",
    operationPolicyTitle: "Ngày áp dụng 200% nội bộ BABA",
    operationPolicyDescription:
      "Ngày đã chọn được quản lý là ngày cửa hàng hoạt động và áp dụng mức 200% theo quy định nội bộ.",
    operationPolicySaving: "Đang lưu…",
    dayCountSuffix: "ngày",

    notPreparedPrefix: "Chưa chuẩn bị ngày lễ năm ",
    notPreparedSuffix: ".",
    prepareButtonPrefix: "Chuẩn bị ngày lễ năm ",
    prepareButtonSuffix: "",
    reminderPrefix: "⚠️ Chưa có cài đặt ngày lễ năm ",
    reminderSuffix: ".",
    prepareModalTitle: "Chuẩn bị ngày lễ",
    hungKingsLabel: "Giỗ Tổ Hùng Vương",
    tetStartLabel: "Chọn 5 ngày nghỉ Tết",
    tetPreviewLabel: "{before} ngày trước Tết + ngày Tết và {after} ngày sau",
    nationalDayAdjacentLabel: "Chọn 2 ngày Quốc khánh",
    nationalDayOptionBefore: "01/09 + 02/09",
    nationalDayOptionAfter: "02/09 + 03/09",
    calculatedNotice: "Đây là lịch dự kiến được tự động tính theo giờ Việt Nam. Vui lòng đối chiếu với thông báo chính thức của Chính phủ sau này.",
    prepareSubmit: "Hoàn tất chuẩn bị",
    prepareSaving: "Đang lưu…",
    prepareCancel: "Hủy",
    prepareYearExists: "Năm này đã được chuẩn bị.",
    prepareInvalid: "Vui lòng kiểm tra lại dữ liệu.",
    prepareFailed: "Không thể xử lý việc chuẩn bị ngày lễ.",
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

      {tab === "holidays" ? <HolidaysTab lang={lang} /> : null}

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
  const currentSetting = props.data.overview.current;
  const [showPolicyDescription, setShowPolicyDescription] = useState(false);
  const policyDescriptionId = useId();

  return (
    <>
      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t.attendancePolicyTitle}</h2>
        <div style={styles.policyMetaGrid}>
          <CompactMetric label={t.metaEffective} value={currentSetting ? shortDate(currentSetting.effectiveFromBusinessDate) : "-"} />
          <CompactMetric label={t.metaRevision} value={currentSetting ? String(currentSetting.revision) : "-"} />
        </div>
        <div style={styles.metaGrid3}>
          <CompactMetric label={t.lateGrace} value={`${current.lateGraceMinutes}${t.minutes}`} />
          <CompactMetric label={t.earlyLeaveGrace} value={`${current.earlyLeaveGraceMinutes}${t.minutes}`} />
          <CompactMetric label={t.missingCheckoutGrace} value={`${current.missingCheckoutGraceMinutes}${t.minutes}`} />
        </div>
        <button type="button" style={styles.compactDisclosure} aria-expanded={showPolicyDescription} aria-controls={policyDescriptionId} onClick={() => setShowPolicyDescription((value) => !value)}>
          {showPolicyDescription ? t.policyDescriptionClose : t.policyDescription}
          <span aria-hidden="true">{showPolicyDescription ? "▴" : "▾"}</span>
        </button>
        {showPolicyDescription ? (
          <div id={policyDescriptionId} style={styles.policyDescription}>
            <p style={styles.policyDescriptionLine}><strong>{t.lateGrace}:</strong> {t.lateHelp}</p>
            <p style={styles.policyDescriptionLine}><strong>{t.earlyLeaveGrace}:</strong> {t.earlyLeaveHelp}</p>
            <p style={styles.policyDescriptionLine}><strong>{t.missingCheckoutGrace}:</strong> {t.missingCheckoutHelp}</p>
          </div>
        ) : null}
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
          <div style={styles.metaGrid3}>
            <CompactField label={t.lateGrace}>
              <div style={styles.inlineInput}>
                <GraceMinutesInput
                  value={props.lateGrace}
                  min={0}
                  max={180}
                  onChange={props.onLateGrace}
                />
                <span>{t.minutes}</span>
              </div>
            </CompactField>
            <CompactField label={t.earlyLeaveGrace}>
              <div style={styles.inlineInput}>
                <GraceMinutesInput
                  value={props.earlyLeaveGrace}
                  min={0}
                  max={180}
                  onChange={props.onEarlyLeaveGrace}
                />
                <span>{t.minutes}</span>
              </div>
            </CompactField>
            <CompactField label={t.missingCheckoutGrace}>
              <div style={styles.inlineInput}>
                <GraceMinutesInput
                  value={props.missingCheckoutGrace}
                  min={0}
                  max={360}
                  onChange={props.onMissingCheckoutGrace}
                />
                <span>{t.minutes}</span>
              </div>
            </CompactField>
          </div>
          <div style={styles.effectiveField}>
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

// "YYYY-MM-DD" → "MM/DD". 공휴일 목록/Tet 옵션 라벨 전용 — shortDate(연도만 자르는
// 용도)와는 다른 포맷이라 별도로 둔다.
function monthDay(dateKey: string) {
  return dateKey.length === 10 ? dateKey.slice(5) : dateKey;
}

// 공휴일은 store_setting_versions와 완전히 독립된 원본(store_holiday_calendars/
// store_holidays)이라, 이 탭은 페이지 상단의 data/load()와 별도로 자체 fetch를
// 관리한다 — 다른 탭의 로딩 실패가 이 탭에 영향을 주지 않고, 반대도 마찬가지다.
function HolidaysTab(props: { lang: "ko" | "vi" }) {
  const t = copy[props.lang];
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [data, setData] = useState<HolidaysApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyHolidayId, setBusyHolidayId] = useState<number | null>(null);
  const [prepareOpen, setPrepareOpen] = useState<number | null>(null);
  // 11월 이후에만 확인하는 "다음 연도 준비 안내" — 지금 보고 있는 연도(year)와는
  // 독립적이다(관리자가 2026년을 보고 있어도 2027년 데이터가 없으면 안내가 뜬다).
  const [reminderYear, setReminderYear] = useState<number | null>(null);

  const load = useCallback(
    async (targetYear: number) => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/admin/store-settings/holidays?year=${targetYear}`,
          { cache: "no-store" }
        );
        if (requireFreshServerSession(response)) return;
        const json = (await response.json()) as HolidaysApiData & { ok: boolean; code?: string };
        if (!response.ok || !json.ok) throw new Error(json.code || "failed");
        setData(json);
      } catch {
        setError(t.holidaysFailed);
      } finally {
        setLoading(false);
      }
    },
    [t.holidaysFailed]
  );

  useEffect(() => {
    void load(year);
  }, [year, load]);

  // 11월 1일 이후이고 다음 연도 calendar가 아직 없으면 안내를 띄운다. 실패해도
  // 조용히 무시한다 — 이 안내는 비핵심 기능이라 탭 전체를 막지 않는다. cron 없이
  // 탭을 열 때마다 확인한다.
  //
  // BABA 공식 시간대(Asia/Ho_Chi_Minh) 기준 달력 날짜로 판정한다 — new Date()의
  // 브라우저 로컬 시간을 직접 쓰면 사용자가 다른 시간대에서 접속했을 때 11월
  // 경계가 어긋난다. getVietnamDateParts는 영업일 03:00 cutoff를 적용하지 않는
  // 순수 베트남 현지 달력 날짜라 이 용도에 맞는다(cutoff가 적용되는
  // calculateStoreBusinessDate/getBusinessDate는 여기서 쓰지 않는다).
  useEffect(() => {
    const storeToday = getVietnamDateParts();
    if (storeToday.month < 11) return;
    const nextRealYear = storeToday.year + 1;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/admin/store-settings/holidays?year=${nextRealYear}`,
          { cache: "no-store" }
        );
        if (!response.ok) return;
        const json = await response.json();
        if (!cancelled && json.ok) {
          setReminderYear(json.calendar ? null : nextRealYear);
        }
      } catch {
        // no-op
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 날짜 1개씩 즉시 저장한다(BABA 200% 적용 토글) — store_holidays 원본은
  // 서버(store_toggle_holiday_operation_policy_v1)에서도 절대 지우지 않는다.
  async function toggleHoliday(holiday: StoreHoliday) {
    if (busyHolidayId !== null || !data?.capabilities.mutate) return;
    setBusyHolidayId(holiday.id);
    setError("");
    try {
      const response = await fetch("/api/admin/store-settings/holidays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holidayId: holiday.id,
          selected: holiday.internalPayMultiplier === null,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.code || "failed");
      await load(year);
    } catch {
      setError(t.holidaysFailed);
    } finally {
      setBusyHolidayId(null);
    }
  }

  function handlePrepareSuccess(preparedYear: number) {
    setPrepareOpen(null);
    if (preparedYear === year) void load(year);
    if (preparedYear === reminderYear) setReminderYear(null);
  }

  const holidays = data?.holidays ?? [];
  // 200% 적용 여부(effective)는 holidays-policy.ts의 공통 함수로만 판정한다 —
  // 근태 API(loadHolidaysForMonth)와 다른 기준으로 재구현하지 않는다.
  const groupSizes = countHolidayGroupSizes(holidays);
  // 같은 holiday_group이 2일 이상인 것만 개별 선택 UI를 만든다(1일짜리는 상단
  // 목록에만 표시되고 자동 200%다 — 선택/해제 대상이 아니다). holiday_group 순서는
  // store_holidays.id insert 순서를 그대로 따르므로 날짜순 정렬만 다시 맞춘다.
  const selectableGroups: Array<{ group: string; label: string; items: StoreHoliday[] }> = [];
  {
    const byGroup = new Map<string, StoreHoliday[]>();
    for (const holiday of holidays) {
      const list = byGroup.get(holiday.holidayGroup) ?? [];
      list.push(holiday);
      byGroup.set(holiday.holidayGroup, list);
    }
    for (const [group, items] of byGroup) {
      if (items.length < 2) continue;
      const sorted = [...items].sort((a, b) => a.holidayDate.localeCompare(b.holidayDate));
      const fallbackName = props.lang === "vi" ? sorted[0].nameVi : sorted[0].nameKo;
      selectableGroups.push({
        group,
        label: getHolidayGroupLabel(group, props.lang, fallbackName),
        items: sorted,
      });
    }
  }

  return (
    <>
      {reminderYear !== null ? (
        <section style={{ ...styles.card, ...styles.reminderCard }}>
          <p style={styles.reminderText}>
            {t.reminderPrefix}
            {reminderYear}
            {t.reminderSuffix}
          </p>
          {data?.capabilities.mutate ? (
            <button type="button" style={ui.button} onClick={() => setPrepareOpen(reminderYear)}>
              {t.prepareButtonPrefix}
              {reminderYear}
              {t.prepareButtonSuffix}
            </button>
          ) : null}
        </section>
      ) : null}

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <button
            type="button"
            style={styles.yearNavButton}
            onClick={() => setYear((value) => value - 1)}
          >
            ‹
          </button>
          <h2 style={{ ...styles.sectionTitle, margin: 0, textAlign: "center", flex: 1 }}>
            {t.holidaysYearPrefix}
            {year}
            {t.holidaysYearSuffix} {t.holidaysTitle}
          </h2>
          <button
            type="button"
            style={styles.yearNavButton}
            onClick={() => setYear((value) => value + 1)}
          >
            ›
          </button>
        </div>

        {error ? <p style={styles.error}>{error}</p> : null}

        {loading ? (
          <p style={styles.muted}>{t.loading}</p>
        ) : !data?.calendar ? (
          <div style={styles.holidayEmptyState}>
            <div aria-hidden="true" style={styles.holidayEmptyIcon}>🗓️</div>
            <p style={{ ...styles.muted, margin: 0 }}>
              {t.notPreparedPrefix}
              {year}
              {t.notPreparedSuffix}
            </p>
            {data?.capabilities.mutate ? (
              <button type="button" style={ui.button} onClick={() => setPrepareOpen(year)}>
                {t.prepareButtonPrefix}
                {year}
                {t.prepareButtonSuffix}
              </button>
            ) : null}
          </div>
        ) : holidays.length === 0 ? (
          <p style={styles.muted}>{t.holidaysEmpty}</p>
        ) : (
          <ul style={styles.holidayList}>
            {holidays.map((holiday) => {
              const effective = isBabaPremiumHoliday(
                holiday,
                groupSizes.get(holiday.holidayGroup) ?? 0
              );
              return (
                <li key={holiday.id} style={styles.holidayItem}>
                  <span style={styles.holidayDate}>{monthDay(holiday.holidayDate)}</span>
                  <span style={effective ? styles.holidayNameActive : undefined}>
                    {props.lang === "vi" ? holiday.nameVi : holiday.nameKo}
                    {effective ? " (200%)" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selectableGroups.length > 0 ? (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>{t.operationPolicyTitle}</h2>
          <p style={styles.help}>{t.operationPolicyDescription}</p>
          {selectableGroups.map((groupEntry) => (
            <div key={groupEntry.group} style={styles.holidayGroupBlock}>
              <h3 style={styles.subheading}>
                {groupEntry.label} · {groupEntry.items.length}{t.dayCountSuffix}
              </h3>
              <div style={styles.holidayToggleGrid}>
                {groupEntry.items.map((holiday) => {
                  const active = isBabaPremiumHoliday(holiday, groupEntry.items.length);
                  const isBusy = busyHolidayId === holiday.id;
                  const disabled = busyHolidayId !== null || !data?.capabilities.mutate;
                  return (
                    <button
                      key={holiday.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleHoliday(holiday)}
                      style={{
                        ...styles.holidayToggleButton,
                        ...(active ? styles.holidayToggleButtonActive : null),
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled && !isBusy ? 0.6 : 1,
                      }}
                    >
                      {isBusy ? t.operationPolicySaving : monthDay(holiday.holidayDate)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {prepareOpen !== null ? (
        <PrepareHolidayYearModal
          lang={props.lang}
          year={prepareOpen}
          onCancel={() => setPrepareOpen(null)}
          onSuccess={handlePrepareSuccess}
        />
      ) : null}
    </>
  );
}

// 연도만으로 고정일/음력일을 계산하고, 법적으로 가능한 Tet/국경일 구성만 선택한다.
// 같은 순수 helper를 API에서도 다시 실행하므로 클라이언트 계산값은 저장에 신뢰하지 않는다.
function PrepareHolidayYearModal(props: {
  lang: "ko" | "vi";
  year: number;
  onCancel: () => void;
  onSuccess: (year: number) => void;
}) {
  const t = copy[props.lang];
  const choices = getVietnamHolidayChoices(props.year);
  const automaticHolidays = [
    ...FIXED_HOLIDAY_DEFINITIONS.map((definition) => ({
      code: definition.code,
      date: `${props.year}-${definition.monthDay}`,
      name: props.lang === "vi" ? definition.nameVi : definition.nameKo,
    })),
    { code: "HUNG_KINGS", date: choices.hungKingsDate, name: t.hungKingsLabel },
  ].sort((left, right) => left.date.localeCompare(right.date));
  const [tetOption, setTetOption] = useState<TetOption | "">("");
  const [nationalDayOption, setNationalDayOption] = useState<NationalDayOption | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = tetOption !== "" && nationalDayOption !== "" && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/admin/store-settings/holidays/prepare-year", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: props.year,
          tetOption,
          nationalDayOption,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        const code = json.code as string | undefined;
        setError(
          code === "YEAR_ALREADY_EXISTS"
            ? t.prepareYearExists
            : code === "FORBIDDEN"
              ? t.holidaysFailed
              : t.prepareInvalid
        );
        return;
      }
      props.onSuccess(props.year);
    } catch {
      setError(t.prepareFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.prepareModalTitle}
      onClick={submitting ? undefined : props.onCancel}
      style={styles.modalOverlay}
    >
      <div onClick={(event) => event.stopPropagation()} style={styles.modalBox}>
        <h2 style={styles.modalTitle}>
          {t.prepareModalTitle} · {props.year}
        </h2>
        <p style={styles.notice}>{t.calculatedNotice}</p>

        {error ? <p style={styles.error}>{error}</p> : null}

        <h3 style={styles.modalSectionTitle}>{t.holidaysTitle}</h3>
        <ul style={styles.holidayList}>
          {automaticHolidays.map((holiday) => (
            <li key={holiday.code} style={styles.holidayItem}>
              <span style={styles.holidayDate}>{monthDay(holiday.date).replace("-", "/")}</span>
              <span>{holiday.name}</span>
            </li>
          ))}
        </ul>

        <div style={styles.effectiveField}>
          <h3 style={styles.modalSectionTitle}>{t.tetStartLabel}</h3>
          <div style={styles.holidayChoiceGrid}>
            {choices.tetOptions.map((option, index) => (
              <button key={option.id} type="button" onClick={() => setTetOption(option.id)}
                style={{ ...styles.holidayChoiceButton, ...(tetOption === option.id ? styles.holidayToggleButtonActive : null) }}>
                <span style={styles.holidayChoiceSummary}>
                  <strong style={styles.holidayChoiceTitle}>{index + 1}{props.lang === "ko" ? "안" : ""}</strong>
                  <span style={styles.holidayChoiceDate}>{monthDay(option.dates[0]).replace("-", "/")} ~ {monthDay(option.dates[4]).replace("-", "/")}</span>
                </span>
                <small style={styles.holidayChoiceDescription}>{t.tetPreviewLabel.replace("{before}", String(option.daysBefore)).replace("{after}", String(4 - option.daysBefore))}</small>
              </button>
            ))}
          </div>
        </div>

        <h3 style={styles.modalSectionTitle}>{t.nationalDayAdjacentLabel}</h3>
        <div style={styles.holidayToggleGrid}>
          <button
            type="button"
            style={{
              ...styles.holidayToggleButton,
              ...(nationalDayOption === "before" ? styles.holidayToggleButtonActive : null),
            }}
            onClick={() => setNationalDayOption("before")}
          >
            {t.nationalDayOptionBefore}
          </button>
          <button
            type="button"
            style={{
              ...styles.holidayToggleButton,
              ...(nationalDayOption === "after" ? styles.holidayToggleButtonActive : null),
            }}
            onClick={() => setNationalDayOption("after")}
          >
            {t.nationalDayOptionAfter}
          </button>
        </div>

        <div style={styles.modalActions}>
          <button
            type="button"
            style={{ ...ui.subButton, width: "auto", flex: 1 }}
            disabled={submitting}
            onClick={props.onCancel}
          >
            {t.prepareCancel}
          </button>
          <button
            type="button"
            style={{ ...ui.button, width: "auto", flex: 1 }}
            disabled={!canSubmit}
            onClick={submit}
          >
            {submitting ? t.prepareSaving : t.prepareSubmit}
          </button>
        </div>
      </div>
    </div>
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
      <div style={styles.currentMetaGrid}>
        <CompactMetric label={t.metaTimezone} value={props.setting.timezone} />
        <CompactMetric label={t.metaRevision} value={String(props.setting.revision)} />
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

function AttendanceScheduledBody(props: {
  setting: StoreSetting;
  lang: "ko" | "vi";
}) {
  const t = copy[props.lang];
  const policy = props.setting.attendancePolicy;
  return (
    <div>
      <div style={styles.policyMetaGrid}>
        <CompactMetric label={t.metaEffective} value={shortDate(props.setting.effectiveFromBusinessDate)} />
        <CompactMetric label={t.metaRevision} value={String(props.setting.revision)} />
      </div>
      <div style={styles.metaGrid3}>
        <CompactMetric label={t.lateGrace} value={`${policy.lateGraceMinutes}${t.minutes}`} />
        <CompactMetric label={t.earlyLeaveGrace} value={`${policy.earlyLeaveGraceMinutes}${t.minutes}`} />
        <CompactMetric label={t.missingCheckoutGrace} value={`${policy.missingCheckoutGraceMinutes}${t.minutes}`} />
      </div>
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

// 좁은 모바일 폭에서도 시간대/마감/적용일 3칸이 줄바꿈 없이 한 줄에 들어가도록
// Field보다 폰트·패딩을 줄인 전용 변형. 다른 곳에서 쓰는 Field는 그대로 두고
// 이 두 곳(현재 운영시간 카드, 운영시간 변경 입력 카드)에만 쓴다.
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
  currentMetaGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 6,
    marginBottom: 12,
  },
  policyMetaGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 6,
    marginBottom: 6,
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
  compactDisclosure: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 2px 0",
    border: 0,
    background: "transparent",
    color: "#475569",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  policyDescription: {
    marginTop: 6,
    padding: "4px 2px 0",
    color: "#64748b",
    fontSize: 11.5,
    lineHeight: 1.4,
  },
  policyDescriptionLine: { margin: "0 0 3px" },
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
  effectiveField: { marginBottom: 12 },
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
  help: {
    margin: "6px 0 12px",
    color: "#64748b",
    fontSize: 12,
    lineHeight: 1.5,
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
  yearNavButton: {
    border: "1px solid #e5e7eb",
    background: "#fff",
    borderRadius: 8,
    width: 32,
    height: 32,
    fontSize: 16,
    fontWeight: 800,
    color: "#374151",
    cursor: "pointer",
    flexShrink: 0,
  },
  holidayList: {
    display: "grid",
    gap: 1,
    margin: 0,
    padding: 0,
    listStyle: "none",
    background: "#e5e7eb",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    overflow: "hidden",
  },
  holidayItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 10px",
    background: "#fff",
    fontSize: 13,
  },
  holidayDate: {
    minWidth: 44,
    fontWeight: 800,
    color: "#b91c1c",
  },
  holidayNameActive: {
    fontWeight: 800,
  },
  reminderCard: {
    background: "#fffbeb",
    border: "1px solid #fde68a",
  },
  reminderText: {
    margin: "0 0 10px",
    color: "#92400e",
    fontSize: 13,
    fontWeight: 700,
  },
  holidayGroupBlock: {
    marginTop: 10,
  },
  holidayToggleGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(56px, 1fr))",
    gap: 6,
  },
  holidayToggleButton: {
    border: "1px solid #e5e7eb",
    background: "#fff",
    borderRadius: 10,
    padding: "10px 4px",
    fontSize: 12.5,
    fontWeight: 700,
    color: "#374151",
    textAlign: "center",
  },
  holidayToggleButtonActive: {
    border: "1px solid #111827",
    background: "#111827",
    color: "#fff",
  },
  holidayEmptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 14,
    padding: "28px 12px 12px",
    textAlign: "center",
  },
  holidayEmptyIcon: { fontSize: 30, lineHeight: 1 },
  holidayChoiceGrid: { display: "grid", gap: 5 },
  holidayChoiceButton: {
    display: "grid",
    gap: 2,
    border: "1px solid #e5e7eb",
    background: "#fff",
    borderRadius: 10,
    minHeight: 48,
    padding: "7px 10px",
    color: "#374151",
    textAlign: "left",
    cursor: "pointer",
    lineHeight: 1.2,
  },
  holidayChoiceSummary: { display: "flex", alignItems: "baseline", gap: 8 },
  holidayChoiceTitle: { minWidth: 22, fontSize: 12.5, lineHeight: 1.15 },
  holidayChoiceDate: { fontSize: 12, fontWeight: 700, lineHeight: 1.15 },
  holidayChoiceDescription: { fontSize: 10.5, lineHeight: 1.2 },
};
