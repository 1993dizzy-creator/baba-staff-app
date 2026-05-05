"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { ui } from "@/lib/styles/ui";
import { supabase } from "@/lib/supabase/client";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { commonText, attendanceText } from "@/lib/text";


type UserRow = {
    id: number;
    name: string;
    username: string;
    part: string | null;
    position: string | null;
    birth_date: string | null;
    work_start_time: string | null;
    work_end_time: string | null;
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

function getMonthFromParam(monthParam: string | null) {
    if (!monthParam) return new Date();

    const [year, month] = monthParam.split("-").map(Number);
    if (!year || !month) return new Date();

    return new Date(year, month - 1, 1);
}

function getMonthRange(month: Date) {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();

    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 0);

    const startText = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
    const endText = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

    return { start, end, startText, endText };
}

function formatCalendarTitle(date: Date, monthFormat: string) {
    const year = String(date.getFullYear()).slice(2);
    const month = String(date.getMonth() + 1);

    return monthFormat
        .replace("{year}", year)
        .replace("{month}", month);
}

function isApprovedLeave(record: AttendanceRecord | null | undefined) {
    return record?.status === "leave" && record?.approval_status === "approved";
}

function formatTime(value: string | null) {
    if (!value) return "-";

    return new Date(value).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
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

function formatMinutes(
    minutes: number,
    text: { hour: string; minute: string }
) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;

    if (h <= 0) return `${m}${text.minute}`;
    if (m <= 0) return `${h}${text.hour}`;
    return `${h}${text.hour} ${m}${text.minute}`;
}


