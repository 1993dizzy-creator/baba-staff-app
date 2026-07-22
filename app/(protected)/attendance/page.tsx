"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { ui } from "@/lib/styles/ui";
import { useLanguage } from "@/lib/language-context";
import { commonText, attendanceText } from "@/lib/text";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { getUser } from "@/lib/supabase/auth";
import { ATTENDANCE_STATUS } from "@/lib/attendance/status";
import { getBusinessDate } from "@/lib/common/business-time";
import { attendanceFetch } from "@/lib/auth/client-session";


function formatTodayDate(lang: "ko" | "vi") {
  const date = new Date();

  const dateText = date.toLocaleDateString(lang === "vi" ? "vi-VN" : "ko-KR", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });

  return dateText;
}

function formatCalendarTitle(lang: "ko" | "vi", date: Date) {
  if (lang === "vi") {
    return `Tháng ${date.getMonth() + 1}\n${date.getFullYear()}`;
  }

  const year = String(date.getFullYear()).slice(2);
  return `${year}년 ${date.getMonth() + 1}월`;
}

type AttendanceStatus =
  | "before"
  | (typeof ATTENDANCE_STATUS)[keyof typeof ATTENDANCE_STATUS];

type AttendanceState = {
  status: AttendanceStatus;
  checkInTime: string;
  checkOutTime: string;
  workDuration: string;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  monthSummary: {
    workDays: number;
    totalHours: number;
    totalMinutes: number;
    lateCount: number;
    lateMinutes: number;
    earlyLeaveCount: number;
    earlyLeaveMinutes: number;
    leaveDays: number;
  };
};

type AttendanceRecord = {
  id?: number;
  work_date: string;
  status?: string | null;
  approval_status?: string | null;
  check_in_at?: string | null;
  check_out_at?: string | null;
  work_minutes?: number | string | null;
  late_minutes?: number | string | null;
  early_leave_minutes?: number | string | null;
};

type AttendanceAction = "check_in" | "check_out";
type AttendanceActionPhase =
  | "idle"
  | "locating"
  | "saving"
  | "success"
  | "error";

type AttendanceActionFeedback = {
  action: AttendanceAction | null;
  phase: AttendanceActionPhase;
  message: string;
};

const initialActionFeedback: AttendanceActionFeedback = {
  action: null,
  phase: "idle",
  message: "",
};

const monthlyAttendanceRequests = new Map<
  string,
  Promise<AttendanceRecord[]>
>();

class AttendanceNetworkError extends Error {}

const attendanceActionCopy = {
  ko: {
    locating: "위치 확인 중입니다.",
    savingCheckIn: "출근 정보를 저장하고 있습니다.",
    savingCheckOut: "퇴근 정보를 저장하고 있습니다.",
    refreshing: "근태 현황을 갱신하고 있습니다.",
    refreshFailed: "출퇴근은 저장됐지만 월간 현황 갱신에 실패했습니다.",
    monthLoadFailed: "월간 근태 정보를 불러오지 못했습니다.",
    checkInSuccess: "출근 완료",
    checkOutSuccess: "퇴근 완료",
    permissionDenied: "위치 권한이 거부되었습니다. 브라우저 설정에서 위치 권한을 허용해 주세요.",
    positionUnavailable: "현재 위치 정보를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    positionTimeout: "위치 확인 시간이 초과되었습니다. GPS 상태를 확인하고 다시 시도해 주세요.",
    networkError: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
    unexpectedError: "예상하지 못한 오류가 발생했습니다. 다시 시도해 주세요.",
  },
  vi: {
    locating: "Đang kiểm tra vị trí.",
    savingCheckIn: "Đang lưu giờ vào ca.",
    savingCheckOut: "Đang lưu giờ tan ca.",
    refreshing: "Đang cập nhật tình hình chấm công.",
    refreshFailed: "Đã lưu chấm công nhưng không thể cập nhật dữ liệu tháng.",
    monthLoadFailed: "Không thể tải dữ liệu chấm công tháng.",
    checkInSuccess: "Đã chấm công vào",
    checkOutSuccess: "Đã chấm công ra",
    permissionDenied: "Quyền vị trí đã bị từ chối. Vui lòng cho phép vị trí trong cài đặt trình duyệt.",
    positionUnavailable: "Không thể xác định vị trí hiện tại. Vui lòng thử lại sau.",
    positionTimeout: "Hết thời gian xác định vị trí. Vui lòng kiểm tra GPS và thử lại.",
    networkError: "Vui lòng kiểm tra kết nối mạng và thử lại.",
    unexpectedError: "Đã xảy ra lỗi không mong muốn. Vui lòng thử lại.",
  },
} as const;

const initialAttendanceState: AttendanceState = {
  status: "before",
  checkInTime: "-",
  checkOutTime: "-",
  workDuration: "00:00",
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  monthSummary: {
    workDays: 0,
    totalHours: 0,
    totalMinutes: 0,
    lateCount: 0,
    lateMinutes: 0,
    earlyLeaveCount: 0,
    earlyLeaveMinutes: 0,
    leaveDays: 0,
  },
};

