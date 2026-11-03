"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { commonText, attendanceText } from "@/lib/text";
import { getPartMeta, getPartKey } from "@/lib/common/parts";
import { getEmployeeRoleLabel, getEmployeeRoleRank } from "@/lib/common/roles";
import { attendanceFetch } from "@/lib/auth/client-session";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";
import { getNextLevelSchedule } from "@/lib/employee-level/next-level-schedule";
import { employeeLevelScheduleText } from "@/lib/text/employee-level-schedule";
import AttendanceBonusProgressBadge from "@/components/attendance/AttendanceBonusProgressBadge";
import { invalidateMonthlyAttendanceSummary, useMonthlyAttendanceSummary } from "@/components/attendance/useMonthlyAttendanceSummary";
import {
    ATTENDANCE_STATUS_COLORS,
    getVietnamDateKey,
} from "@/lib/attendance/display-status";
import { getAttendanceMonthCells, getAttendanceCalendarStatus, type AttendanceCalendarStatus } from "@/lib/attendance/month-calendar";


import type { EarlyLeaveReviewContext } from "@/lib/attendance/early-leave-review-server";
import type { EarlyLeaveDisplayContext } from "@/lib/attendance/early-leave-display-context";
import { formatVietnamTime } from "@/lib/common/business-time";
import type { EarlyLeaveSelection } from "@/lib/attendance/early-leave-review";

type EarlyLeaveReviewRecord = EarlyLeaveReviewContext & EarlyLeaveDisplayContext & {user: UnresolvedOpenRecordUser | null};

type UserRow = {
    id: number;
    name: string;
    username: string;
    role: string | null;
    part: string | null;
    position: string | null;
    birth_date: string | null;
    work_start_time: string | null;
    work_end_time: string | null;
    is_active: boolean;
    levelInfo: EmployeeLevelInfo;
};

function formatWorkClock(value: string | null) {
    const match = value?.match(/^(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : null;
}

function formatWorkHours(user: Pick<UserRow, "work_start_time" | "work_end_time">) {
    const start = formatWorkClock(user.work_start_time);
    const end = formatWorkClock(user.work_end_time);
    return start && end ? `${start}~${end}` : "-";
}

type AttendanceRecord = {
    id: number;
    user_id: number;
    work_date: string;
    status: string;
    check_in_at: string | null;
    check_out_at: string | null;
    late_minutes: number | null;
    early_leave_minutes: number | null;
    work_minutes: number | null;
    approval_status: "pending" | "approved" | null;
};

type UnresolvedOpenRecordUser = {
    id: number;
    username: string | null;
    name: string | null;
    is_active: boolean | null;
};

type UnresolvedOpenRecord = {
    id: number;
    user_id: number;
    work_date: string;
    check_in_at: string;
    auto_close_at: string;
    admin_review_at: string;
    user: UnresolvedOpenRecordUser | null;
};

function getMonthRange(month: Date) {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();

    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 0);

    const startText = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
    const endText = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

    return { startText, endText };
}

function getMonthFromParam(monthParam: string | null) {
    if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) return new Date();

    const [year, month] = monthParam.split("-").map(Number);
    if (year < 2000 || year > 2100 || month < 1 || month > 12) return new Date();

    return new Date(year, month - 1, 1);
}

function formatMonth(month: Date, monthFormat: string) {
    const year = String(month.getFullYear()).slice(2);
    const monthNumber = String(month.getMonth() + 1);

    return monthFormat
        .replace("{year}", year)
        .replace("{month}", monthNumber);
}

function getAge(birthDate?: string | null) {
    if (!birthDate) return null;

    const birth = new Date(birthDate);
    if (Number.isNaN(birth.getTime())) return null;

    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
        age -= 1;
    }

    return age;
}

function formatMinutes(
    minutes: number,
    c: { hour: string; minute: string }
) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;

    if (h <= 0) return `${m}${c.minute}`;
    if (m <= 0) return `${h}${c.hour}`;
    return `${h}${c.hour} ${m}${c.minute}`;
}

