"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { supabase } from "@/lib/supabase/client";
import { getUser, isAdmin } from "@/lib/supabase/auth";


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

const PART_META: Record<string, { label: string; emoji: string; color: string; bg: string; border: string; rank: number }> = {
    kitchen: { label: "Kitchen", emoji: "🍳", color: "#f59e0b", bg: "#fff7ed", border: "#f59e0b", rank: 1 },
    hall: { label: "Hall", emoji: "🍺", color: "#10b981", bg: "#ecfdf5", border: "#10b981", rank: 2 },
    bar: { label: "Bar", emoji: "🍸", color: "#3b82f6", bg: "#eff6ff", border: "#3b82f6", rank: 3 },
    etc: { label: "Etc", emoji: "📦", color: "#8b5cf6", bg: "#f5f3ff", border: "#8b5cf6", rank: 99 },
};

function getPartKey(part?: string | null) {
    const value = String(part || "").toLowerCase();
    if (value.includes("kitchen")) return "kitchen";
    if (value.includes("hall")) return "hall";
    if (value.includes("bar")) return "bar";
    if (value.includes("etc")) return "etc";
    return value || "etc";
}

function getPartMeta(part?: string | null) {
    const key = getPartKey(part);
    return PART_META[key] || {
        label: part || "Etc",
        emoji: "📦",
        color: "#4b5563",
        bg: "#f9fafb",
        border: "#d1d5db",
        rank: 99,
    };
}

function getPositionRank(position?: string | null) {
    const value = String(position || "").toLowerCase();

    if (value.includes("manager") || value.includes("master")) return 1;
    if (value.includes("leader") || value.includes("head")) return 2;
    if (value.includes("captain")) return 3;
    if (value.includes("senior")) return 4;
    if (value.includes("staff")) return 5;
    if (value.includes("part")) return 6;

    return 99;
}

function getMonthRange(month: Date) {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();

    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 0);

    const startText = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
    const endText = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

    return { startText, endText };
}

function formatMonth(month: Date, lang: "ko" | "vi") {
    const year = String(month.getFullYear()).slice(2);
    const monthNumber = month.getMonth() + 1;

    if (lang === "vi") return `Tháng ${monthNumber}/${year}`;
    return `${year}년 ${monthNumber}월`;
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

function isApprovedLeave(record: AttendanceRecord) {
    return record.status === "leave" && record.approval_status === "approved";
}

function formatMinutes(minutes: number, lang: "ko" | "vi") {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;

    if (lang === "vi") {
        if (h <= 0) return `${m} p`;
        if (m <= 0) return `${h} giờ`;
        return `${h} giờ ${m} p`;
    }

    if (h <= 0) return `${m}분`;
    if (m <= 0) return `${h}시간`;
    return `${h}시간 ${m}분`;
}

export default function AttendanceOverviewPage() {
    const router = useRouter();
    const { lang } = useLanguage();
    const pathname = usePathname();
    const tabs = getAttendanceTabs(pathname, lang);

    const [currentMonth, setCurrentMonth] = useState(new Date());
    const [users, setUsers] = useState<UserRow[]>([]);
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const loginUser = getUser();

        if (!isAdmin(loginUser)) {
            window.location.href = "/attendance";
            return;
        }

        fetchMonthlyOverview();
    }, [currentMonth]);

    const fetchMonthlyOverview = async () => {
        setIsLoading(true);

        try {
            const { startText, endText } = getMonthRange(currentMonth);

            const userRes = await fetch("/api/attendance/users");
            const userResult = await userRes.json();

            if (!userRes.ok || !userResult.ok) {
                console.log("fetch users error:", userResult);
                return;
            }

            const userData = (userResult.users || []) as UserRow[];

            const { data: recordData, error: recordError } = await supabase
                .from("attendance_records")
                .select("*")
                .gte("work_date", startText)
                .lte("work_date", endText);

            if (recordError) {
                console.log("fetch attendance records error:", JSON.stringify(recordError, null, 2));
                return;
            }

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

    return (
        <Container noPaddingTop>
            <SubNav tabs={tabs} />

            <div style={monthHeaderStyle}>
                <button type="button" style={monthButtonStyle} onClick={() => moveMonth(-1)}>
                    ‹
                </button>

                <div style={monthTitleStyle}>{formatMonth(currentMonth, lang)}</div>

                <button type="button" style={monthButtonStyle} onClick={() => moveMonth(1)}>
                    ›
                </button>
            </div>

            <div style={sectionStyle}>
                {isLoading ? (
                    <div style={emptyStyle}>{lang === "vi" ? "Đang tải..." : "불러오는 중..."}</div>
                ) : groupedSummaries.length === 0 ? (
                    <div style={emptyStyle}>{lang === "vi" ? "Không có nhân viên." : "직원이 없습니다."}</div>
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
                                <span>{group.meta.label}</span>
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
                                                        {user.position || user.username}
                                                    </span>
                                                </div>

                                                <div style={staffRightStyle}>
                                                    <span style={miniBadgeStyle}>
                                                        {lang === "vi" ? "Làm" : "근무"} {summary.workDays}
                                                    </span>

                                                    <span style={miniBadgeStyle}>
                                                        {lang === "vi" ? "Nghỉ" : "휴무"} {summary.leaveDays}
                                                    </span>

                                                    {summary.lateCount > 0 && (
                                                        <span style={warningBadgeStyle}>
                                                            {lang === "vi" ? "Trễ" : "지각"} {summary.lateCount}
                                                        </span>
                                                    )}

                                                    {summary.earlyLeaveCount > 0 && (
                                                        <span style={dangerBadgeStyle}>
                                                            {lang === "vi" ? "Sớm" : "조퇴"} {summary.earlyLeaveCount}
                                                        </span>
                                                    )}

                                                    <span style={expandIconStyle}>{isExpanded ? "⌃" : "⌄"}</span>
                                                </div>
                                            </button>

                                            {isExpanded && (
                                                <div style={detailGridStyle}>
                                                    <InfoBox
                                                        label={lang === "vi" ? "Tổng giờ" : "총 근무"}
                                                        value={formatMinutes(summary.totalWorkMinutes, lang)}
                                                    />
                                                    <InfoBox
                                                        label={lang === "vi" ? "trễ" : "지각"}
                                                        value={formatMinutes(summary.totalLateMinutes, lang)}
                                                    />

                                                    <InfoBox
                                                        label={lang === "vi" ? "về sớm" : "조퇴"}
                                                        value={formatMinutes(summary.totalEarlyLeaveMinutes, lang)}
                                                    />

                                                    <InfoBox
                                                        label={lang === "vi" ? "Vắng" : "미출근"}
                                                        value={`${summary.absentCount}`}
                                                    />

                                                    <div style={detailButtonWrapStyle}>
                                                        <button
                                                            type="button"
                                                            onClick={() => goDetail(user.id)}
                                                            style={detailButtonStyle}
                                                        >
                                                            {lang === "vi" ? "Xem chi tiết" : "상세보기"}
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