function formatTimeForDisplay(value: string) {
  return new Date(value).toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatMinutesToHHMM(minutes: number) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");

  return `${h}:${m}`;
}

function calculateWorkMinutes(startIso: string, endIso: string) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0;
  }

  return Math.floor((end - start) / 1000 / 60);
}


function isApprovedLeave(record?: AttendanceRecord | null) {
  return record?.status === ATTENDANCE_STATUS.LEAVE && record?.approval_status === "approved";
}

function calculateMonthSummary(records: AttendanceRecord[]) {
  const now = new Date();

  const vietnamNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  const totalWorkMinutes = records.reduce((sum, record) => {
    if (!record.check_in_at) return sum;

    // 퇴근 안한 경우 → 현재시간까지 계산
    if (!record.check_out_at) {
      return (
        sum +
        calculateWorkMinutes(record.check_in_at, vietnamNow.toISOString())
      );
    }

    // 정상 퇴근
    return (
      sum +
      calculateWorkMinutes(record.check_in_at, record.check_out_at)
    );
  }, 0);

  const totalLateMinutes = records.reduce(
    (sum, record) => sum + Number(record.late_minutes || 0),
    0
  );

  const totalEarlyLeaveMinutes = records.reduce(
    (sum, record) =>
      record.status === ATTENDANCE_STATUS.EARLY_LEAVE
        ? sum + Number(record.early_leave_minutes || 0)
        : sum,
    0
  );

  return {
    workDays: records.filter((r) => r.check_in_at).length,

    totalHours: Math.floor(totalWorkMinutes / 60),
    totalMinutes: totalWorkMinutes % 60,

    lateCount: records.filter(
      (r) => Number(r.late_minutes || 0) > 0
    ).length,

    lateMinutes: totalLateMinutes,

    earlyLeaveCount: records.filter(
      (r) => r.status === ATTENDANCE_STATUS.EARLY_LEAVE
    ).length,

    earlyLeaveMinutes: totalEarlyLeaveMinutes,

    leaveDays: records.filter((r) => isApprovedLeave(r)).length,
  };
}

const STORE_LAT = 21.170365726028983; // TODO: 매장 위도
const STORE_LNG = 106.05620440469892; // TODO: 매장 경도
const ALLOWED_DISTANCE_M = 100;


function getDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
) {
  const earthRadius = 6371000;

  const toRad = (value: number) => (value * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) *
    Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(earthRadius * c);
}

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("GPS_NOT_SUPPORTED"));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  });
}

function getMonthRange(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const monthText = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();

  return {
    monthKey: `${year}-${monthText}`,
    start: `${year}-${monthText}-01`,
    end: `${year}-${monthText}-${String(lastDay).padStart(2, "0")}`,
  };
}

function getGeolocationErrorMessage(
  error: unknown,
  copy: (typeof attendanceActionCopy)["ko"] | (typeof attendanceActionCopy)["vi"]
) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Number((error as { code?: unknown }).code)
      : null;

  if (code === 1) return copy.permissionDenied;
  if (code === 2) return copy.positionUnavailable;
  if (code === 3) return copy.positionTimeout;
  return copy.positionUnavailable;
}

function requestMonthlyAttendance(input: {
  userId: string | number;
  date: Date;
  force?: boolean;
}) {
  const { monthKey } = getMonthRange(input.date);
  const requestKey = `${input.userId}:${monthKey}`;

  if (!input.force) {
    const existingRequest = monthlyAttendanceRequests.get(requestKey);
    if (existingRequest) return existingRequest;
  }

  const request: Promise<AttendanceRecord[]> = attendanceFetch(
    `/api/attendance/records?scope=self_month&month=${monthKey}`
  )
    .then(async (res) => {
      const result = await res.json().catch(() => null);
      if (!res.ok || !result?.ok) {
        throw new Error(result?.message || "MONTHLY_ATTENDANCE_REQUEST_FAILED");
      }
      return (result.records || []) as AttendanceRecord[];
    })
    .catch((error) => {
      if (error instanceof TypeError) {
        throw new AttendanceNetworkError(error.message);
      }
      throw error;
    })
    .finally(() => {
      if (monthlyAttendanceRequests.get(requestKey) === request) {
        monthlyAttendanceRequests.delete(requestKey);
      }
    });

  monthlyAttendanceRequests.set(requestKey, request);
  return request;
}


function getStatusLabel(
  status: AttendanceStatus,
  t: (typeof attendanceText)["ko"] | (typeof attendanceText)["vi"],
  checkInTime: string,
  checkOutTime: string
) {
  if (status === "before") return t.workBefore;
  if (status === ATTENDANCE_STATUS.LEAVE) return t.workLeave;
  if (checkOutTime !== "-") {
    return status === ATTENDANCE_STATUS.EARLY_LEAVE
      ? t.workEarlyLeave
      : t.workDone;
  }
  if (checkInTime !== "-") return t.working;
  if (status === ATTENDANCE_STATUS.DONE) return t.workDone;
  return t.working;
}

export default function AttendancePage() {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const attendanceTabs = getAttendanceTabs(pathname, lang);

  return (
    <Container noPaddingTop>
      <SubNav tabs={attendanceTabs} />
      <MyAttendance />
    </Container>
  );
}