export default function AttendanceUserDetailPage() {
    const { lang } = useLanguage();
    const c = commonText[lang];
    const t = attendanceText[lang];
    const pathname = usePathname();
    const params = useParams();
    const searchParams = useSearchParams();

    const tabs = getAttendanceTabs(pathname, lang);

    const userId = Number(params.userId);
    const initialMonth = getMonthFromParam(searchParams.get("month"));

    const [currentMonth, setCurrentMonth] = useState(initialMonth);
    const [user, setUser] = useState<UserRow | null>(null);
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const loginUser = getUser();

        if (!isAdmin(loginUser)) {
            window.location.href = "/attendance";
            return;
        }

        fetchDetail();
    }, [currentMonth, userId]);

    const fetchDetail = async () => {
        setIsLoading(true);

        try {
            const { startText, endText } = getMonthRange(currentMonth);

            const userRes = await fetch("/api/attendance/users");
            const userResult = await userRes.json();

            if (!userRes.ok || !userResult.ok) {
                console.log("fetch user detail error:", userResult);
                return;
            }

            const userData = ((userResult.users || []) as UserRow[]).find(
                (item) => Number(item.id) === Number(userId)
            );

            if (!userData) {
                console.log("user not found:", userId);
                return;
            }

            const recordRes = await fetch(
                `/api/attendance/records?user_id=${userId}&start_date=${startText}&end_date=${endText}`
            );

            const recordResult = await recordRes.json();

            if (!recordRes.ok || !recordResult.ok) {
                console.log("fetch user attendance error:", recordResult);
                return;
            }

            const recordData = recordResult.records || [];

            setUser(userData);
            setRecords(recordData || []);
        } finally {
            setIsLoading(false);
        }
    };


    const summary = useMemo(() => {
        const workRecords = records.filter((record) =>
            record.status !== "leave" &&
            (
                ["working", "done", "early_leave"].includes(record.status) ||
                !!record.check_in_at ||
                !!record.check_out_at
            )
        );

        const approvedLeaveRecords = records.filter((record) =>
            record.status === "leave" && record.approval_status === "approved"
        );

        const pendingLeaveRecords = records.filter((record) =>
            record.status === "leave" && record.approval_status === "pending"
        );

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

        return {
            workDays: workRecords.length,
            leaveDays: approvedLeaveRecords.length,
            pendingLeaveCount: pendingLeaveRecords.length,
            lateCount,
            earlyLeaveCount,
            totalWorkMinutes,
        };
    }, [records]);


    return (
        <Container noPaddingTop>
            <SubNav tabs={tabs} />

            <div style={topStyle}>

                <div style={userTitleStyle}>
                    <div style={userNameStyle}>{user?.name || "-"}</div>
                    <div style={userMetaStyle}>
                        {user?.position
                            ? t.positions?.[user.position as keyof typeof t.positions] || user.position
                            : user?.username || "-"}
                    </div>
                </div>
            </div>


            {isLoading ? (
                <div style={emptyStyle}>{c.loading}</div>
            ) : (
                <>
                    <div style={summaryGridStyle}>

                        <InfoBox label={t.summaryWorkDays} value={`${summary.workDays}`} />
                        <InfoBox label={t.workLeave} value={`${summary.leaveDays}`} />
                        <InfoBox label={t.workLate} value={`${summary.lateCount}`} />
                        <InfoBox label={t.workEarlyLeave} value={`${summary.earlyLeaveCount}`} />
                        <InfoBox label={t.summaryTotalWorkTime} value={formatMinutes(summary.totalWorkMinutes, c)} />

                    </div>

                    <Calendar
                        calendarDate={currentMonth}
                        setCalendarDate={setCurrentMonth}
                        records={records}
                    />


                </>
            )}
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

function Calendar({
    calendarDate,
    setCalendarDate,
    records,
}: {
    calendarDate: Date;
    setCalendarDate: React.Dispatch<React.SetStateAction<Date>>;
    records: AttendanceRecord[];
}) {
    const { lang } = useLanguage();
    const c = commonText[lang];
    const t = attendanceText[lang];
    const calendarCells = getCalendarCells(calendarDate);

    const getDayRecord = (day: number) => {
        const year = calendarDate.getFullYear();
        const month = calendarDate.getMonth() + 1;

        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

        return records.find((r) => r.work_date === dateStr) || null;
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

                    <div style={calendarTitle}>{formatCalendarTitle(calendarDate, t.monthFormat)}</div>

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

                        const lateMinutes = Number(record?.late_minutes || 0);
                        const earlyLeaveMinutes = Number(record?.early_leave_minutes || 0);

                        if (earlyLeaveMinutes > 0 || record?.status === "early_leave") {
                            dotColor = "#ef4444";
                        } else if (lateMinutes > 0) {
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
                                    <>
                                        <div
                                            style={{
                                                ...calendarDotStyle,
                                                background: dotColor,
                                            }}
                                        />

                                        {(record.check_in_at || record.check_out_at) && (
                                            <div style={calendarTimeTextStyle}>
                                                <div>{record.check_in_at ? formatTime(record.check_in_at) : "-"}</div>
                                                <div>{record.check_out_at ? formatTime(record.check_out_at) : "-"}</div>
                                            </div>
                                        )}
                                    </>
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

function LegendItem({ label, color }: { label: string; color: string }) {
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

const topStyle: CSSProperties = {
    display: "grid",
    gap: 8,
    marginBottom: 12,
};



const userTitleStyle: CSSProperties = {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: "12px 14px",
};

const userNameStyle: CSSProperties = {
    fontSize: 17,
    fontWeight: 900,
    color: "#111827",
};

const userMetaStyle: CSSProperties = {
    marginTop: 3,
    fontSize: 12,
    color: "#6b7280",
};


const summaryGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 6,
    marginBottom: 12,
};

const infoBoxStyle: CSSProperties = {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "9px 6px",
    textAlign: "center",
};

const infoLabelStyle: CSSProperties = {
    fontSize: 10,
    color: "#6b7280",
    marginBottom: 3,
};

const infoValueStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 900,
    color: "#111827",
};

const cardStyle: CSSProperties = {
    ...ui.card,
    padding: 14,
};

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
    color: "#111827",
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

const calendarTimeTextStyle: CSSProperties = {
    fontSize: 9,
    lineHeight: 1.1,
    fontWeight: 700,
    color: "#6b7280",
    whiteSpace: "nowrap",
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