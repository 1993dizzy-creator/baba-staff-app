"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { ui } from "@/lib/styles/ui";
import { useLanguage } from "@/lib/language-context";
import { attendanceText } from "@/lib/text/attendance";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { supabase } from "@/lib/supabase/client";
import { getUser } from "@/lib/supabase/auth";


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

type AttendanceStatus = "before" | "working" | "done" | "early_leave" | "leave";

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

function calculateLateMinutes(workStartTime: string) {
  const now = new Date();

  const vietnamNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  const [hour, minute] = workStartTime.split(":").map(Number);

  const startTime = new Date(vietnamNow);
  startTime.setHours(hour, minute, 0, 0);

  const diffMinutes = Math.floor(
    (vietnamNow.getTime() - startTime.getTime()) / 1000 / 60
  );

  return Math.max(0, diffMinutes);
}

function calculateEarlyLeaveMinutes(workEndTime: string) {
  const now = new Date();

  const vietnamNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  const [hour, minute] = workEndTime.split(":").map(Number);

  const endTime = new Date(vietnamNow);
  endTime.setHours(hour, minute, 0, 0);

  // 퇴근 기준 시간이 새벽이면 다음날 기준으로 보정
  if (hour < 12 && vietnamNow.getHours() >= 12) {
    endTime.setDate(endTime.getDate() + 1);
  }

  const diffMinutes = Math.floor(
    (endTime.getTime() - vietnamNow.getTime()) / 1000 / 60
  );

  return Math.max(0, diffMinutes);
}

function getAutoCheckOutType(workEndTime: string): "done" | "early_leave" {
  const earlyLeaveMinutes = calculateEarlyLeaveMinutes(workEndTime);

  return earlyLeaveMinutes >= 90 ? "early_leave" : "done";
}

function isApprovedLeave(record: any) {
  return record?.status === "leave" && record?.approval_status === "approved";
}