function MyAttendance() {
  const [isLoadingToday, setIsLoadingToday] = useState(true);
  const { lang } = useLanguage();
  const c = commonText[lang];
  const t = attendanceText[lang];
  const actionCopy = attendanceActionCopy[lang];
  const [actionFeedback, setActionFeedback] =
    useState<AttendanceActionFeedback>(initialActionFeedback);
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [monthRecords, setMonthRecords] = useState<AttendanceRecord[]>([]);
  const [isRefreshingMonth, setIsRefreshingMonth] = useState(false);
  const [monthFeedback, setMonthFeedback] = useState("");
  const actionInFlightRef = useRef(false);
  const monthRequestSequenceRef = useRef(0);
  const isMountedRef = useRef(true);
  const calendarDateRef = useRef(calendarDate);
  calendarDateRef.current = calendarDate;
  const isSubmittingAttendance =
    actionFeedback.phase === "locating" || actionFeedback.phase === "saving";

  const [nowText, setNowText] = useState("");

  useEffect(() => {
    const updateNow = () => {
      const now = new Date();

      const time = now.toLocaleTimeString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      setNowText(time);
    };

    updateNow();
    const timer = setInterval(updateNow, 30000);

    return () => clearInterval(timer);
  }, []);

  const [attendance, setAttendance] =
    useState<AttendanceState>(initialAttendanceState);
  const [hasPendingLeaveToday, setHasPendingLeaveToday] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchTodayAttendance = async () => {
    setIsLoadingToday(true);

    try {
      const user = getUser();
      if (!user?.id) return;

      const workDate = getBusinessDate();

      const res = await attendanceFetch(
        `/api/attendance/records?scope=self_day&work_date=${workDate}`
      );

      const result = await res.json();

      if (!res.ok || !result.ok) {
        console.log("fetch today attendance error:", result);
        return;
      }

      const data = result.records?.[0] || null;

      if (!data) {
        setAttendance((prev) => ({
          ...initialAttendanceState,
          monthSummary: prev.monthSummary,
        }));
        setHasPendingLeaveToday(false);
        return;
      }

      if (data.status === ATTENDANCE_STATUS.LEAVE && !isApprovedLeave(data)) {
        setAttendance((prev) => ({
          ...initialAttendanceState,
          monthSummary: prev.monthSummary,
        }));
        setHasPendingLeaveToday(true);
        return;
      }

      setHasPendingLeaveToday(false);
      setAttendance((prev) => ({
        ...prev,
        status: data.status || "before",
        checkInTime: data.check_in_at ? formatTimeForDisplay(data.check_in_at) : "-",
        checkOutTime: data.check_out_at ? formatTimeForDisplay(data.check_out_at) : "-",
        workDuration: formatMinutesToHHMM(data.work_minutes || 0),
        lateMinutes: data.late_minutes || 0,
        earlyLeaveMinutes: data.early_leave_minutes || 0,
      }));
    } finally {
      setIsLoadingToday(false);
    }
  };

  useEffect(() => {
    void fetchTodayAttendance();
  }, []);

  useEffect(() => {
    if (actionFeedback.phase !== "success") return;
    const timer = window.setTimeout(() => {
      setActionFeedback((current) =>
        current.phase === "success" ? initialActionFeedback : current
      );
    }, 5000);

    return () => window.clearTimeout(timer);
  }, [actionFeedback.phase]);

  const loadMonthAttendance = useCallback(
    async (options?: {
      date?: Date;
      force?: boolean;
      afterAttendanceSave?: boolean;
    }) => {
      const user = getUser();
      if (!user?.id) return;
      const requestDate = options?.date ?? calendarDateRef.current;

      const requestSequence = ++monthRequestSequenceRef.current;
      setIsRefreshingMonth(true);
      setMonthFeedback("");

      try {
        const records = await requestMonthlyAttendance({
          userId: user.id,
          date: requestDate,
          force: options?.force,
        });

        if (
          !isMountedRef.current ||
          requestSequence !== monthRequestSequenceRef.current
        ) {
          return;
        }

        setMonthRecords(records);
        setAttendance((prev) => ({
          ...prev,
          monthSummary: calculateMonthSummary(records),
        }));
      } catch (error) {
        if (
          !isMountedRef.current ||
          requestSequence !== monthRequestSequenceRef.current
        ) {
          return;
        }

        console.error("fetch monthly attendance error:", error);
        setMonthFeedback(
          options?.afterAttendanceSave
            ? actionCopy.refreshFailed
            : actionCopy.monthLoadFailed
        );
      } finally {
        if (
          isMountedRef.current &&
          requestSequence === monthRequestSequenceRef.current
        ) {
          setIsRefreshingMonth(false);
        }
      }
    },
    [actionCopy.monthLoadFailed, actionCopy.refreshFailed]
  );

  useEffect(() => {
    void loadMonthAttendance({ date: calendarDate });
  }, [calendarDate, loadMonthAttendance]);

  const handleCheckIn = async () => {
    if (actionInFlightRef.current || isSubmittingAttendance) return;
    if (isLoadingToday) return;
    if (attendance.status !== "before") return;
    if (attendance.checkInTime !== "-") return;
    if (hasPendingLeaveToday) return;

    const user = getUser();

    if (!user?.id) {
      setActionFeedback({ action: "check_in", phase: "error", message: c.noData });
      return;
    }

    actionInFlightRef.current = true;
    setActionFeedback({
      action: "check_in",
      phase: "locating",
      message: actionCopy.locating,
    });

    try {
      let position: GeolocationPosition;
      try {
        position = await getCurrentPosition();
      } catch (error) {
        setActionFeedback({
          action: "check_in",
          phase: "error",
          message: getGeolocationErrorMessage(error, actionCopy),
        });
        return;
      }

      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;

      const distanceM = getDistanceMeters(latitude, longitude, STORE_LAT, STORE_LNG);
      const isLocationValid = distanceM <= ALLOWED_DISTANCE_M;

      if (!isLocationValid) {
        setActionFeedback({
          action: "check_in",
          phase: "error",
          message: t.checkInOutOfRange.replace("{distance}", String(distanceM)),
        });
        return;
      }

      setActionFeedback({
        action: "check_in",
        phase: "saving",
        message: actionCopy.savingCheckIn,
      });

      let res: Response;
      try {
        res = await attendanceFetch("/api/attendance/check-in", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            language: lang,
            latitude,
            longitude,
            distance_m: distanceM,
            is_location_valid: isLocationValid,
          }),
        });
      } catch {
        throw new AttendanceNetworkError(actionCopy.networkError);
      }

      const result = await res.json().catch(() => null);

      if (!result) throw new Error("INVALID_CHECK_IN_RESPONSE");
      if (!res.ok || !result?.ok) {
        setActionFeedback({
          action: "check_in",
          phase: "error",
          message: result?.message || t.checkInFail,
        });
        return;
      }

      const data = result.record;
      const checkInTime = data.check_in_at
        ? formatTimeForDisplay(data.check_in_at)
        : "-";

      setAttendance((prev) => ({
        ...prev,
        status: data.status || ATTENDANCE_STATUS.WORKING,
        checkInTime,
        checkOutTime: "-",
        workDuration: "00:00",
        lateMinutes: data.late_minutes || 0,
        earlyLeaveMinutes: data.early_leave_minutes || 0,
      }));
      setActionFeedback({
        action: "check_in",
        phase: "success",
        message: `${actionCopy.checkInSuccess} · ${checkInTime}`,
      });
      void loadMonthAttendance({ force: true, afterAttendanceSave: true });
    } catch (error) {
      console.error(error);
      setActionFeedback({
        action: "check_in",
        phase: "error",
        message:
          error instanceof AttendanceNetworkError
            ? actionCopy.networkError
            : actionCopy.unexpectedError,
      });
    } finally {
      actionInFlightRef.current = false;
    }
  };

  const handleCheckOutClick = () => {
    if (attendance.checkInTime === "-" || attendance.checkOutTime !== "-") return;
    void handleConfirmCheckOut();
  };

  const handleConfirmCheckOut = async () => {
    if (actionInFlightRef.current || isSubmittingAttendance) return;

    const user = getUser();

    if (!user?.id) {
      setActionFeedback({ action: "check_out", phase: "error", message: c.noData });
      return;
    }

    actionInFlightRef.current = true;
    setActionFeedback({
      action: "check_out",
      phase: "locating",
      message: actionCopy.locating,
    });

    try {
      let position: GeolocationPosition;
      try {
        position = await getCurrentPosition();
      } catch (error) {
        setActionFeedback({
          action: "check_out",
          phase: "error",
          message: getGeolocationErrorMessage(error, actionCopy),
        });
        return;
      }

      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;

      const distanceM = getDistanceMeters(latitude, longitude, STORE_LAT, STORE_LNG);
      const isLocationValid = distanceM <= ALLOWED_DISTANCE_M;

      if (!isLocationValid) {
        setActionFeedback({
          action: "check_out",
          phase: "error",
          message: t.checkOutOutOfRange.replace("{distance}", String(distanceM)),
        });
        return;
      }

      setActionFeedback({
        action: "check_out",
        phase: "saving",
        message: actionCopy.savingCheckOut,
      });

      let res: Response;
      try {
        res = await attendanceFetch("/api/attendance/check-out", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            language: lang,
            latitude,
            longitude,
            distance_m: distanceM,
            is_location_valid: isLocationValid,
          }),
        });
      } catch {
        throw new AttendanceNetworkError(actionCopy.networkError);
      }

      const result = await res.json().catch(() => null);

      if (!result) throw new Error("INVALID_CHECK_OUT_RESPONSE");
      if (!res.ok || !result?.ok) {
        setActionFeedback({
          action: "check_out",
          phase: "error",
          message: result?.message || t.checkOutFail,
        });
        return;
      }

      const data = result.record;
      const checkOutTime = data.check_out_at
        ? formatTimeForDisplay(data.check_out_at)
        : "-";

      setAttendance((prev) => ({
        ...prev,
        status: data.status || ATTENDANCE_STATUS.DONE,
        checkOutTime,
        workDuration: formatMinutesToHHMM(data.work_minutes || 0),
        lateMinutes: data.late_minutes || prev.lateMinutes,
        earlyLeaveMinutes: data.early_leave_minutes || 0,
      }));
      setActionFeedback({
        action: "check_out",
        phase: "success",
        message: `${actionCopy.checkOutSuccess} · ${checkOutTime}`,
      });
      void loadMonthAttendance({ force: true, afterAttendanceSave: true });
    } catch (error) {
      console.error(error);
      setActionFeedback({
        action: "check_out",
        phase: "error",
        message:
          error instanceof AttendanceNetworkError
            ? actionCopy.networkError
            : actionCopy.unexpectedError,
      });
    } finally {
      actionInFlightRef.current = false;
    }
  };

  const isEarlyLeave = attendance.status === ATTENDANCE_STATUS.EARLY_LEAVE;
  const isCurrentlyWorking =
    attendance.status !== ATTENDANCE_STATUS.LEAVE &&
    attendance.checkInTime !== "-" &&
    attendance.checkOutTime === "-";

  const checkInDisabled =
    isLoadingToday ||
    isSubmittingAttendance ||
    attendance.status !== "before" ||
    attendance.checkInTime !== "-" ||
    hasPendingLeaveToday;

  const checkOutDisabled =
    isLoadingToday ||
    isSubmittingAttendance ||
    !isCurrentlyWorking;

  const lateDisplayText =
    attendance.lateMinutes > 0
      ? t.lateText.replace("{minutes}", String(attendance.lateMinutes))
      : t.workNormal;

  const lateDisplayColor = attendance.lateMinutes > 0 ? "#f59e0b" : "#10b981";

  return (
    <div style={sectionStyle}>
      <div style={cardStyle}>
        <div style={todayHeaderRow}>
          <div style={statusBadgeStyle(attendance.status)}>
            ● {getStatusLabel(
              attendance.status,
              t,
              attendance.checkInTime,
              attendance.checkOutTime
            )}
          </div>

          <div style={todayDateRow}>
            <span>
              {formatTodayDate(lang)} · {nowText}
            </span>
            <span style={{ fontSize: 15, lineHeight: 1 }}>🗓️</span>
          </div>
        </div>

        <div style={todayStatusPanel}>
          <TodayInfoBlock label={t.checkInTimeLabel}>
            {attendance.checkInTime}
          </TodayInfoBlock>

          <div style={todayStatusDivider} />

          <TodayInfoBlock label={t.checkOutTimeLabel}>
            {attendance.checkOutTime}
          </TodayInfoBlock>

          <div style={todayStatusDivider} />

          <TodayInfoBlock label={t.workLate}>
            <span style={{ color: lateDisplayColor }}>{lateDisplayText}</span>
          </TodayInfoBlock>

          <div style={todayStatusDivider} />

          <TodayInfoBlock
            label={t.workDurationLabel}
            subValue={
              isEarlyLeave
                ? t.earlyLeaveText.replace("{minutes}", String(attendance.earlyLeaveMinutes))
                : undefined
            }
            subColor="#ef4444"
          >
            {attendance.workDuration}
          </TodayInfoBlock>
        </div>

        <div style={actionGrid}>
          <button
            type="button"
            style={{
              ...checkInButtonStyle,
              opacity: checkInDisabled ? 0.45 : 1,
              cursor: checkInDisabled ? "not-allowed" : "pointer",
            }}
            onClick={handleCheckIn}
            disabled={checkInDisabled}
          >
            <span style={actionButtonIcon}>↪</span>
            <div style={actionButtonTextWrap}>
              <div style={actionButtonTitle}>
                {isLoadingToday
                  ? c.loading
                  : actionFeedback.action === "check_in" &&
                      actionFeedback.phase === "locating"
                    ? actionCopy.locating
                    : actionFeedback.action === "check_in" &&
                        actionFeedback.phase === "saving"
                      ? actionCopy.savingCheckIn
                      : t.checkInButton}
              </div>
              <div style={actionButtonSubDark}>{t.checkInButtonDesc}</div>
            </div>
          </button>

          <button
            type="button"
            style={{
              ...checkOutButtonStyle,
              opacity: checkOutDisabled ? 0.45 : 1,
              cursor: checkOutDisabled ? "not-allowed" : "pointer",
            }}
            onClick={handleCheckOutClick}
            disabled={checkOutDisabled}
          >
            <span style={actionButtonIconDark}>↩</span>
            <div style={actionButtonTextWrap}>
              <div style={actionButtonTitleDark}>
                {isLoadingToday
                  ? c.loading
                  : actionFeedback.action === "check_out" &&
                      actionFeedback.phase === "locating"
                    ? actionCopy.locating
                    : actionFeedback.action === "check_out" &&
                        actionFeedback.phase === "saving"
                      ? actionCopy.savingCheckOut
                      : t.checkOutButton}
              </div>
              <div style={actionButtonSubDark}>{t.checkOutButtonDesc}</div>
            </div>
          </button>
        </div>

        {actionFeedback.message ? (
          <div
            role={actionFeedback.phase === "error" ? "alert" : "status"}
            aria-live="polite"
            style={actionFeedbackStyle(actionFeedback.phase)}
          >
            {actionFeedback.message}
          </div>
        ) : null}

        {isRefreshingMonth ? (
          <div role="status" aria-live="polite" style={refreshFeedbackStyle}>
            {actionCopy.refreshing}
          </div>
        ) : null}

        {monthFeedback ? (
          <div role="alert" style={monthFeedbackStyle}>
            {monthFeedback}
          </div>
        ) : null}
      </div>

      <Calendar
        calendarDate={calendarDate}
        monthRecords={monthRecords}
        onMonthChange={setCalendarDate}
      />

      <div style={cardStyle}>
        <div style={monthSummaryHeader}>
          <div style={sectionTitle}>{t.monthSummaryTitle}</div>
        </div>

        <div style={monthSummaryGrid}>
          <SummaryStatCard
            icon="📅"
            iconBg="#eff6ff"
            iconColor="#2563eb"
            label={t.summaryWorkDays}
            value={
              lang === "vi"
                ? `${attendance.monthSummary.workDays} ngày`
                : `${attendance.monthSummary.workDays}일`
            }
            subValue=""
          />
          <SummaryStatCard
            icon="🕒"
            iconBg="#f3f4f6"
            iconColor="#6b7280"
            label={t.summaryTotalWorkTime}
            value={
              lang === "vi"
                ? `${attendance.monthSummary.totalHours} giờ`
                : `${attendance.monthSummary.totalHours}시간`
            }
            subValue={
              lang === "vi"
                ? `${attendance.monthSummary.totalMinutes} phút`
                : `${attendance.monthSummary.totalMinutes}분`
            }
          />
          <SummaryStatCard
            icon="🟠"
            iconBg="#fff7ed"
            iconColor="#f97316"
            label={t.workLate}
            value={
              lang === "vi"
                ? `${attendance.monthSummary.lateCount} lần`
                : `${attendance.monthSummary.lateCount}회`
            }
            subValue={
              lang === "vi"
                ? `${attendance.monthSummary.lateMinutes} phút`
                : `${attendance.monthSummary.lateMinutes}분`
            }
          />
          <SummaryStatCard
            icon="⟳"
            iconBg="#fef2f2"
            iconColor="#ef4444"
            label={t.workEarlyLeave}
            value={
              lang === "vi"
                ? `${attendance.monthSummary.earlyLeaveCount} lần`
                : `${attendance.monthSummary.earlyLeaveCount}회`
            }
            subValue={
              lang === "vi"
                ? `${attendance.monthSummary.earlyLeaveMinutes} phút`
                : `${attendance.monthSummary.earlyLeaveMinutes}분`
            }
          />
          <SummaryStatCard
            icon="💼"
            iconBg="#f3f4f6"
            iconColor="#6b7280"
            label={t.workLeave}
            value={
              lang === "vi"
                ? `${attendance.monthSummary.leaveDays} ngày`
                : `${attendance.monthSummary.leaveDays}일`
            }
            subValue=""
          />
        </div>
      </div>

    </div>
  );
}

