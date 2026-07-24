"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import Container from "@/components/Container";
import { StorePosShadowGate } from "@/components/StorePosShadowPanel";
import { useLanguage } from "@/lib/language-context";
import {
  addStoreDays,
  calculateStoreBusinessDate,
} from "@/lib/store-settings/business-time";
import {
  DEFAULT_STORE_ATTENDANCE_POLICY,
  DEFAULT_STORE_HOURS,
  STORE_TIMEZONE,
  type StoreBusinessHour,
  type StoreSetting,
  type StoreSettingAuditLog,
  type StoreSettingsOverview,
} from "@/lib/store-settings/types";
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

const copy = {
  ko: {
    title: "매장 통합설정",
    intro: "운영시간과 근태 판정 기준을 같은 설정 버전으로 관리합니다.",
    tabs: { hours: "🏪 운영시간", attendance: "⏱️ 근태설정", shadow: "📊 근태비교" },
    current: "🏪 현재 매장 운영시간",
    scheduled: "📅 예약 설정",
    newSetting: "🗓️ 설정 예약",
    timezone: "시간대",
    cutoff: "영업일 마감",
    businessHours: "요일별 운영시간",
    effective: "적용 시작일",
    open: "영업",
    closed: "휴무",
    save: "통합설정 예약",
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
    lateGrace: "지각 유예시간",
    minutes: "분",
    normalCheckout: "기본 정상퇴근 인정시간",
    attendanceHelp:
      "특별 조기마감이 없는 영업일의 조퇴 판정에 사용합니다. 실제 매장 종료시간과는 별도입니다.",
    lateHelp: "0분이면 예정 출근시간을 넘는 즉시 지각 처리됩니다.",
    overrideHelp: "특별 조기마감이 등록된 날에는 특별 조기마감 시간이 우선됩니다.",
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
    defaultClose: "기본 정상퇴근 인정",
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
    fallbackSource: "기본 인정시간",
    fallbackSetting: "기본 설정 적용",
    noSavedSetting: "저장된 통합설정 없음",
  },
  vi: {
    title: "Cài đặt tích hợp cửa hàng",
    intro:
      "Quản lý giờ hoạt động và quy tắc chấm công trong cùng một phiên bản.",
    tabs: {
      hours: "🏪 Giờ hoạt động",
      attendance: "⏱️ Cài đặt chấm công",
      shadow: "📊 So sánh chấm công",
    },
    current: "🏪 Giờ hoạt động hiện tại",
    scheduled: "📅 Cài đặt đã lên lịch",
    newSetting: "🗓️ Lên lịch cài đặt",
    timezone: "Múi giờ",
    cutoff: "Giờ chốt ngày kinh doanh",
    businessHours: "Giờ hoạt động theo ngày",
    effective: "Ngày bắt đầu áp dụng",
    open: "Mở cửa",
    closed: "Nghỉ",
    save: "Lưu lịch cài đặt",
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
    lateGrace: "Thời gian cho phép đi muộn",
    minutes: "phút",
    normalCheckout: "Giờ tan ca được công nhận mặc định",
    attendanceHelp:
      "Dùng để xét về sớm khi không có giờ đóng cửa sớm đặc biệt; không phải giờ đóng cửa thực tế.",
    lateHelp:
      "Nếu là 0 phút, hệ thống sẽ ghi nhận đi muộn ngay khi quá giờ vào ca.",
    overrideHelp:
      "Nếu có giờ đóng cửa sớm đặc biệt, thời gian đó sẽ được ưu tiên.",
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
    defaultClose: "Giờ tan ca mặc định",
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
    fallbackSource: "Giờ mặc định",
    fallbackSetting: "Áp dụng cài đặt mặc định",
    noSavedSetting: "Không có cài đặt tích hợp đã lưu",
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
  const [normalCheckout, setNormalCheckout] = useState("00:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<StoreSettingAuditLog[] | null>(null);

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
      setNormalCheckout(
        current?.attendancePolicy?.defaultNormalCheckoutTime ??
          DEFAULT_STORE_ATTENDANCE_POLICY.defaultNormalCheckoutTime
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

  async function save() {
    if (!data) return;
    if (
      !Number.isInteger(lateGrace) ||
      lateGrace < 0 ||
      lateGrace > 180 ||
      !normalCheckout ||
      !effective
    ) {
      setError(t.invalid);
      return;
    }
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
            defaultNormalCheckoutTime: normalCheckout,
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

      <nav style={styles.tabs} aria-label={t.title}>
        {(Object.keys(t.tabs) as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            style={{
              ...styles.tab,
              ...(tab === value ? styles.activeTab : null),
            }}
          >
            {t.tabs[value]}
          </button>
        ))}
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
          onSave={save}
          onCancel={cancelScheduled}
          onHistory={toggleHistory}
        />
      ) : null}

      {data && tab === "attendance" ? (
        <AttendanceTab
          data={data}
          lateGrace={lateGrace}
          normalCheckout={normalCheckout}
          effective={effective}
          busy={busy}
          lang={lang}
          onLateGrace={setLateGrace}
          onNormalCheckout={setNormalCheckout}
          onEffective={setEffective}
          onSave={save}
        />
      ) : null}

      {data && tab === "shadow" ? (
        <ShadowTab
          businessDate={data.overview.businessDate}
          lang={lang}
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
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>{t.scheduled}</h2>
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
          <div style={styles.grid}>
            <Field label={t.timezone}>
              <input
                style={styles.input}
                value={STORE_TIMEZONE}
                disabled
              />
            </Field>
            <Field label={t.cutoff}>
              <input
                type="time"
                style={styles.input}
                value={props.cutoff}
                onChange={(event) => props.onCutoff(event.target.value)}
              />
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
          <h3 style={styles.subheading}>{t.businessHours}</h3>
          <div style={styles.days}>
            {props.hours.map((hour) => {
              const defaults = DEFAULT_STORE_HOURS[hour.weekday];
              return (
                <div key={hour.weekday} style={styles.day}>
                  <strong style={{ color: weekdayColor(hour.weekday) }}>
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
                  <span>–</span>
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
                    {t.open}
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
  normalCheckout: string;
  effective: string;
  busy: boolean;
  lang: "ko" | "vi";
  onLateGrace: (value: number) => void;
  onNormalCheckout: (value: string) => void;
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
        <h2 style={styles.sectionTitle}>⚙️ {t.current}</h2>
        <div style={styles.policyCards}>
          <div style={styles.policyCard}>
            <strong>⏰ {t.lateGrace}</strong>
            <span style={styles.policyValue}>
              {current.lateGraceMinutes}{t.minutes}
            </span>
            <small style={styles.help}>{t.lateHelp}</small>
          </div>
          <div style={styles.policyCard}>
            <strong>🌙 {t.normalCheckout}</strong>
            <span style={styles.policyValue}>
              {current.defaultNormalCheckoutTime}
            </span>
            <small style={styles.help}>{t.attendanceHelp}</small>
            <small style={styles.help}>{t.overrideHelp}</small>
          </div>
        </div>
      </section>

      {props.data.capabilities.mutate &&
      !props.data.overview.scheduled ? (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>✏️ {t.newSetting}</h2>
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
              label={`${t.before} · ${t.normalCheckout}`}
              value={current.defaultNormalCheckoutTime}
            />
            <Metric
              label={`${t.after} · ${t.normalCheckout}`}
              value={props.normalCheckout}
            />
          </div>
          <div style={styles.grid}>
            <Field label={`⏰ ${t.lateGrace}`}>
              <div style={styles.inlineInput}>
                <input
                  type="number"
                  min={0}
                  max={180}
                  step={1}
                  required
                  style={styles.input}
                  value={props.lateGrace}
                  onChange={(event) =>
                    props.onLateGrace(Number(event.target.value))
                  }
                />
                <span>{t.minutes}</span>
              </div>
            </Field>
            <Field label={`🌙 ${t.normalCheckout}`}>
              <input
                type="time"
                style={styles.input}
                value={props.normalCheckout}
                onChange={(event) =>
                  props.onNormalCheckout(event.target.value)
                }
              />
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
          <p style={styles.help}>{t.lateHelp}</p>
          <p style={styles.help}>{t.attendanceHelp}</p>
          <p style={styles.help}>{t.overrideHelp}</p>
          <button
            style={ui.button}
            disabled={props.busy}
            onClick={props.onSave}
          >
            {props.busy ? t.saving : t.save}
          </button>
        </section>
      ) : null}
    </>
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
            <div style={styles.shadowList}>
              {result.dateSummaries.map((day) => (
                <article key={day.businessDate} style={styles.shadowRow}>
                  <strong>
                    {day.businessDate} ·{" "}
                    {day.fallbackUsed
                      ? t.fallbackSetting
                      : `#${day.settingsRevision}`}
                  </strong>
                  <small style={styles.rowMeta}>
                    {day.storeOpenTime || "-"} ~ {day.storeCloseTime || "-"}
                    {" · "}
                    {t.cutoff} {day.businessDayCutoffTime}
                    {day.hasBusinessOverride ? ` · ${t.specialClose}` : ""}
                  </small>
                  {day.fallbackUsed ? (
                    <small style={styles.warning}>{t.noSavedSetting}</small>
                  ) : null}
                  <span>{t.total} {day.totalRecords} · {t.matched} {day.matched} · {t.mismatched} {day.mismatched} · {t.excludedRows} {day.excluded}</span>
                </article>
              ))}
            </div>
          </section>

          <section style={styles.card}>
            <div style={styles.cardHeader}>
              <h2 style={styles.sectionTitle}>⚠️ {t.mismatched}</h2>
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
  const sourceText = {
    override: `${t.specialClose} ${props.row.configured.effectiveStoreCloseAt?.slice(11, 16) || "-"} ${props.lang === "ko" ? "적용" : "áp dụng"}`,
    configured: `${t.storeClose} ${props.row.configured.effectiveStoreCloseAt?.slice(11, 16) || "-"}`,
    fallback: `${t.defaultClose} ${props.row.configured.normalCheckoutThresholdAt?.slice(11, 16) || "-"}`,
  }[props.row.configured.closeSource];
  const changed = Object.values(props.row.differences).some(Boolean);

  return (
    <article
      style={{
        ...styles.shadowRow,
        borderColor: changed ? "#f59e0b" : "#bbf7d0",
      }}
    >
      <div style={styles.cardHeader}>
        <div>
          <strong>{props.row.userName}</strong>
          <small style={styles.rowMeta}>{props.row.businessDate}</small>
        </div>
        <span style={changed ? styles.changedBadge : styles.matchBadge}>
          {changed ? t.mismatched : t.matched}
        </span>
      </div>
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
          <p>{t.status}: {props.row.configured.status}</p>
          <p>{t.late}: {props.row.configured.lateMinutes}</p>
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
      <div style={styles.grid}>
        <Metric label={t.timezone} value={props.setting.timezone} />
        <Metric
          label={t.cutoff}
          value={props.setting.businessDayCutoffTime}
        />
        <Metric
          label={t.effective}
          value={props.setting.effectiveFromBusinessDate}
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
      <small>{props.label}</small>
      <strong>{props.value}</strong>
    </span>
  );
}

const styles: Record<string, CSSProperties> = {
  tabs: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 4,
    padding: 4,
    margin: "0 0 10px",
    borderRadius: 12,
    background: "#e5e7eb",
  },
  tab: {
    minHeight: 38,
    border: 0,
    borderRadius: 9,
    background: "transparent",
    color: "#64748b",
    fontSize: 12,
    fontWeight: 850,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  activeTab: {
    background: "#111827",
    color: "#fff",
    boxShadow: "0 2px 5px rgba(15,23,42,.2)",
  },
  card: { ...ui.card, padding: 16, marginBottom: 12 },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  sectionTitle: { fontSize: 16, fontWeight: 900, margin: "0 0 12px" },
  subheading: {
    borderTop: "1px solid #e5e7eb",
    paddingTop: 14,
    margin: "14px 0 8px",
    fontSize: 13,
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
    gridTemplateColumns: "28px 1fr auto 1fr 64px",
    alignItems: "center",
    gap: 6,
    padding: 7,
    background: "#fff",
  },
  timeInput: { ...ui.input, width: "100%", minWidth: 0, padding: 6 },
  openToggle: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
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
    gap: 8,
    padding: 14,
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    background: "#f8fafc",
  },
  policyValue: {
    color: "#111827",
    fontSize: 22,
    fontWeight: 950,
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
    borderRadius: 10,
    background: "#f8fafc",
    minWidth: 0,
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
    padding: 12,
    border: "1px solid",
    borderRadius: 12,
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
  },
  matchBadge: {
    color: "#166534",
    background: "#dcfce7",
    borderRadius: 999,
    padding: "4px 8px",
    fontSize: 11,
  },
  danger: {
    border: "1px solid #fecaca",
    background: "#fff",
    color: "#b91c1c",
    borderRadius: 9,
    padding: "8px 10px",
    fontWeight: 800,
  },
  historyButton: {
    border: 0,
    background: "transparent",
    padding: 0,
    fontWeight: 900,
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
