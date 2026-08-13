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
import AttendancePerfectScoreBadge from "@/components/attendance/AttendancePerfectScoreBadge";
import { useMonthlyAttendanceSummary } from "@/components/attendance/useMonthlyAttendanceSummary";
import {
    ATTENDANCE_STATUS_COLORS,
    getAttendanceDisplayStatus,
    getDateKeyWeekdayIndex,
    getRecentAttendanceDateKeys,
} from "@/lib/attendance/display-status";


type UserRow = {
    id: number;
    name: string;
    username: string;
    role: string | null;
    part: string | null;
    position: string | null;
    birth_date: string | null;
    is_active: boolean;
    levelInfo: EmployeeLevelInfo;
};

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
    const [unresolvedOpenRecords, setUnresolvedOpenRecords] = useState<UnresolvedOpenRecord[]>([]);
    const [isUnresolvedOpen, setIsUnresolvedOpen] = useState(false);
    const [processingRecordId, setProcessingRecordId] = useState<number | null>(null);
    const [processingAction, setProcessingAction] = useState<"auto" | "delete" | null>(null);
    const monthlyOverviewRequestRef = useRef(0);

    const fetchUnresolvedOpenRecords = useCallback(async () => {
        try {
            const res = await attendanceFetch("/api/attendance/admin");

            const result = await res.json();

            if (!res.ok || !result.ok) {
                console.log("fetch unresolved open records error:", result);
                return;
            }

            setUnresolvedOpenRecords((result.unresolvedOpenRecords || []) as UnresolvedOpenRecord[]);
        } catch (err) {
            console.log("fetch unresolved open records exception:", err);
        }
    }, []);

    const fetchMonthlyOverview = useCallback(async () => {
        const requestId = ++monthlyOverviewRequestRef.current;
        setIsLoading(true);

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
                console.log("fetch users error:", userResult);
                return;
            }
            if (!recordRes.ok || !recordResult.ok) {
                console.log("fetch attendance records error:", recordResult);
                return;
            }
            if (requestId !== monthlyOverviewRequestRef.current) return;

            const userData = (userResult.users || []) as UserRow[];
            const recordData = recordResult.records || [];
            setUsers(userData.filter((user) => !isAdmin(user)));
            setRecords(recordData);
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
    }, [fetchUnresolvedOpenRecords]);

    useEffect(() => {
        if (!isAdmin(getUser())) return;
        void fetchMonthlyOverview();
        return () => {
            monthlyOverviewRequestRef.current += 1;
        };
    }, [fetchMonthlyOverview]);

    const handleAutoCorrect = async (record: UnresolvedOpenRecord) => {
        if (processingRecordId) return;
        const autoCloseTime = formatCheckInTime(record.auto_close_at);
        if (!window.confirm(t.unresolvedOpenRecordAutoConfirm.replace("{time}", autoCloseTime))) return;

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
            await fetchMonthlyOverview();
        } catch (err) {
            console.error(err);
            alert(t.unresolvedOpenRecordAutoFailed);
        } finally {
            setProcessingRecordId(null);
            setProcessingAction(null);
        }
    };

    const handleDeleteOrphan = async (record: UnresolvedOpenRecord) => {
        if (processingRecordId) return;
        if (!window.confirm(t.orphanRecordDeleteConfirm)) return;

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
        } catch (err) {
            console.error(err);
            alert(t.orphanRecordDeleteFailed);
        } finally {
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

    const recentDateKeys = useMemo(() => {
        const { startText } = getMonthRange(currentMonth);
        return getRecentAttendanceDateKeys(startText.slice(0, 7));
    }, [currentMonth]);

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
        setCurrentMonth((prev) => {
            const next = new Date(prev);
            next.setMonth(next.getMonth() + amount);
            return next;
        });
        setExpandedUserId(null);
    };

    const goDetail = (userId: number) => {
        const year = currentMonth.getFullYear();
        const month = String(currentMonth.getMonth() + 1).padStart(2, "0");

        router.push(`/admin/payroll/attendance/${userId}?month=${year}-${month}`);
    };

    const goDetailForDate = (userId: number, workDate: string) => {
        const month = workDate.slice(0, 7);

        router.push(`/admin/payroll/attendance/${userId}?month=${month}&date=${workDate}`);
    };

    return (
        <Container noPaddingTop>
            <div style={monthHeaderStyle}>
                <button type="button" style={monthButtonStyle} onClick={() => moveMonth(-1)}>
                    ‹
                </button>

                <div style={monthTitleStyle}>{formatMonth(currentMonth, t.monthFormat)}</div>

                <button type="button" style={monthButtonStyle} onClick={() => moveMonth(1)}>
                    ›
                </button>
            </div>

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
                {isLoading ? (
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
                                    const vietnamToday = new Intl.DateTimeFormat("en-CA", {
                                        timeZone: "Asia/Ho_Chi_Minh",
                                        year: "numeric",
                                        month: "2-digit",
                                        day: "2-digit",
                                    }).format(new Date());
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
                                                    <AttendancePerfectScoreBadge show={perfectSummary.get(user.id)?.perfectAttendanceCurrent===true} vi={lang==="vi"}/>
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
                                                    <div style={recentTitleStyle}>{t.recent7Days}</div>
                                                    <div style={recentWeekdayGridStyle}>
                                                        {recentDateKeys.map((dateKey) => {
                                                            const weekdayIndex = getDateKeyWeekdayIndex(dateKey);
                                                            return (
                                                                <span
                                                                    key={`weekday-${dateKey}`}
                                                                    style={{
                                                                        ...recentWeekdayStyle,
                                                                        color: weekdayIndex === 0
                                                                            ? "#dc2626"
                                                                            : weekdayIndex === 6
                                                                                ? "#2563eb"
                                                                                : "#6b7280",
                                                                    }}
                                                                >
                                                                    {c.calendarWeekdays[weekdayIndex]}
                                                                </span>
                                                            );
                                                        })}
                                                    </div>
                                                    <div style={recentGridStyle}>
                                                        {recentDateKeys.map((dateKey) => {
                                                            const status = getAttendanceDisplayStatus(recordsByDate?.get(dateKey));
                                                             const label = status === "early_leave"
                                                                ? t.workEarlyLeave
                                                                : status === "late"
                                                                    ? t.workLate
                                                                 : status === "approved_leave"
                                                                     ? t.workLeave
                                                                     : status === "unauthorized_absence"
                                                                         ? t.unauthorizedAbsence
                                                                     : status === "normal"
                                                                            ? t.workNormal
                                                                            : c.noData;

                                                            return (
                                                                <div key={dateKey} style={recentDayStyle} title={label}>
                                                                    <span style={recentDateStyle}>
                                                                        {Number(dateKey.slice(-2))}
                                                                    </span>
                                                                    <span
                                                                        role="img"
                                                                        aria-label={label}
                                                                        style={{
                                                                            ...recentDotStyle,
                                                                            ...(status === "none"
                                                                                ? recentEmptyDotStyle
                                                                                : { background: ATTENDANCE_STATUS_COLORS[status] }),
                                                                        }}
                                                                    >
                                                                        {status === "none" ? "·" : ""}
                                                                    </span>
                                                                </div>
                                                            );
                                                        })}
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
    padding: "4px 1px",
    borderRight: "1px solid #f3f4f6",
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
    borderRadius: "50%",
    fontSize: 14,
    lineHeight: 1,
};

const recentEmptyDotStyle: CSSProperties = {
    width: 12,
    height: 12,
    color: "#cbd5e1",
    background: "transparent",
    border: "1px solid #e5e7eb",
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