function TodayInfoBlock({
  label,
  children,
  subValue,
  subColor,
}: {
  label: string;
  children: ReactNode;
  subValue?: string;
  subColor?: string;
}) {
  return (
    <div style={todayInfoBlock}>
      <div style={todayInfoLabel}>{label}</div>
      <div style={todayInfoValue}>{children}</div>
      {subValue ? (
        <div
          style={{
            ...todayInfoSubValue,
            color: subColor || "#6b7280",
          }}
        >
          {subValue}
        </div>
      ) : null}
    </div>
  );
}

function SummaryStatCard({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  subValue,
}: {
  icon: string;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  subValue?: string;
}) {
  return (
    <div style={summaryCardStyle}>
      <div
        style={{
          ...summaryIconWrap,
          background: iconBg,
          color: iconColor,
        }}
      >
        {icon}
      </div>

      <div style={summaryLabelStyle}>{label}</div>
      <div style={summaryValueStyle}>{value}</div>
      <div style={summarySubValueStyle}>{subValue || ""}</div>
    </div>
  );
}

function getCalendarCells(baseDate: Date) {
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDate = new Date(year, month + 1, 0).getDate();
  const firstWeekday = firstDay.getDay();

  const prevLastDate = new Date(year, month, 0).getDate();

  const cells = [];

  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({
      day: prevLastDate - i,
      type: "prev" as const,
    });
  }

  for (let day = 1; day <= lastDate; day++) {
    cells.push({
      day,
      type: "current" as const,
    });
  }

  const nextDayCount = 42 - cells.length;

  for (let day = 1; day <= nextDayCount; day++) {
    cells.push({
      day,
      type: "next" as const,
    });
  }

  return cells;
}

