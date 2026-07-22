"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { commonText, attendanceText } from "@/lib/text";
import { getPartMeta, getPartKey } from "@/lib/common/parts";
import { getPositionRank } from "@/lib/common/positions";
import { attendanceFetch } from "@/lib/auth/client-session";


type UserRow = {
    id: number;
    name: string;
    username: string;
    role: string | null;
    part: string | null;
    position: string | null;
    birth_date: string | null;
    is_active: boolean;
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
    const { lang } = useLanguage();
    const c = commonText[lang];
    const t = attendanceText[lang];
    const pathname = usePathname();
    const tabs = getAttendanceTabs(pathname, lang);

    const [currentMonth, setCurrentMonth] = useState(new Date());
    const [users, setUsers] = useState<UserRow[]>([]);
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [unresolvedOpenRecords, setUnresolvedOpenRecords] = useState<UnresolvedOpenRecord[]>([]);
    const [isUnresolvedOpen, setIsUnresolvedOpen] = useState(false);
    const [processingRecordId, setProcessingRecordId] = useState<number | null>(null);
    const [processingAction, setProcessingAction] = useState<"auto" | "delete" | null>(null);

    useEffect(() => {
        const loginUser = getUser();

        if (!isAdmin(loginUser)) {
            window.location.href = "/attendance";
            return;
        }

        fetchMonthlyOverview();
        fetchUnresolvedOpenRecords();
    }, [currentMonth]);

    const fetchUnresolvedOpenRecords = async () => {
        try {
            const loginUser = getUser();

            const res = await fetch(
                `/api/attendance/admin?actorUsername=${encodeURIComponent(loginUser?.username || "")}&lang=${lang}`
            );

            const result = await res.json();

            if (!res.ok || !result.ok) {
                console.log("fetch unresolved open records error:", result);
                return;
            }

            setUnresolvedOpenRecords((result.unresolvedOpenRecords || []) as UnresolvedOpenRecord[]);
        } catch (err) {
            console.log("fetch unresolved open records exception:", err);
        }
    };

    const handleAutoCorrect = async (record: UnresolvedOpenRecord) => {
        if (processingRecordId) return;
        if (!window.confirm(t.unresolvedOpenRecordAutoConfirm)) return;

        setProcessingRecordId(record.id);
        setProcessingAction("auto");

        try {
            const loginUser = getUser();

            const res = await fetch("/api/attendance/admin", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "auto_close_at_01",
                    attendance_id: record.id,
                    user_id: record.user_id,
                    work_date: record.work_date,
                    actorUsername: loginUser?.username || "",
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
            const loginUser = getUser();

            const res = await fetch("/api/attendance/admin", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "delete_orphan_record",
                    attendance_id: record.id,
                    user_id: record.user_id,
                    work_date: record.work_date,
                    actorUsername: loginUser?.username || "",
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

    const fetchMonthlyOverview = async () => {
        setIsLoading(true);

        try {
            const { startText } = getMonthRange(currentMonth);
            const month = startText.slice(0, 7);

            const userRes = await attendanceFetch("/api/attendance/users");
            const userResult = await userRes.json();

            if (!userRes.ok || !userResult.ok) {
                console.log("fetch users error:", userResult);
                return;
            }

            const userData = (userResult.users || []) as UserRow[];

            const recordRes = await attendanceFetch(
                `/api/attendance/records?scope=admin_overview&month=${month}`
            );

            const recordResult = await recordRes.json();

            if (!recordRes.ok || !recordResult.ok) {
                console.log("fetch attendance records error:", recordResult);
                return;
            }

            const recordData = recordResult.records || [];

            setUsers(userData.filter((user) => !isAdmin(user)));
            setRecords(recordData || []);
        } finally {
            setIsLoading(false);
        }
    };

    const recordsByUser = useMemo(() => {
        const map = new Map<number, AttendanceRecord[]>();

        records.forEach((record) => {
            const key = record.user_id;
            const prev = map.get(key) || [];
            map.set(key, [...prev, record]);
        });

        return map;
    }, [records]);

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

            const pendingLeaveRecords = userRecords.filter((record) =>
                record.status === "leave" && record.approval_status === "pending"
            );

            const workDays = workRecords.length;

            const leaveDays = approvedLeaveRecords.length;

            const lateCount = workRecords.filter((record) =>
                Number(record.late_minutes || 0) > 0
            ).length;

            const earlyLeaveCount = workRecords.filter((record) =>
                record.status === "early_leave" || Number(record.early_leave_minutes || 0) > 0
            ).length;

            const totalWorkMinutes = workRecords.reduce(
                (sum, record) => sum + Number(record.work_minutes || 0),
                0
            );

            const pendingLeaveCount = pendingLeaveRecords.length;

            const absentCount = userRecords.filter((record) =>
                record.status === "absent"
            ).length;

            const totalLateMinutes = workRecords.reduce(
                (sum, record) => sum + Number(record.late_minutes || 0),
                0
            );

            const totalEarlyLeaveMinutes = workRecords.reduce(
                (sum, record) => sum + Number(record.early_leave_minutes || 0),
                0
            );

            return {
                user,
                workDays,
                leaveDays,
                lateCount,
                earlyLeaveCount,
                totalWorkMinutes,
                pendingLeaveCount,
                absentCount,
                totalLateMinutes,
                totalEarlyLeaveMinutes,
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
                    const rankDiff = getPositionRank(a.user.position) - getPositionRank(b.user.position);
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

        router.push(`/attendance/overview/${userId}?month=${year}-${month}`);
    };

    const goDetailForDate = (userId: number, workDate: string) => {
        const month = workDate.slice(0, 7);

        router.push(`/attendance/overview/${userId}?month=${month}&date=${workDate}`);
    };

    return (
        <Container noPaddingTop>
            <SubNav tabs={tabs} />

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

                                    return (
                                        <div key={user.id} style={staffCardStyle}>
                                            <button
                                                type="button"
                                                onClick={() => setExpandedUserId(isExpanded ? null : user.id)}
                                                style={staffSummaryButtonStyle}
                                            >
                                                <div style={staffLeftStyle}>
                                                    <span style={staffNameStyle}>
                                                        {user.name}
                                                        {age ? ` (${age})` : ""}
                                                    </span>
                                                    <span style={staffMetaStyle}>
                                                        {user.position
                                                            ? t.positions?.[user.position as keyof typeof t.positions] || user.position
                                                            : user.username}
                                                    </span>
                                                </div>

                                                <div style={staffRightStyle}>
                                                    <span style={miniBadgeStyle}>
                                                        {t.workTime} {summary.workDays}
                                                    </span>

                                                    <span style={miniBadgeStyle}>
                                                        {t.workLeave} {summary.leaveDays}
                                                    </span>

                                                    {summary.lateCount > 0 && (
                                                        <span style={warningBadgeStyle}>
                                                            {t.workLate} {summary.lateCount}
                                                        </span>
                                                    )}

                                                    {summary.earlyLeaveCount > 0 && (
                                                        <span style={dangerBadgeStyle}>
                                                            {t.workEarlyLeave} {summary.earlyLeaveCount}
                                                        </span>
                                                    )}

                                                    <span style={expandIconStyle}>{isExpanded ? "⌃" : "⌄"}</span>
                                                </div>
                                            </button>

                                            {isExpanded && (
                                                <div style={detailGridStyle}>
                                                    <InfoBox
                                                        label={t.summaryTotalWorkTime}
                                                        value={formatMinutes(summary.totalWorkMinutes, c)}
                                                    />
                                                    <InfoBox
                                                        label={t.workLate}
                                                        value={formatMinutes(summary.totalLateMinutes, c)}
                                                    />

                                                    <InfoBox
                                                        label={t.workEarlyLeave}
                                                        value={formatMinutes(summary.totalEarlyLeaveMinutes, c)}
                                                    />

                                                    <InfoBox
                                                        label={t.absent}
                                                        value={`${summary.absentCount}`}
                                                    />

                                                    <div style={detailButtonWrapStyle}>
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

function InfoBox({ label, value }: { label: string; value: string }) {
    return (
        <div style={infoBoxStyle}>
            <div style={infoLabelStyle}>{label}</div>
            <div style={infoValueStyle}>{value}</div>
        </div>
    );
}

const monthHeaderStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "36px 1fr 36px",
    alignItems: "center",
    gap: 8,
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
    padding: "9px 10px",
};

const staffSummaryButtonStyle: CSSProperties = {
    width: "100%",
    border: "none",
    background: "transparent",
    padding: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    textAlign: "left",
};

const staffLeftStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
};

const staffRightStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
};

const staffNameStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 800,
    color: "#111827",
    whiteSpace: "nowrap",
};

const staffMetaStyle: CSSProperties = {
    fontSize: 11,
    color: "#6b7280",
    whiteSpace: "nowrap",
};

const miniBadgeStyle: CSSProperties = {
    border: "1px solid #d1d5db",
    borderRadius: 999,
    padding: "3px 7px",
    fontSize: 11,
    fontWeight: 800,
    background: "#ffffff",
    color: "#374151",
    whiteSpace: "nowrap",
};

const warningBadgeStyle: CSSProperties = {
    border: "1px solid #f59e0b",
    borderRadius: 999,
    padding: "3px 7px",
    fontSize: 11,
    fontWeight: 800,
    background: "#fffbeb",
    color: "#92400e",
    whiteSpace: "nowrap",
};

const dangerBadgeStyle: CSSProperties = {
    border: "1px solid #ef4444",
    borderRadius: 999,
    padding: "3px 7px",
    fontSize: 11,
    fontWeight: 800,
    background: "#fef2f2",
    color: "#991b1b",
    whiteSpace: "nowrap",
};

const expandIconStyle: CSSProperties = {
    fontSize: 13,
    color: "#6b7280",
    width: 12,
    textAlign: "center",
};

const detailGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 6,
    marginTop: 8,
};

const detailButtonWrapStyle: CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gridColumn: "1 / -1",  // 👈 이거 추가
    marginTop: 3,
};

const detailButtonStyle: CSSProperties = {
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
    borderRadius: 10,
    padding: "7px 11px",
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
};

const infoBoxStyle: CSSProperties = {
    background: "#f9fafb",
    border: "1px solid #d1d5db",
    borderRadius: 10,
    padding: "7px 5px",
    textAlign: "center",
};

const infoLabelStyle: CSSProperties = {
    fontSize: 10,
    color: "#6b7280",
    marginBottom: 3,
};

const infoValueStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 800,
    color: "#111827",
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