function formatCheckInTime(isoTime: string) {
    return new Date(isoTime).toLocaleTimeString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

function getUnresolvedDisplayName(
    record: UnresolvedOpenRecord,
    t: (typeof attendanceText)["ko"] | (typeof attendanceText)["vi"]
) {
    if (!record.user) {
        return t.orphanRecordLabel.replace("{id}", String(record.user_id));
    }

    const baseName = record.user.name || record.user.username || `#${record.user_id}`;

    if (record.user.is_active === false) {
        return `${baseName} · ${t.inactiveUserSuffix}`;
    }

    return baseName;
}

function formatElapsedSince(
    isoTime: string,
    c: { days: string; hour: string; minute: string }
) {
    const minutes = Math.max(
        0,
        Math.floor((Date.now() - new Date(isoTime).getTime()) / 60000)
    );

    const days = Math.floor(minutes / (60 * 24));
    const hours = Math.floor((minutes % (60 * 24)) / 60);

    if (days > 0) return `${days}${c.days} ${hours}${c.hour}`;
    return formatMinutes(minutes, c);
}

export default function AttendanceOverviewPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { lang } = useLanguage();
    const c = commonText[lang];
    const t = attendanceText[lang];

    const [currentMonth, setCurrentMonth] = useState(() =>
        getMonthFromParam(searchParams.get("month"))
    );
    const selectedMonthKey = `${currentMonth.getFullYear()}-${String(currentMonth.getMonth()+1).padStart(2,"0")}`;
    const perfectSummary = useMonthlyAttendanceSummary(selectedMonthKey);
    const [users, setUsers] = useState<UserRow[]>([]);
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [reviewError, setReviewError] = useState(false);
    const [unresolvedOpenRecords, setUnresolvedOpenRecords] = useState<UnresolvedOpenRecord[]>([]);
    const [isUnresolvedOpen, setIsUnresolvedOpen] = useState(false);
    const [earlyLeaveReviewRecords, setEarlyLeaveReviewRecords] = useState<EarlyLeaveReviewRecord[]>([]);
    const [isEarlyLeaveReviewOpen, setIsEarlyLeaveReviewOpen] = useState(false);
    const [processingRecordId, setProcessingRecordId] = useState<number | null>(null);
    const [processingAction, setProcessingAction] = useState<"auto" | "delete" | null>(null);
    const monthlyOverviewRequestRef = useRef(0);
    const earlyLeaveResolutionRef = useRef(false);
    const reviewRequestRef = useRef(0);

    const fetchUnresolvedOpenRecords = useCallback(async () => {
        const requestId = ++reviewRequestRef.current;
        try {
            const res = await attendanceFetch("/api/attendance/admin");

            const result = await res.json();

            if (!res.ok || !result.ok) {
                throw new Error("ATTENDANCE_REVIEW_READ_FAILED");
            }
            if (requestId !== reviewRequestRef.current) return false;

            setUnresolvedOpenRecords((result.unresolvedOpenRecords || []) as UnresolvedOpenRecord[]);
            setEarlyLeaveReviewRecords((result.earlyLeaveReviewRecords || []) as EarlyLeaveReviewRecord[]);
            setReviewError(false);
            return true;
        } catch {
            if (requestId === reviewRequestRef.current) setReviewError(true);
            return false;
        }
    }, []);

    const fetchMonthlyOverview = useCallback(async () => {
        const requestId = ++monthlyOverviewRequestRef.current;
        setIsLoading(true);
        setLoadError(false);

        try {
            const { startText } = getMonthRange(currentMonth);
            const month = startText.slice(0, 7);
            const [userRes, recordRes] = await Promise.all([
                attendanceFetch(`/api/attendance/users?mode=month&month=${month}`),
                attendanceFetch(`/api/attendance/records?scope=admin_overview&month=${month}`),
            ]);
            const [userResult, recordResult] = await Promise.all([
                userRes.json(),
                recordRes.json(),
            ]);

            if (!userRes.ok || !userResult.ok) {
                throw new Error("ATTENDANCE_USERS_READ_FAILED");
            }
            if (!recordRes.ok || !recordResult.ok) {
                throw new Error("ATTENDANCE_RECORDS_READ_FAILED");
            }
            if (requestId !== monthlyOverviewRequestRef.current) return false;

            const userData = (userResult.users || []) as UserRow[];
            const recordData = recordResult.records || [];
            setUsers(userData.filter((user) => !isAdmin(user)));
            setRecords(recordData);
            return true;
        } catch {
            if (requestId === monthlyOverviewRequestRef.current) setLoadError(true);
            return false;
        } finally {
            if (requestId === monthlyOverviewRequestRef.current) {
                setIsLoading(false);
            }
        }
    }, [currentMonth]);

    useEffect(() => {
        const loginUser = getUser();
        if (!isAdmin(loginUser)) {
            window.location.href = "/attendance";
            return;
        }
        void fetchUnresolvedOpenRecords();
        const refreshReviewBanners = () => { if (!earlyLeaveResolutionRef.current) void fetchUnresolvedOpenRecords(); };
        window.addEventListener("focus", refreshReviewBanners);
        return () => { reviewRequestRef.current += 1; window.removeEventListener("focus", refreshReviewBanners); };
    }, [fetchUnresolvedOpenRecords]);

    useEffect(() => {
        if (!isAdmin(getUser())) return;
        void fetchMonthlyOverview();
        return () => {
            monthlyOverviewRequestRef.current += 1;
        };
    }, [fetchMonthlyOverview]);

    const refreshAfterSave = async (workDate: string) => {
        invalidateMonthlyAttendanceSummary(workDate.slice(0, 7));
        const refreshed = await Promise.all([fetchUnresolvedOpenRecords(), fetchMonthlyOverview()]);
        if (refreshed.some(value => !value)) alert(lang === "vi"
            ? "Đã lưu. Không thể tải lại dữ liệu; vui lòng thử tải lại."
            : "저장은 완료됐지만 재조회에 실패했습니다. 다시 조회해주세요.");
    };

    const handleResolveEarlyLeave = async (recordId: number, selection: EarlyLeaveSelection) => {
        if (isLoading || earlyLeaveResolutionRef.current || processingRecordId !== null) return;
        earlyLeaveResolutionRef.current = true;
        monthlyOverviewRequestRef.current += 1;
        reviewRequestRef.current += 1;
        setProcessingRecordId(recordId);
        try {
            const response = await attendanceFetch("/api/attendance/admin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "resolve_early_leave", attendance_id: recordId, selection, lang }),
            });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.message || t.correctionFailed);
            setEarlyLeaveReviewRecords((current) => current.filter((record) => record.id !== recordId));
            await refreshAfterSave(earlyLeaveReviewRecords.find(record => record.id === recordId)?.work_date || `${selectedMonthKey}-01`);
        } catch (error) {
            alert(error instanceof Error ? error.message : t.correctionFailed);
        } finally {
            earlyLeaveResolutionRef.current = false;
            setProcessingRecordId(null);
        }
    };

    const handleAutoCorrect = async (record: UnresolvedOpenRecord) => {
        if (isLoading || earlyLeaveResolutionRef.current) return;
        const autoCloseTime = formatCheckInTime(record.auto_close_at);
        if (!window.confirm(t.unresolvedOpenRecordAutoConfirm.replace("{time}", autoCloseTime))) return;
        earlyLeaveResolutionRef.current = true;
        monthlyOverviewRequestRef.current += 1;
        reviewRequestRef.current += 1;

        setProcessingRecordId(record.id);
        setProcessingAction("auto");

        try {
            const res = await attendanceFetch("/api/attendance/admin", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "auto_close_missing_checkout",
                    attendance_id: record.id,
                    user_id: record.user_id,
                    work_date: record.work_date,
                    lang,
                }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                alert(result.message || t.unresolvedOpenRecordAutoFailed);
                return;
            }

            setUnresolvedOpenRecords((prev) => prev.filter((item) => item.id !== record.id));
            await refreshAfterSave(record.work_date);
        } catch (err) {
            console.error(err);
            alert(t.unresolvedOpenRecordAutoFailed);
        } finally {
            earlyLeaveResolutionRef.current = false;
            setProcessingRecordId(null);
            setProcessingAction(null);
        }
    };

    const handleDeleteOrphan = async (record: UnresolvedOpenRecord) => {
        if (isLoading || earlyLeaveResolutionRef.current) return;
        if (!window.confirm(t.orphanRecordDeleteConfirm)) return;
        earlyLeaveResolutionRef.current = true;
        monthlyOverviewRequestRef.current += 1;
        reviewRequestRef.current += 1;

        setProcessingRecordId(record.id);
        setProcessingAction("delete");

        try {
            const res = await attendanceFetch("/api/attendance/admin", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "delete_orphan_record",
                    attendance_id: record.id,
                    user_id: record.user_id,
                    work_date: record.work_date,
                    lang,
                }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                alert(result.message || t.orphanRecordDeleteFailed);
                return;
            }

            setUnresolvedOpenRecords((prev) => prev.filter((item) => item.id !== record.id));
            await refreshAfterSave(record.work_date);
        } catch (err) {
            console.error(err);
            alert(t.orphanRecordDeleteFailed);
        } finally {
            earlyLeaveResolutionRef.current = false;
            setProcessingRecordId(null);
            setProcessingAction(null);
        }
    };

    const recordsByUser = useMemo(() => {
        const map = new Map<number, AttendanceRecord[]>();

        records.forEach((record) => {
            const key = record.user_id;
            const userRecords = map.get(key);
            if (userRecords) userRecords.push(record);
            else map.set(key, [record]);
        });

        return map;
    }, [records]);

    const monthCells = useMemo(() => getAttendanceMonthCells(selectedMonthKey), [selectedMonthKey]);
    const vietnamToday = getVietnamDateKey();
    const calendarLabels: Record<AttendanceCalendarStatus, string> = {
        normal: t.workNormal, late: t.workLate, early_leave: t.workEarlyLeave,
        approved_leave: t.workLeave, unauthorized_absence: t.unauthorizedAbsence,
        working: t.working, pending: t.approvalPending, none: t.noRecord, future: t.futureDate,
    };

    const summaries = useMemo(() => {

        return users.map((user) => {
            const userRecords = recordsByUser.get(user.id) || [];

            const workRecords = userRecords.filter((record) =>
                record.status !== "leave" &&
                (
                    ["working", "done", "early_leave"].includes(record.status) ||
                    !!record.check_in_at ||
                    !!record.check_out_at
                )
            );

            const approvedLeaveRecords = userRecords.filter((record) =>
                record.status === "leave" && record.approval_status === "approved"
            );

            const workDays = workRecords.length;

            const leaveDays = approvedLeaveRecords.length;

            const lateCount = workRecords.filter((record) =>
                Number(record.late_minutes || 0) > 0
            ).length;

            const earlyLeaveCount = workRecords.filter((record) =>
                record.status === "early_leave" || Number(record.early_leave_minutes || 0) > 0
            ).length;

            return {
                user,
                workDays,
                leaveDays,
                lateCount,
                earlyLeaveCount,
            };
        });
    }, [users, recordsByUser]);

    const groupedSummaries = useMemo(() => {
        const groupMap = new Map<string, typeof summaries>();

        summaries.forEach((summary) => {
            const partKey = getPartKey(summary.user.part);
            const prev = groupMap.get(partKey) || [];
            groupMap.set(partKey, [...prev, summary]);
        });

        return Array.from(groupMap.entries())
            .map(([part, groupSummaries]) => ({
                part,
                meta: getPartMeta(part),
                summaries: groupSummaries.sort((a, b) => {
                    const rankDiff = getEmployeeRoleRank(a.user.role) - getEmployeeRoleRank(b.user.role);
                    if (rankDiff !== 0) return rankDiff;
                    return a.user.name.localeCompare(b.user.name);
                }),
            }))
            .sort((a, b) => {
                const rankDiff = a.meta.rank - b.meta.rank;
                if (rankDiff !== 0) return rankDiff;
                return a.part.localeCompare(b.part);
            });
    }, [summaries]);

    const moveMonth = (amount: number) => {
        if (earlyLeaveResolutionRef.current) return;
        monthlyOverviewRequestRef.current += 1;
        setIsLoading(true);
        setLoadError(false);
        setCurrentMonth((prev) => {
            return new Date(prev.getFullYear(), prev.getMonth() + amount, 1);
        });
        setExpandedUserId(null);
    };

    const goDetail = (userId: number) => {
        if (earlyLeaveResolutionRef.current) return;
        const year = currentMonth.getFullYear();
        const month = String(currentMonth.getMonth() + 1).padStart(2, "0");

        router.push(`/admin/payroll/attendance/${userId}?month=${year}-${month}`);
    };

    const goDetailForDate = (userId: number, workDate: string) => {
        if (earlyLeaveResolutionRef.current) return;
        const month = workDate.slice(0, 7);

        router.push(`/admin/payroll/attendance/${userId}?month=${month}&date=${workDate}`);
    };

    return (
        <Container noPaddingTop>
            <div style={monthHeaderStyle}>
                <button type="button" style={monthButtonStyle} disabled={processingRecordId !== null} onClick={() => moveMonth(-1)}>
                    ‹
                </button>

                <div style={monthTitleStyle}>{formatMonth(currentMonth, t.monthFormat)}</div>

                <button type="button" style={monthButtonStyle} disabled={processingRecordId !== null} onClick={() => moveMonth(1)}>
                    ›
                </button>
            </div>

            {reviewError && <div role="alert" style={emptyStyle}>
                <div>{lang === "vi" ? "Không thể tải dữ liệu cần kiểm tra." : "확인할 근태 기록을 불러오지 못했습니다."}</div>
                <button type="button" disabled={processingRecordId !== null} onClick={() => void fetchUnresolvedOpenRecords()}>{lang === "vi" ? "Thử lại" : "다시 조회"}</button>
            </div>}

            {earlyLeaveReviewRecords.length > 0 && (
                <div style={unresolvedBannerStyle}>
                    <button type="button" style={unresolvedBannerHeaderStyle} aria-expanded={isEarlyLeaveReviewOpen}
                        onClick={() => setIsEarlyLeaveReviewOpen(previous => !previous)}>
                        <span style={unresolvedBannerTitleStyle}>⚠ {t.earlyLeaveReviewBanner.replace("{count}", String(earlyLeaveReviewRecords.length))}</span>
                        <span style={unresolvedBannerChevronStyle}>{isEarlyLeaveReviewOpen ? "⌃" : "⌄"}</span>
                    </button>
                    {isEarlyLeaveReviewOpen && <div style={unresolvedListStyle}>
                        {earlyLeaveReviewRecords.map(record => <div key={record.id} style={unresolvedItemStyle}>
                            <div style={unresolvedItemTopRowStyle}>
                                <div style={earlyLeaveNameScheduleStyle}>
                                    <span style={unresolvedItemNameStyle}>{record.user?.name || record.user?.username || `#${record.user_id}`}</span>
                                    <span style={{ ...unresolvedItemMetaStyle, whiteSpace: "nowrap" }}>
                                        · {record.effectiveScheduleStart && record.effectiveScheduleEnd ? `${record.effectiveScheduleStart}~${record.effectiveScheduleEnd}` : "-"}
                                    </span>
                                </div>
                                <span style={unresolvedItemDateStyle}>{record.work_date}</span>
                            </div>
                            <div style={earlyLeaveCheckoutComparisonStyle}>
                                <span>{lang === "vi" ? "Tan ca" : "퇴근"} {formatVietnamTime(record.actualCheckOutAt)}</span>
                                <span>· {lang === "vi" ? "Tan ca trung bình" : "평균 퇴근"} {formatVietnamTime(record.peerAverageCheckOutAt)}</span>
                            </div>
                            <div style={earlyLeaveDecisionRowStyle} aria-busy={processingRecordId === record.id}>
                                <div style={earlyLeaveDecisionButtonsStyle}>
                                <button type="button" style={{ ...unresolvedDetailButtonStyle, opacity: processingRecordId !== null ? 0.6 : 1 }}
                                    disabled={processingRecordId !== null}
                                    aria-label={t.earlyLeaveUseRaw.replace("{minutes}", String(record.rawEarlyLeaveMinutes))}
                                    onClick={() => handleResolveEarlyLeave(record.id, "use_raw")}>
                                    {record.rawEarlyLeaveMinutes}{c.minute} {t.workEarlyLeave}
                                </button>
                                <button type="button" style={{ ...unresolvedDetailButtonStyle, opacity: processingRecordId !== null ? 0.6 : 1 }}
                                    disabled={processingRecordId !== null}
                                    aria-label={t.earlyLeaveUseEffective.replace("{minutes}", String(record.effectiveEarlyLeaveMinutes))}
                                    onClick={() => handleResolveEarlyLeave(record.id, "use_effective")}>
                                    {record.effectiveEarlyLeaveMinutes}{c.minute} {t.workEarlyLeave}
                                </button>
                                <button type="button" style={unresolvedDetailButtonStyle}
                                    onClick={() => goDetailForDate(record.user_id, record.work_date)}>{lang === "vi" ? "Xem chi tiết" : "상세보기"}</button>
                                </div>
                            </div>
                        </div>)}
                    </div>}
                </div>
            )}

            {unresolvedOpenRecords.length > 0 && (
                <div style={unresolvedBannerStyle}>
                    <button
                        type="button"
                        style={unresolvedBannerHeaderStyle}
                        onClick={() => setIsUnresolvedOpen((prev) => !prev)}
                    >
                        <span style={unresolvedBannerTitleStyle}>
                            ⚠ {t.unresolvedOpenRecordsBanner.replace(
                                "{count}",
                                String(unresolvedOpenRecords.length)
                            )}
                        </span>
                        <span style={unresolvedBannerChevronStyle}>
                            {isUnresolvedOpen ? "⌃" : "⌄"}
                        </span>
                    </button>

                    {isUnresolvedOpen && (
                        <div style={unresolvedListStyle}>
                            {unresolvedOpenRecords.map((record) => {
                                const isOrphan = record.user === null;
                                const isInactive = record.user?.is_active === false;
                                const isAutoProcessing =
                                    processingRecordId === record.id && processingAction === "auto";
                                const isDeleteProcessing =
                                    processingRecordId === record.id && processingAction === "delete";
                                const isAnyProcessing = processingRecordId === record.id;

                                return (
                                    <div key={record.id} style={unresolvedItemStyle}>
                                        <div style={unresolvedItemTopRowStyle}>
                                            <span
                                                style={{
                                                    ...unresolvedItemNameStyle,
                                                    color: isOrphan || isInactive ? "#9ca3af" : unresolvedItemNameStyle.color,
                                                }}
                                            >
                                                {getUnresolvedDisplayName(record, t)}
                                            </span>
                                            <span style={unresolvedItemDateStyle}>{record.work_date}</span>
                                        </div>

                                        <div style={unresolvedItemBottomRowStyle}>
                                            <span style={unresolvedItemMetaStyle}>
                                                {formatCheckInTime(record.check_in_at)}
                                                {" · "}
                                                {isOrphan
                                                    ? t.orphanRecordNoLinkInfo
                                                    : t.unresolvedOpenRecordElapsed.replace(
                                                        "{duration}",
                                                        formatElapsedSince(record.check_in_at, c)
                                                    )}
                                            </span>

                                            {!isOrphan && (
                                                <span style={unresolvedAutoTargetStyle}>
                                                    {t.unresolvedOpenRecordAutoTarget.replace(
                                                        "{time}",
                                                        formatCheckInTime(record.auto_close_at)
                                                    )}
                                                </span>
                                            )}

                                            <div style={unresolvedItemButtonsRowStyle}>
                                                {isOrphan ? (
                                                    <button
                                                        type="button"
                                                        style={{
                                                            ...unresolvedDeleteButtonStyle,
                                                            opacity: isAnyProcessing ? 0.6 : 1,
                                                            cursor: isAnyProcessing ? "not-allowed" : "pointer",
                                                        }}
                                                        disabled={isAnyProcessing}
                                                        onClick={() => handleDeleteOrphan(record)}
                                                    >
                                                        {isDeleteProcessing
                                                            ? t.orphanRecordDeleting
                                                            : t.orphanRecordDeleteButton}
                                                    </button>
                                                ) : (
                                                    <>
                                                        <button
                                                            type="button"
                                                            style={{
                                                                ...unresolvedDetailButtonStyle,
                                                                opacity: isAnyProcessing ? 0.6 : 1,
                                                                cursor: isAnyProcessing ? "not-allowed" : "pointer",
                                                            }}
                                                            disabled={isAnyProcessing}
                                                            onClick={() => goDetailForDate(record.user_id, record.work_date)}
                                                        >
                                                            {t.unresolvedOpenRecordDetailButton}
                                                        </button>

                                                        <button
                                                            type="button"
                                                            style={{
                                                                ...unresolvedAutoButtonStyle,
                                                                opacity: isAnyProcessing ? 0.6 : 1,
                                                                cursor: isAnyProcessing ? "not-allowed" : "pointer",
                                                            }}
                                                            disabled={isAnyProcessing}
                                                            onClick={() => handleAutoCorrect(record)}
                                                        >
                                                            {isAutoProcessing
                                                                ? t.unresolvedOpenRecordAutoProcessing
                                                                : t.unresolvedOpenRecordAutoButton}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            <div style={sectionStyle}>
                {loadError ? (
                    <div role="alert" style={emptyStyle}>
                        <div>{lang === "vi" ? "Không thể tải danh sách nhân viên hoặc dữ liệu chấm công." : "직원 목록 또는 근태 기록을 불러오지 못했습니다."}</div>
                        <button type="button" disabled={isLoading || processingRecordId !== null} onClick={() => void fetchMonthlyOverview()}>{lang === "vi" ? "Thử lại" : "다시 조회"}</button>
                    </div>
                ) : isLoading ? (
                    <div style={emptyStyle}>{c.loading}</div>
                ) : groupedSummaries.length === 0 ? (
                    <div style={emptyStyle}>{c.noData}</div>
                ) : (
                    groupedSummaries.map((group) => (
                        <div key={group.part} style={partGroupStyle}>
                            <div
                                style={{
                                    ...partTitleStyle,
                                    color: group.meta.color,
                                    background: group.meta.bg,
                                    borderLeft: `4px solid ${group.meta.border}`,
                                }}
                            >
                                <span>{group.meta.emoji}</span>
                                <span>{c[group.part as keyof typeof c] || group.meta.label}</span>
                                <span style={partCountStyle}>{group.summaries.length}</span>
                            </div>

                            <div style={partListStyle}>
                                {group.summaries.map((summary) => {
                                    const user = summary.user;
                                    const isExpanded = expandedUserId === user.id;
                                    const age = getAge(user.birth_date);
                                    const userRecords = recordsByUser.get(user.id) || [];
                                    const recordsByDate = isExpanded
                                        ? new Map(userRecords.map((record) => [record.work_date, record]))
                                        : null;
                                    const nextLevel = getNextLevelSchedule(user.levelInfo, vietnamToday);
                                    const nextLevelMessage = nextLevel?.status === "future"
                                        ? employeeLevelScheduleText[lang].future
                                            .replace("{date}", nextLevel.date.replaceAll("-", "."))
                                            .replace("{days}", String(nextLevel.days))
                                        : nextLevel?.status === "today"
                                            ? employeeLevelScheduleText[lang].today
                                            : nextLevel?.status === "maximum"
                                                ? employeeLevelScheduleText[lang].maximum
                                                : null;

                                    return (
                                        <div key={user.id} style={staffCardStyle}>
                                            <button
                                                type="button"
                                                onClick={() => setExpandedUserId(isExpanded ? null : user.id)}
                                                style={staffSummaryButtonStyle}
                                                aria-expanded={isExpanded}
                                            >
                                                <div style={staffLeftStyle}>
                                                    <EmployeeNameWithLevel name={`${user.name}${age ? ` (${age})` : ""}`} levelInfo={user.levelInfo} lang={lang} nameStyle={staffNameStyle} showDisabledBadge />
                                                    <AttendanceBonusProgressBadge eligible={perfectSummary.get(user.id)?.attendanceBonusEligible===true} perfectAttendanceCurrent={perfectSummary.get(user.id)?.perfectAttendanceCurrent===true} vi={lang==="vi"}/>
                                                    <span style={staffSeparatorStyle}>·</span>
                                                    <span style={staffMetaStyle}>
                                                        {user.role ? getEmployeeRoleLabel(user.role, lang) : user.username}
                                                    </span>
                                                </div>

                                                <div style={staffStatsStyle}>
                                                    <IconStat icon="📅" label={t.summaryWorkDays} value={summary.workDays} />
                                                    <IconStat icon="🌴" label={t.workLeave} value={summary.leaveDays} />
                                                    {summary.lateCount > 0 && (
                                                        <IconStat icon="⏰" label={t.workLate} value={summary.lateCount} />
                                                    )}
                                                    {summary.earlyLeaveCount > 0 && (
                                                        <IconStat icon="🏃" label={t.workEarlyLeave} value={summary.earlyLeaveCount} />
                                                    )}
                                                </div>

                                                <span style={expandIconStyle} aria-hidden="true">{isExpanded ? "⌃" : "⌄"}</span>
                                            </button>

                                            {isExpanded && (
                                                <div style={recentAttendanceStyle}>
                                                    <div style={recentTitleRowStyle}>
                                                        <span style={recentTitleStyle}>{t.monthlyAttendance}</span>
                                                        <span style={recentTitleStyle}>{formatWorkHours(user)}</span>
                                                    </div>
                                                    <div style={recentWeekdayGridStyle}>
                                                        {c.calendarWeekdays.map((weekday, weekdayIndex) => {
                                                            return (
                                                                <span
                                                                    key={weekdayIndex}
                                                                    style={{
                                                                        ...recentWeekdayStyle,
                                                                        color: weekdayIndex === 0
                                                                            ? "#dc2626"
                                                                            : weekdayIndex === 6
                                                                                ? "#2563eb"
                                                                                : "#6b7280",
                                                                    }}
                                                                >
                                                                    {weekday}
                                                                </span>
                                                            );
                                                        })}
                                                    </div>
                                                    <div style={recentGridStyle} role="group" aria-label={`${user.name} ${selectedMonthKey} ${t.monthlyAttendance}`}>
                                                        {monthCells.map((dateKey, index) => {
                                                            if (!dateKey) return <span key={`blank-${index}`} aria-hidden="true" style={recentDayStyle} />;
                                                            const record = recordsByDate?.get(dateKey);
                                                            const status = getAttendanceCalendarStatus(record, dateKey, vietnamToday);
                                                            const isWorking = !!record?.check_in_at && !record.check_out_at && record.status !== "leave" && record.status !== "unauthorized_absence";
                                                            const isFuture = dateKey > vietnamToday;
                                                            const label = [calendarLabels[status],
                                                                isWorking && status !== "working" ? t.working : null,
                                                                isFuture && status !== "future" ? t.futureDate : null,
                                                            ].filter(Boolean).join(" · ");

                                                            return (
                                                                <button key={dateKey} type="button" style={recentDayStyle}
                                                                    data-date={dateKey} data-status={status} data-future={isFuture}
                                                                    disabled={processingRecordId !== null}
                                                                    onClick={() => goDetailForDate(user.id, dateKey)}
                                                                    aria-label={`${dateKey} ${label}`} title={`${dateKey} ${label}`}
                                                                    aria-current={dateKey === vietnamToday ? "date" : undefined}>
                                                                    <span style={{ ...recentDateStyle,
                                                                        color: isFuture ? "#9ca3af" : index % 7 === 0 ? "#dc2626" : index % 7 === 6 ? "#2563eb" : "#4b5563",
                                                                        fontWeight: dateKey === vietnamToday ? 800 : 500 }}>
                                                                        {Number(dateKey.slice(-2))}
                                                                    </span>
                                                                    <span
                                                                        aria-hidden="true"
                                                                        style={{
                                                                            ...recentDotStyle,
                                                                            ...calendarDotStyles[status],
                                                                            ...(isWorking && status !== "working" ? { outline: "1px solid #0ea5e9", outlineOffset: 2 } : {}),
                                                                        }}
                                                                    />
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                    <div style={calendarLegendStyle}>
                                                        {(Object.keys(calendarLabels) as AttendanceCalendarStatus[]).map(status => (
                                                            <span key={status} style={calendarLegendItemStyle}>
                                                                <span aria-hidden="true" style={{ ...recentDotStyle, ...calendarDotStyles[status] }} />
                                                                {calendarLabels[status]}
                                                            </span>
                                                        ))}
                                                    </div>

                                                    <div style={detailButtonWrapStyle}>
                                                        {nextLevelMessage ? (
                                                            <div style={nextLevelMessageStyle}>{nextLevelMessage}</div>
                                                        ) : null}
                                                        <button
                                                            type="button"
                                                            onClick={() => goDetail(user.id)}
                                                            style={detailButtonStyle}
                                                        >
                                                            {t.viewDetail}
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </Container>
    );
}

function IconStat({ icon, label, value }: { icon: string; label: string; value: number }) {
    return (
        <span style={iconStatStyle} title={label} aria-label={`${label} ${value}`}>
            <span aria-hidden="true">{icon}</span>
            <span>{value}</span>
        </span>
    );
}

const monthHeaderStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "36px 1fr 36px",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    marginBottom: 12,
};

const monthButtonStyle: CSSProperties = {
    height: 34,
    borderRadius: 10,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    fontSize: 20,
    fontWeight: 900,
    cursor: "pointer",
};

const monthTitleStyle: CSSProperties = {
    textAlign: "center",
    fontSize: 16,
    fontWeight: 900,
    color: "#111827",
};

const sectionStyle: CSSProperties = {
    display: "grid",
    gap: 12,
};

const unresolvedBannerStyle: CSSProperties = {
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 14,
    padding: "10px 12px",
    marginBottom: 12,
    display: "grid",
    gap: 8,
};

const unresolvedBannerHeaderStyle: CSSProperties = {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    border: "none",
    background: "transparent",
    padding: 0,
    cursor: "pointer",
    textAlign: "left",
};

const unresolvedBannerTitleStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 900,
    color: "#991b1b",
};

const unresolvedBannerChevronStyle: CSSProperties = {
    fontSize: 14,
    fontWeight: 900,
    color: "#991b1b",
    flexShrink: 0,
};

const unresolvedListStyle: CSSProperties = {
    display: "grid",
    gap: 5,
};

const unresolvedItemStyle: CSSProperties = {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 3,
    border: "1px solid #f3d2d2",
    background: "#ffffff",
    borderRadius: 10,
    padding: "7px 9px",
};

const unresolvedItemTopRowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 6,
    minWidth: 0,
};

const earlyLeaveNameScheduleStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: 4,
    minWidth: 0,
};

const earlyLeaveCheckoutComparisonStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "2px 4px",
    fontSize: 11,
    color: "#6b7280",
    minWidth: 0,
};

const earlyLeaveDecisionRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    minWidth: 0,
};

const earlyLeaveDecisionButtonsStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6,
    marginLeft: "auto",
    minWidth: 0,
};

const unresolvedItemNameStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 800,
    color: "#111827",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
};

const unresolvedItemDateStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: "#6b7280",
    flexShrink: 0,
    whiteSpace: "nowrap",
};

const unresolvedItemBottomRowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
};

const unresolvedItemMetaStyle: CSSProperties = {
    fontSize: 11,
    color: "#6b7280",
    minWidth: 0,
};

const unresolvedAutoTargetStyle: CSSProperties = {
    fontSize: 11,
    color: "#1d4ed8",
    fontWeight: 700,
    whiteSpace: "nowrap",
};

const unresolvedItemButtonsRowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "flex-end",
    marginLeft: "auto",
};

const unresolvedDetailButtonStyle: CSSProperties = {
    padding: "6px 10px",
    minHeight: 28,
    borderRadius: 8,
    border: "1px solid #93c5fd",
    background: "#eff6ff",
    color: "#1d4ed8",
    fontSize: 11,
    fontWeight: 800,
    cursor: "pointer",
    whiteSpace: "nowrap",
};

const unresolvedAutoButtonStyle: CSSProperties = {
    padding: "6px 10px",
    minHeight: 28,
    borderRadius: 8,
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: "nowrap",
};

const unresolvedDeleteButtonStyle: CSSProperties = {
    padding: "6px 10px",
    minHeight: 28,
    borderRadius: 8,
    border: "1px solid #ef4444",
    background: "#fef2f2",
    color: "#b91c1c",
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: "nowrap",
};

const partGroupStyle: CSSProperties = {
    display: "grid",
    gap: 6,
};

const partTitleStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    borderRadius: 10,
    padding: "7px 9px",
    fontSize: 13,
    fontWeight: 900,
};

const partCountStyle: CSSProperties = {
    marginLeft: "auto",
    fontSize: 11,
    fontWeight: 900,
    opacity: 0.75,
};

const partListStyle: CSSProperties = {
    display: "grid",
    gap: 6,
};

const staffCardStyle: CSSProperties = {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "6px 9px",
};

const staffSummaryButtonStyle: CSSProperties = {
    width: "100%",
    border: "none",
    background: "transparent",
    padding: 0,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto 12px",
    alignItems: "center",
    gap: 6,
    cursor: "pointer",
    textAlign: "left",
};

const staffLeftStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    overflow: "hidden",
};

const staffNameStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 800,
    color: "#111827",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
};

const staffSeparatorStyle: CSSProperties = {
    color: "#9ca3af",
    flexShrink: 0,
};

const staffMetaStyle: CSSProperties = {
    fontSize: 11,
    color: "#6b7280",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
};

const staffStatsStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    whiteSpace: "nowrap",
};

const iconStatStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 1,
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 800,
    color: "#374151",
    whiteSpace: "nowrap",
};

const expandIconStyle: CSSProperties = {
    fontSize: 13,
    color: "#6b7280",
    width: 12,
    textAlign: "center",
    flexShrink: 0,
};

const recentAttendanceStyle: CSSProperties = {
    display: "grid",
    gap: 3,
    marginTop: 5,
    paddingTop: 5,
    borderTop: "1px solid #f3f4f6",
};

const recentTitleStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 800,
    color: "#4b5563",
};

const recentTitleRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    minWidth: 0,
    whiteSpace: "nowrap",
};

const recentWeekdayGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    width: "100%",
};

const recentWeekdayStyle: CSSProperties = {
    minWidth: 0,
    textAlign: "center",
    fontSize: 10,
    lineHeight: 1.2,
    fontWeight: 700,
    whiteSpace: "nowrap",
};

const recentGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    overflow: "hidden",
    border: "1px solid #e5e7eb",
    borderRadius: 9,
};

const recentDayStyle: CSSProperties = {
    display: "grid",
    justifyItems: "center",
    alignContent: "center",
    gap: 3,
    minWidth: 0,
    minHeight: 40,
    boxSizing: "border-box",
    padding: "4px 1px",
    border: 0,
    borderRight: "1px solid #f3f4f6",
    borderBottom: "1px solid #f3f4f6",
    background: "transparent",
    cursor: "pointer",
    font: "inherit",
};

const recentDateStyle: CSSProperties = {
    maxWidth: "100%",
    overflow: "hidden",
    fontSize: 10,
    lineHeight: 1.2,
    color: "#6b7280",
    whiteSpace: "nowrap",
};

const recentDotStyle: CSSProperties = {
    display: "grid",
    placeItems: "center",
    width: 8,
    height: 8,
    boxSizing: "border-box",
    flexShrink: 0,
    borderRadius: "50%",
    fontSize: 14,
    lineHeight: 1,
};

const calendarDotStyles: Record<AttendanceCalendarStatus, CSSProperties> = {
    normal: { background: ATTENDANCE_STATUS_COLORS.normal },
    late: { background: ATTENDANCE_STATUS_COLORS.late },
    early_leave: { background: ATTENDANCE_STATUS_COLORS.early_leave },
    approved_leave: { background: ATTENDANCE_STATUS_COLORS.approved_leave },
    unauthorized_absence: { background: ATTENDANCE_STATUS_COLORS.unauthorized_absence },
    working: { border: "2px solid #0ea5e9" },
    pending: { border: "1.5px dashed #d97706" },
    none: { border: "1px solid #cbd5e1" },
    future: { background: "#e2e8f0", width: 4, height: 4, margin: 2 },
};

const calendarLegendStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "5px 10px",
    padding: "6px 0",
    color: "#6b7280",
    fontSize: 10,
};

const calendarLegendItemStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
};

const detailButtonWrapStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    minWidth: 0,
    marginTop: 1,
};

const nextLevelMessageStyle: CSSProperties = {
    minWidth: 0,
    color: "#2563eb",
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.4,
    overflowWrap: "anywhere",
};

const detailButtonStyle: CSSProperties = {
    flexShrink: 0,
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
    borderRadius: 10,
    minHeight: 32,
    padding: "5px 10px",
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
};

const emptyStyle: CSSProperties = {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: 20,
    textAlign: "center",
    color: "#6b7280",
    fontSize: 13,
};