function Calendar({
  calendarDate,
  monthRecords,
  onMonthChange,
}: {
  calendarDate: Date;
  monthRecords: AttendanceRecord[];
  onMonthChange: (date: Date) => void;
}) {
  const { lang } = useLanguage();
  const t = attendanceText[lang];
  const c = commonText[lang];
  const calendarCells = useMemo(
    () => getCalendarCells(calendarDate),
    [calendarDate]
  );
  const recordsByDate = useMemo(
    () => new Map(monthRecords.map((record) => [record.work_date, record])),
    [monthRecords]
  );

  const getDayRecord = (day: number) => {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth() + 1;

    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    return recordsByDate.get(dateStr);
  };

  return (
    <div style={cardStyle}>
      <div style={calendarHeaderRow}>
        <div style={calendarTitleWrap}>
          <button
            type="button"
            style={calendarMonthButtonStyle}
            onClick={() =>
              onMonthChange(
                new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1)
              )
            }
          >
            ‹
          </button>

          <div style={calendarTitle}>{formatCalendarTitle(lang, calendarDate)}</div>

          <button
            type="button"
            style={calendarMonthButtonStyle}
            onClick={() =>
              onMonthChange(
                new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1)
              )
            }
          >
            ›
          </button>
        </div>

        <div style={calendarLegendStyle}>
          <LegendItem label={t.workNormal} color="#10b981" />
          <LegendItem label={t.workLate} color="#f59e0b" />
          <LegendItem label={t.workEarlyLeave} color="#ef4444" />
          <LegendItem label={t.workLeave} color="#6b7280" />
        </div>
      </div>

      <div style={calendarWrapStyle}>
        <div style={weekHeaderGridStyle}>
          {c.calendarWeekdays.map((day) => (
            <div
              key={day}
              style={{
                ...weekHeaderCellStyle,
                color:
                  day === "토" || day === "T7"
                    ? "#2563eb"
                    : day === "일" || day === "CN"
                      ? "#dc2626"
                      : "#6b7280",
              }}
            >
              {day}
            </div>
          ))}
        </div>

        <div style={calendarGrid}>
          {calendarCells.map((cell, index) => {
            const displayDay = cell.day;
            const isMuted = cell.type !== "current";
            const isToday =
              cell.type === "current" &&
              displayDay === new Date().getDate() &&
              calendarDate.getMonth() === new Date().getMonth() &&
              calendarDate.getFullYear() === new Date().getFullYear();

            const isSunday = index % 7 === 0;
            const isSaturday = index % 7 === 6;

            const record = cell.type === "current" ? getDayRecord(displayDay) : null;

            let dotColor = "#10b981";

            if (record?.status === ATTENDANCE_STATUS.EARLY_LEAVE) {
              dotColor = "#ef4444";
            } else if (Number(record?.late_minutes || 0) > 0) {
              dotColor = "#f59e0b";
            } else if (isApprovedLeave(record)) {
              dotColor = "#6b7280";
            }

            return (
              <div
                key={`${cell.type}-${displayDay}-${index}`}
                style={calendarCellStyle({
                  isToday,
                  isMuted,
                  isSunday,
                  isSaturday,
                })}
              >
                <div>{displayDay}</div>

                {!isMuted && record && (record.status !== ATTENDANCE_STATUS.LEAVE || isApprovedLeave(record)) && (
                  <div
                    style={{
                      ...calendarDotStyle,
                      background: dotColor,
                    }}
                  />
                )}

                {isMuted && <div style={calendarMutedDotStyle}>·</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LegendItem({
  label,
  color,
}: {
  label: string;
  color: string;
}) {
  return (
    <div style={legendItemStyle}>
      <span
        style={{
          ...legendDotStyle,
          background: color,
        }}
      />
      <span>{label}</span>
    </div>
  );
}

function statusBadgeStyle(status: AttendanceStatus): CSSProperties {

  const map = {
    before: {
      background: "#fef3c7",
      color: "#92400e",
      border: "#fde68a",
    },
    [ATTENDANCE_STATUS.WORKING]: {
      background: "#dcfce7",
      color: "#16a34a",
      border: "#bbf7d0",
    },
    [ATTENDANCE_STATUS.DONE]: {
      background: "#e5e7eb",
      color: "#374151",
      border: "#d1d5db",
    },
    [ATTENDANCE_STATUS.EARLY_LEAVE]: {
      background: "#fee2e2",
      color: "#dc2626",
      border: "#fecaca",
    },
    [ATTENDANCE_STATUS.LEAVE]: {
      background: "#f3f4f6",
      color: "#374151",
      border: "#d1d5db",
    },
    [ATTENDANCE_STATUS.LATE]: {
      background: "#fffbeb",
      color: "#d97706",
      border: "#fde68a",
    },
  };

  const color = map[status] || map.before;

  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "8px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 800,
    background: color.background,
    color: color.color,
    border: `1px solid ${color.border}`,
    whiteSpace: "nowrap",
  };
}

function calendarCellStyle({
  isToday,
  isMuted,
  isSunday,
  isSaturday,
}: {
  isToday: boolean;
  isMuted: boolean;
  isSunday: boolean;
  isSaturday: boolean;
}): CSSProperties {
  return {
    minHeight: 48,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 2,
    paddingTop: 4,
    borderRight: "1px solid #e5e7eb",
    borderBottom: "1px solid #e5e7eb",
    background: isToday ? "#f8fbff" : "#ffffff",
    color: isMuted
      ? "#9ca3af"
      : isSunday
        ? "#dc2626"
        : isSaturday
          ? "#2563eb"
          : "#111827",
    fontSize: 13,
    fontWeight: isToday ? 800 : 700,
    borderRadius: 0,
    boxSizing: "border-box",
  };
}

const cardStyle: CSSProperties = {
  ...ui.card,
  padding: 14,
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 14,
};

const sectionTitle: CSSProperties = {
  ...ui.sectionTitle,
  fontSize: 15,
  marginBottom: 0,
};

const todayHeaderRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
  marginBottom: 12,
};


const todayDateRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "#6b7280",
  fontSize: 13,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const todayStatusPanel: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1px 1fr 1px 1fr 1px 1fr",
  gap: 0,
  alignItems: "stretch",
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  background: "#ffffff",
  padding: "14px 12px",
  marginBottom: 12,
};

const todayInfoBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 0,
  padding: "0 6px",
  textAlign: "center",
};

const todayInfoLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 6,
  lineHeight: 1.15,
  minHeight: 28, // 🔥 라벨 2줄 기준 높이 고정
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
};