function calculateMonthSummary(records: any[]) {
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
    (sum, record) => sum + Number(record.early_leave_minutes || 0),
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
      (r) =>
        r.status === "early_leave" ||
        Number(r.early_leave_minutes || 0) > 0
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


function getVietnamWorkDate() {
  const now = new Date();

  const vietnamTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  // 새벽 3시 전이면 전날 영업일로 처리
  if (vietnamTime.getHours() < 3) {
    vietnamTime.setDate(vietnamTime.getDate() - 1);
  }

  const year = vietnamTime.getFullYear();
  const month = String(vietnamTime.getMonth() + 1).padStart(2, "0");
  const day = String(vietnamTime.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}



function getStatusLabel(
  lang: "ko" | "vi",
  status: AttendanceStatus,
  t: (typeof attendanceText)["ko"] | (typeof attendanceText)["vi"]
) {
  if (status === "before") return t.statusBefore;
  if (status === "done") return t.statusDone;
  if (status === "early_leave") {
    return lang === "vi" ? "Về sớm" : "조퇴";
  }

  if (status === "leave") {
    return lang === "vi" ? "Nghỉ" : "휴무";
  }

  return t.statusWorking;
}

export default function AttendancePage() {
  const { lang } = useLanguage();
  const t = attendanceText[lang];
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
  const t = attendanceText[lang];
  const [isSubmittingAttendance, setIsSubmittingAttendance] = useState(false);

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
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0);

  useEffect(() => {
    fetchTodayAttendance();
    fetchMonthSummary();
  }, []);

  const fetchTodayAttendance = async () => {
    setIsLoadingToday(true);

    try {
      const user = getUser();
      if (!user?.id) return;

      const workDate = getVietnamWorkDate();

      const { data, error } = await supabase
        .from("attendance_records")
        .select("*")
        .eq("user_id", user.id)
        .eq("work_date", workDate)
        .maybeSingle();

      if (error) {
        console.log("fetch today attendance error:", JSON.stringify(error, null, 2));
        return;
      }

      if (!data) {
        setAttendance(initialAttendanceState);
        return;
      }

      if (data.status === "leave" && !isApprovedLeave(data)) {
        setAttendance(initialAttendanceState);
        return;
      }

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

  const fetchMonthSummary = async () => {
    const user = getUser();
    if (!user?.id) return;

    const now = new Date();

    const vietnamDate = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
    );

    const year = vietnamDate.getFullYear();
    const month = vietnamDate.getMonth() + 1;

    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const { data, error } = await supabase
      .from("attendance_records")
      .select("*")
      .eq("user_id", user.id)
      .gte("work_date", start)
      .lte("work_date", end);

    if (error) {
      console.log("fetch month summary error:", JSON.stringify(error, null, 2));
      return;
    }

    const monthSummary = calculateMonthSummary(data || []);

    setAttendance((prev) => ({
      ...prev,
      monthSummary,
    }));
  };

  const handleCheckIn = async () => {
    if (isSubmittingAttendance) return;
    if (isLoadingToday) return;
    if (attendance.status !== "before") return;
    if (attendance.checkInTime !== "-") return;

    setIsSubmittingAttendance(true);

    const user = getUser();

    if (!user?.id) {
      alert(lang === "vi" ? "Không tìm thấy người dùng." : "사용자 정보를 찾을 수 없습니다.");
      setIsSubmittingAttendance(false);
      return;
    }

    let latitude: number | null = null;
    let longitude: number | null = null;
    let distanceM: number | null = null;
    let isLocationValid = false;

    try {
      const position = await getCurrentPosition();

      latitude = position.coords.latitude;
      longitude = position.coords.longitude;

      distanceM = getDistanceMeters(latitude, longitude, STORE_LAT, STORE_LNG);
      isLocationValid = distanceM <= ALLOWED_DISTANCE_M;

      if (!isLocationValid) {
        alert(
          lang === "vi"
            ? `Bạn đang ở ngoài phạm vi chấm công. Khoảng cách hiện tại: ${distanceM}m`
            : `출근 가능 범위를 벗어났습니다. 현재 거리: ${distanceM}m`
        );
        return;
      }

      const res = await fetch("/api/attendance/check-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: user.id,
          user_name: user.name || user.full_name || "",
          username: user.username || "",
          language: lang,
          latitude,
          longitude,
          distance_m: distanceM,
          is_location_valid: isLocationValid,
        }),
      });

      const result = await res.json();

      if (!res.ok || !result.ok) {
        alert(result.message || (lang === "vi" ? "Không thể ghi nhận giờ vào." : "출근 기록에 실패했습니다."));
        return;
      }

      const data = result.record;

      setAttendance((prev) => ({
        ...prev,
        status: data.status || "working",
        checkInTime: data.check_in_at ? formatTimeForDisplay(data.check_in_at) : "-",
        checkOutTime: "-",
        workDuration: "00:00",
        lateMinutes: data.late_minutes || 0,
        earlyLeaveMinutes: data.early_leave_minutes || 0,
      }));

      await fetchMonthSummary();
      setCalendarRefreshKey((prev) => prev + 1);
    } catch (error) {
      console.error(error);

      alert(
        lang === "vi"
          ? "Không thể lấy vị trí GPS. Vui lòng bật quyền vị trí."
          : "GPS 위치를 가져올 수 없습니다. 위치 권한을 허용해주세요."
      );
    } finally {
      setIsSubmittingAttendance(false);
    }
  };


  const handleCheckOutClick = () => {
    if (attendance.status !== "working") return;

    const user = getUser();
    const type = getAutoCheckOutType(user?.work_end_time || "01:00");

    handleConfirmCheckOut(type);
  };

  const handleConfirmCheckOut = async (type: "done" | "early_leave") => {
    if (isSubmittingAttendance) return;

    setIsSubmittingAttendance(true);

    const user = getUser();

    if (!user?.id) {
      alert(lang === "vi" ? "Không tìm thấy người dùng." : "사용자 정보를 찾을 수 없습니다.");
      setIsSubmittingAttendance(false);
      return;
    }

    let latitude: number | null = null;
    let longitude: number | null = null;
    let distanceM: number | null = null;
    let isLocationValid = false;

    try {
      const position = await getCurrentPosition();

      latitude = position.coords.latitude;
      longitude = position.coords.longitude;

      distanceM = getDistanceMeters(latitude, longitude, STORE_LAT, STORE_LNG);
      isLocationValid = distanceM <= ALLOWED_DISTANCE_M;

      if (!isLocationValid) {
        alert(
          lang === "vi"
            ? `Bạn đang ở ngoài phạm vi chấm công. Khoảng cách hiện tại: ${distanceM}m`
            : `퇴근 가능 범위를 벗어났습니다. 현재 거리: ${distanceM}m`
        );
        return;
      }

      const res = await fetch("/api/attendance/check-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: user.id,
          user_name: user.name || user.full_name || "",
          username: user.username || "",
          language: lang,
          latitude,
          longitude,
          distance_m: distanceM,
          is_location_valid: isLocationValid,
        }),
      });

      const result = await res.json();

      if (!res.ok || !result.ok) {
        alert(result.message || (lang === "vi" ? "Không thể ghi nhận giờ ra." : "퇴근 기록에 실패했습니다."));
        return;
      }

      const data = result.record;

      setAttendance((prev) => ({
        ...prev,
        status: data.status || "done",
        checkOutTime: data.check_out_at ? formatTimeForDisplay(data.check_out_at) : "-",
        workDuration: formatMinutesToHHMM(data.work_minutes || 0),
        earlyLeaveMinutes: data.early_leave_minutes || 0,
      }));

      await fetchMonthSummary();
      setCalendarRefreshKey((prev) => prev + 1);
    } catch (error) {
      console.error(error);

      alert(
        lang === "vi"
          ? "Không thể lấy vị trí GPS. Vui lòng bật quyền vị trí."
          : "GPS 위치를 가져올 수 없습니다. 위치 권한을 허용해주세요."
      );
    } finally {
      setIsSubmittingAttendance(false);
    }
  };

  const isBefore = attendance.status === "before";
  const isWorking = attendance.status === "working";
  const isEarlyLeave = attendance.status === "early_leave";

  const checkInDisabled =
    isLoadingToday ||
    isSubmittingAttendance ||
    attendance.status !== "before" ||
    attendance.checkInTime !== "-";

  const checkOutDisabled =
    isLoadingToday ||
    isSubmittingAttendance ||
    attendance.status !== "working";

  const lateDisplayText =
    attendance.lateMinutes > 0
      ? t.lateText.replace("{minutes}", String(attendance.lateMinutes))
      : lang === "vi"
        ? "Đúng giờ"
        : "정상";

  const lateDisplayColor = attendance.lateMinutes > 0 ? "#f59e0b" : "#10b981";

  return (
    <div style={sectionStyle}>
      <div style={cardStyle}>
        <div style={todayHeaderRow}>
          <div style={statusBadgeStyle(attendance.status)}>
            ● {getStatusLabel(lang, attendance.status, t)}
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

          <TodayInfoBlock label={t.summaryLate}>
            <span style={{ color: lateDisplayColor }}>{lateDisplayText}</span>
          </TodayInfoBlock>

          <div style={todayStatusDivider} />

          <TodayInfoBlock
            label={t.workDurationLabel}
            subValue={
              isEarlyLeave
                ? lang === "vi"
                  ? `Về sớm ${attendance.earlyLeaveMinutes} phút`
                  : `조퇴 ${attendance.earlyLeaveMinutes}분`
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
                {isLoadingToday ? (lang === "vi" ? "Đang tải" : "불러오는 중") : t.checkInButton}
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
                {isLoadingToday ? (lang === "vi" ? "Đang tải" : "불러오는 중") : t.checkOutButton}
              </div>
              <div style={actionButtonSubDark}>{t.checkOutButtonDesc}</div>
            </div>
          </button>
        </div>
      </div>

      <Calendar refreshKey={calendarRefreshKey} />

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
            label={t.summaryLate}
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
            label={t.summaryEarlyLeave}
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
            label={t.summaryLeave}
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

function Calendar({ refreshKey }: { refreshKey: number }) {
  const { lang } = useLanguage();
  const t = attendanceText[lang];
  const [calendarDate, setCalendarDate] = useState(new Date());
  const calendarCells = getCalendarCells(calendarDate);

  const [monthRecords, setMonthRecords] = useState<any[]>([]);

  useEffect(() => {
    fetchMonthAttendance();
  }, [refreshKey, calendarDate]);

  const fetchMonthAttendance = async () => {
    const user = getUser();
    if (!user?.id) return;

    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth() + 1;

    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const { data, error } = await supabase
      .from("attendance_records")
      .select("*")
      .eq("user_id", user.id)
      .gte("work_date", start)
      .lte("work_date", end);

    if (error) {
      console.log("fetch month attendance error:", JSON.stringify(error, null, 2));
      return;
    }

    setMonthRecords(data || []);
  };

  const getDayRecord = (day: number) => {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth() + 1;

    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    return monthRecords.find((r) => r.work_date === dateStr);
  };

  return (
    <div style={cardStyle}>
      <div style={calendarHeaderRow}>
        <div style={calendarTitleWrap}>
          <button
            type="button"
            style={calendarMonthButtonStyle}
            onClick={() =>
              setCalendarDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
            }
          >
            ‹
          </button>

          <div style={calendarTitle}>{formatCalendarTitle(lang, calendarDate)}</div>

          <button
            type="button"
            style={calendarMonthButtonStyle}
            onClick={() =>
              setCalendarDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
            }
          >
            ›
          </button>
        </div>

        <div style={calendarLegendStyle}>
          <LegendItem label={t.legendNormal} color="#10b981" />
          <LegendItem label={t.legendLate} color="#f59e0b" />
          <LegendItem label={t.legendEarlyLeave} color="#ef4444" />
          <LegendItem label={t.legendLeave} color="#6b7280" />
        </div>
      </div>

      <div style={calendarWrapStyle}>
        <div style={weekHeaderGridStyle}>
          {t.calendarWeekdays.map((day) => (
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

            if (record?.status === "early_leave") {
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

                {!isMuted && record && (record.status !== "leave" || isApprovedLeave(record)) && (
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
    working: {
      background: "#dcfce7",
      color: "#16a34a",
      border: "#bbf7d0",
    },
    done: {
      background: "#e5e7eb",
      color: "#374151",
      border: "#d1d5db",
    },
    early_leave: {
      background: "#fee2e2",
      color: "#dc2626",
      border: "#fecaca",
    },
    leave: {
      background: "#f3f4f6",
      color: "#374151",
      border: "#d1d5db",
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

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(17, 24, 39, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  zIndex: 1000,
};

const modalCardStyle: CSSProperties = {
  width: "100%",
  maxWidth: 340,
  background: "#ffffff",
  borderRadius: 16,
  padding: 16,
  boxShadow: "0 20px 50px rgba(0,0,0,0.18)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const modalTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
  lineHeight: 1.3,
};

const modalDescStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#6b7280",
  lineHeight: 1.4,
};

const modalButtonGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 8,
};

const modalPrimaryButtonStyle: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: "1px solid #111827",
  background: "#111827",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

const modalSecondaryButtonStyle: CSSProperties = {
  height: 42,
  borderRadius: 12,
  border: "1px solid #111827",
  background: "#ffffff",
  color: "#111827",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

const modalCloseButtonStyle: CSSProperties = {
  height: 38,
  borderRadius: 12,
  border: "1px solid #d1d5db",
  background: "#f9fafb",
  color: "#6b7280",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};