const todayInfoValue: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
  lineHeight: 1.2,
};

const todayInfoSubValue: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  marginTop: 6,
  lineHeight: 1.2,
};

const todayStatusDivider: CSSProperties = {
  width: 1,
  background: "#e5e7eb",
};

const actionGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
};

function actionFeedbackStyle(
  phase: AttendanceActionPhase
): CSSProperties {
  const isError = phase === "error";
  const isSuccess = phase === "success";

  return {
    marginTop: 10,
    padding: "10px 12px",
    borderRadius: 12,
    border: `1px solid ${isError ? "#fecaca" : isSuccess ? "#bbf7d0" : "#bfdbfe"}`,
    background: isError ? "#fef2f2" : isSuccess ? "#f0fdf4" : "#eff6ff",
    color: isError ? "#b91c1c" : isSuccess ? "#15803d" : "#1d4ed8",
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1.4,
  };
}

const refreshFeedbackStyle: CSSProperties = {
  marginTop: 8,
  color: "#4b5563",
  fontSize: 12,
  fontWeight: 700,
};

const monthFeedbackStyle: CSSProperties = {
  marginTop: 8,
  color: "#b45309",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.4,
};

const actionButtonBase: CSSProperties = {
  minHeight: 68,
  borderRadius: 14,
  padding: "12px 14px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  cursor: "pointer",
};

const checkInButtonStyle: CSSProperties = {
  ...actionButtonBase,
  border: "1px solid #111827",
  background: "#111827",
  color: "#ffffff",
};

const checkOutButtonStyle: CSSProperties = {
  ...actionButtonBase,
  border: "1px solid #111827",
  background: "#ffffff",
  color: "#111827",
};

const actionButtonIcon: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1,
  color: "#ffffff",
};

const actionButtonIconDark: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1,
  color: "#111827",
};

const actionButtonTextWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  textAlign: "left",
};

const actionButtonTitle: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  lineHeight: 1.2,
  color: "#ffffff",
};


const actionButtonTitleDark: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  lineHeight: 1.2,
  color: "#111827",
};

const actionButtonSubDark: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1.2,
  color: "#6b7280",
  marginTop: 5,
};

const calendarHeaderRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 14,
};

const calendarTitleWrap: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
};

const calendarTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#111827",
  whiteSpace: "pre-line",
  lineHeight: 1.2,
};

const calendarMonthButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 8,
  border: "1px solid #d1d5db",
  background: "#ffffff",
  color: "#111827", // ← 핵심 (진하게)
  fontSize: 18,
  fontWeight: 600,
  lineHeight: 1,
  cursor: "pointer",
};

const calendarLegendStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 14,
  alignItems: "center",
};

const legendItemStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  color: "#4b5563",
  fontWeight: 700,
};

const legendDotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  flexShrink: 0,
};

const calendarWrapStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  overflow: "hidden",
  background: "#ffffff",
};

const weekHeaderGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  borderBottom: "1px solid #e5e7eb",
  background: "#f9fafb",
};

const weekHeaderCellStyle: CSSProperties = {
  textAlign: "center",
  fontSize: 13,
  fontWeight: 800,
  padding: "10px 0",
};

const calendarGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
};

const calendarDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
};

const calendarMutedDotStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1,
  color: "#d1d5db",
  marginTop: 2,
};

const monthSummaryHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 12,
  marginBottom: 12,
};

const monthSummaryGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  gap: 8,
};

const summaryCardStyle: CSSProperties = {
  border: "1px solid #eef0f3",
  background: "#f9fafb",
  borderRadius: 14,
  padding: "10px 6px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  minHeight: 94,
};

const summaryIconWrap: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  marginBottom: 8,
};

const summaryLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 6,
  lineHeight: 1.2,
};

const summaryValueStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#111827",
  lineHeight: 1.2,
};

const summarySubValueStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginTop: 6,
  minHeight: 14,
  lineHeight: 1.2,
};
