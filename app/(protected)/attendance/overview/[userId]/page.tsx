"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { ui } from "@/lib/styles/ui";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { commonText, attendanceText } from "@/lib/text";
import {
    getDefaultShiftDateTimeValue,
    isLongShiftRecord,
    isOpenRecordUnresolved,
} from "@/lib/attendance/time";


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
    note: string | null;
    approval_status: "pending" | "approved" | null;
    updated_at?: string | null;
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

function formatDateKey(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getInitialSelectedDate(month: Date) {
    const today = new Date();
    if (
        today.getFullYear() === month.getFullYear() &&
        today.getMonth() === month.getMonth()
    ) {
        return formatDateKey(today);
    }

    return getMonthRange(month).startText;
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

const dateTimeInputFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});

function toDateTimeInputValue(value: string | null) {
    if (!value) return "";

    const parts = dateTimeInputFormatter.formatToParts(new Date(value));
    const map = new Map(parts.map((part) => [part.type, part.value]));

    return `${map.get("year")}-${map.get("month")}-${map.get("day")}T${map.get("hour")}:${map.get("minute")}`;
}

// 직원의 예정 출근/퇴근시간이 비어 있으면 매장 영업시간(16:00/01:00)으로 자동 대체하지 않는다.
// 예정시간이 설정된 경우에만 기본값을 만들고, 없으면 관리자가 직접 입력하도록 공란으로 둔다.
function getOptionalDefaultShiftDateTimeValue(workDate: string, timeHHMM: string | null) {
    if (!timeHHMM) return "";
    return getDefaultShiftDateTimeValue(workDate, timeHHMM);
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
    const [selectedDate, setSelectedDate] = useState(
        searchParams.get("date") || getInitialSelectedDate(initialMonth)
    );
    const [user, setUser] = useState<UserRow | null>(null);
    const [records, setRecords] = useState<AttendanceRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [message, setMessage] = useState("");
    const [isSaving, setIsSaving] = useState(false);

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

            // /api/attendance/users는 활성 직원만 반환한다. 비활성 직원의 과거 기록도
            // 관리자가 확인·보정할 수 있어야 하므로, 목록에 없다는 이유로 근태 조회 자체를
            // 막지 않는다(헤더의 이름 표시만 "-"로 대체된다).
            if (!userData) {
                console.log("user not found in active list, loading records anyway:", userId);
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

            setUser(userData || null);
            setRecords(recordData || []);
        } finally {
            setIsLoading(false);
        }
    };

    const selectedRecord = useMemo(
        () => records.find((record) => record.work_date === selectedDate) || null,
        [records, selectedDate]
    );

    const handleMonthChange = (nextMonth: Date) => {
        setCurrentMonth(nextMonth);
        setSelectedDate(getInitialSelectedDate(nextMonth));
        setMessage("");
    };

    const handleSaveRecord = async ({
        id,
        note,
        checkInDateTime,
        checkOutDateTime,
        clearCheckOut,
        isNew,
    }: {
        id?: number;
        note: string;
        checkInDateTime?: string;
        checkOutDateTime?: string;
        clearCheckOut?: boolean;
        isNew?: boolean;
    }) => {
        if (!user) return;

        const loginUser = getUser();
        setIsSaving(true);
        setMessage("");

        try {
            const res = await fetch("/api/attendance/admin", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "update_record",
                    attendance_id: id,
                    user_id: user.id,
                    work_date: selectedDate,
                    check_in_datetime: checkInDateTime || undefined,
                    check_out_datetime: clearCheckOut ? undefined : checkOutDateTime || undefined,
                    clear_check_out: clearCheckOut === true,
                    note,
                    is_new: isNew === true,
                    actorUsername: loginUser?.username || "",
                    lang,
                }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                throw new Error(result.message || t.correctionFailed);
            }

            // 공란 날짜에 신규 생성한 경우 records에 해당 id가 아직 없으므로 추가하고,
            // 기존 기록을 수정한 경우에만 교체한다.
            setRecords((current) => {
                const exists = current.some((record) => record.id === result.record.id);
                return exists
                    ? current.map((record) =>
                        record.id === result.record.id ? result.record : record
                    )
                    : [...current, result.record];
            });

            // 출근일시를 바꾸면 서버가 work_date를 자동 재계산하므로,
            // 선택된 날짜가 더 이상 이 기록과 일치하지 않으면 새 날짜로 따라간다.
            if (result.record.work_date && result.record.work_date !== selectedDate) {
                setSelectedDate(result.record.work_date);
            }

            setMessage(t.correctionDone);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : t.correctionFailed);
        } finally {
            setIsSaving(false);
        }
    };

    const handleNormalizeLate = async (recordId: number) => {
        const loginUser = getUser();
        setIsSaving(true);
        setMessage("");

        try {
            const res = await fetch("/api/attendance/admin", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "normalize_late",
                    attendance_id: recordId,
                    actorUsername: loginUser?.username || "",
                    lang,
                }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                throw new Error(result.message || t.correctionFailed);
            }

            setRecords((current) =>
                current.map((record) =>
                    record.id === result.record.id ? result.record : record
                )
            );
            setMessage(t.correctionDone);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : t.correctionFailed);
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveLeave = async ({ note, isNew }: { note: string; isNew?: boolean }) => {
        if (!user) return;

        const loginUser = getUser();
        setIsSaving(true);
        setMessage("");

        try {
            const res = await fetch("/api/attendance/admin", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "set_leave",
                    user_id: user.id,
                    work_date: selectedDate,
                    note: note || undefined,
                    is_new: isNew === true,
                    admin_name: loginUser?.name || "",
                    actorUsername: loginUser?.username || "",
                    lang,
                }),
            });

            const result = await res.json();

            if (!res.ok || !result.ok) {
                throw new Error(result.message || t.correctionFailed);
            }

            setRecords((current) => {
                const exists = current.some((record) => record.id === result.record.id);
                return exists
                    ? current.map((record) =>
                        record.id === result.record.id ? result.record : record
                    )
                    : [...current, result.record];
            });

            setMessage(t.correctionDone);
        } catch (error) {
            setMessage(error instanceof Error ? error.message : t.correctionFailed);
        } finally {
            setIsSaving(false);
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

            <div style={headerCardStyle}>
                <div style={headerTopRowStyle}>
                    <div style={headerIdentityStyle}>
                        <div style={userNameStyle}>{user?.name || "-"}</div>
                        <div style={userMetaStyle}>
                            {user?.position
                                ? t.positions?.[user.position as keyof typeof t.positions] || user.position
                                : user?.username || "-"}
                        </div>
                    </div>

                    {!isLoading && (
                        <div style={totalWorkSummaryStyle}>
                            <span style={totalWorkSummaryLabelStyle}>⏳ {t.summaryTotalWorkTime}</span>
                            <strong style={totalWorkSummaryValueStyle}>
                                {formatMinutes(summary.totalWorkMinutes, c)}
                            </strong>
                        </div>
                    )}
                </div>

                {!isLoading && (
                    <div style={statStripStyle}>
                        <StatChip icon="📅" label={t.summaryWorkDays} value={`${summary.workDays}`} />
                        <StatChip icon="🌴" label={t.workLeave} value={`${summary.leaveDays}`} />
                        <StatChip icon="⏰" label={t.workLate} value={`${summary.lateCount}`} />
                        <StatChip icon="🏃" label={t.workEarlyLeave} value={`${summary.earlyLeaveCount}`} />
                    </div>
                )}
            </div>

            {isLoading ? (
                <div style={emptyStyle}>{c.loading}</div>
            ) : (
                <>
                    <Calendar
                        calendarDate={currentMonth}
                        setCalendarDate={handleMonthChange}
                        records={records}
                        selectedDate={selectedDate}
                        onSelectDate={setSelectedDate}
                    />

                    <RecordDetailPanel
                        key={`${selectedDate}-${selectedRecord?.id || "none"}-${selectedRecord?.updated_at || ""}`}
                        selectedDate={selectedDate}
                        record={selectedRecord}
                        workStartTime={user?.work_start_time || null}
                        workEndTime={user?.work_end_time || null}
                        isSaving={isSaving}
                        message={message}
                        onSave={handleSaveRecord}
                        onNormalizeLate={handleNormalizeLate}
                        onSaveLeave={handleSaveLeave}
                    />

                </>
            )}
        </Container>
    );
}

function StatChip({ icon, label, value }: { icon: string; label: string; value: string }) {
    return (
        <div style={statChipStyle}>
            <span style={statChipTopRowStyle}>
                <span aria-hidden="true">{icon}</span>
                <span style={statChipValueStyle}>{value}</span>
            </span>
            <span style={statChipLabelStyle}>{label}</span>
        </div>
    );
}

function Calendar({
    calendarDate,
    setCalendarDate,
    records,
    selectedDate,
    onSelectDate,
}: {
    calendarDate: Date;
    setCalendarDate: (date: Date) => void;
    records: AttendanceRecord[];
    selectedDate: string;
    onSelectDate: (date: string) => void;
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
                            setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1))
                        }
                    >
                        ‹
                    </button>

                    <div style={calendarTitle}>{formatCalendarTitle(calendarDate, t.monthFormat)}</div>

                    <button
                        type="button"
                        style={calendarMonthButtonStyle}
                        onClick={() =>
                            setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1))
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
                        const dateStr =
                            cell.type === "current"
                                ? `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, "0")}-${String(displayDay).padStart(2, "0")}`
                                : "";
                        const isSelected = selectedDate === dateStr;

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
                            <button
                                key={`${cell.type}-${displayDay}-${index}`}
                                type="button"
                                onClick={() => {
                                    if (!isMuted) onSelectDate(dateStr);
                                }}
                                style={calendarCellStyle({
                                    isToday,
                                    isMuted,
                                    isSunday,
                                    isSaturday,
                                    isSelected,
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

                                        {isLongShiftRecord(record.check_in_at, record.check_out_at) && (
                                            <div style={calendarWarningIconStyle} title={t.longShiftWarning}>
                                                ⚠
                                            </div>
                                        )}

                                        {isOpenRecordUnresolved(record) && (
                                            <div style={calendarWarningIconStyle} title={t.unresolvedOpenRecordBadge}>
                                                ⚠
                                            </div>
                                        )}
                                    </>
                                )}

                                {isMuted && <div style={calendarMutedDotStyle}>·</div>}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

type SaveRecordInput = {
    id?: number;
    note: string;
    checkInDateTime?: string;
    checkOutDateTime?: string;
    clearCheckOut?: boolean;
    isNew?: boolean;
};

function RecordDetailPanel({
    selectedDate,
    record,
    workStartTime,
    workEndTime,
    isSaving,
    message,
    onSave,
    onNormalizeLate,
    onSaveLeave,
}: {
    selectedDate: string;
    record: AttendanceRecord | null;
    workStartTime: string | null;
    workEndTime: string | null;
    isSaving: boolean;
    message: string;
    onSave: (input: SaveRecordInput) => void;
    onNormalizeLate: (recordId: number) => void;
    onSaveLeave: (input: { note: string; isNew?: boolean }) => void;
}) {
    const { lang } = useLanguage();
    const c = commonText[lang];
    const t = attendanceText[lang];
    const [note, setNote] = useState(record?.note || "");
    const [blankMode, setBlankMode] = useState<"work" | "leave">("work");

    const baseWorkDate = record?.work_date || selectedDate;
    // 빈 출근/퇴근 입력의 기본값은 브라우저의 "오늘 날짜"가 아니라
    // 관리자가 보고 있는 근무일(work_date) 기준으로 만든다.
    const defaultCheckInValue = getOptionalDefaultShiftDateTimeValue(baseWorkDate, workStartTime);
    const defaultCheckOutValue = getOptionalDefaultShiftDateTimeValue(baseWorkDate, workEndTime);

    const baselineCheckInValue = record?.check_in_at
        ? toDateTimeInputValue(record.check_in_at)
        : defaultCheckInValue;
    const baselineCheckOutValue = record?.check_out_at
        ? toDateTimeInputValue(record.check_out_at)
        : defaultCheckOutValue;

    const [checkInDateTime, setCheckInDateTime] = useState(baselineCheckInValue);
    const [checkOutDateTime, setCheckOutDateTime] = useState(baselineCheckOutValue);

    const canEdit = !!record && record.status !== "leave";
    const isUnresolved = record ? isOpenRecordUnresolved(record) : false;
    const isCurrentlyWorking = !!record?.check_in_at && !record?.check_out_at && !isUnresolved;
    const isLongShift = record ? isLongShiftRecord(record.check_in_at, record.check_out_at) : false;

    // DB 값이 null인 필드는 화면에 기본값(예: 다음 날 01:00)이 채워져 있어도
    // "변경 여부"를 그 기본값 자체와 비교하면 항상 false가 되어 저장되지 않는다.
    // DB가 null이면 입력값이 비어 있지 않은 한 항상 저장 대상으로 취급한다.
    // 휴무 기록(canEdit=false)은 입력 필드 자체가 보이지 않으므로, 남아있는 기본값이
    // 실수로 전송되지 않도록 canEdit일 때만 변경으로 취급한다.
    const checkInChanged =
        canEdit &&
        (record?.check_in_at
            ? checkInDateTime !== toDateTimeInputValue(record.check_in_at)
            : Boolean(checkInDateTime));
    const checkOutChanged =
        canEdit &&
        (record?.check_out_at
            ? checkOutDateTime !== toDateTimeInputValue(record.check_out_at)
            : Boolean(checkOutDateTime));

    const buildSavePayload = (): SaveRecordInput => ({
        id: record?.id,
        note,
        checkInDateTime: checkInChanged ? checkInDateTime : undefined,
        checkOutDateTime: checkOutChanged ? checkOutDateTime : undefined,
    });

    function getStatusLabel(status?: string | null) {
        if (status === "working") return t.working;
        if (status === "done") return t.workDone;
        if (status === "late") return t.workLate;
        if (status === "early_leave") return t.workEarlyLeave;
        if (status === "leave") return t.workLeave;
        return status || "-";
    }

    return (
        <div style={detailPanelStyle}>
            <div style={detailHeaderStyle}>
                <span>{t.attendanceDetail}</span>
                <span style={detailDateStyle}>{selectedDate}</span>
            </div>

            {!record ? (
                <div style={emptyStateWrapStyle}>
                    <div style={emptyInlineStyle}>{t.noRecordHint}</div>

                    <div style={blankModeToggleRowStyle}>
                        <button
                            type="button"
                            style={blankMode === "work" ? blankModeActiveButtonStyle : blankModeInactiveButtonStyle}
                            onClick={() => setBlankMode("work")}
                        >
                            {t.createRecordTab}
                        </button>
                        <button
                            type="button"
                            style={blankMode === "leave" ? blankModeActiveButtonStyle : blankModeInactiveButtonStyle}
                            onClick={() => setBlankMode("leave")}
                        >
                            {t.createLeaveTab}
                        </button>
                    </div>

                    {blankMode === "work" ? (
                        <CreateWorkForm
                            selectedDate={selectedDate}
                            workStartTime={workStartTime}
                            workEndTime={workEndTime}
                            isSaving={isSaving}
                            message={message}
                            onCreate={onSave}
                        />
                    ) : (
                        <CreateLeaveForm isSaving={isSaving} message={message} onCreate={onSaveLeave} />
                    )}
                </div>
            ) : (
                <>
                    <div style={detailGridStyle}>
                        <DetailItem
                            icon="📍"
                            label={c.status}
                            value={
                                isUnresolved
                                    ? t.unresolvedOpenRecordBadge
                                    : isCurrentlyWorking
                                        ? t.working
                                        : getStatusLabel(record.status)
                            }
                        />
                        <DetailItem
                            icon="⏳"
                            label={t.workDurationLabel}
                            value={formatMinutes(Number(record.work_minutes || 0), c)}
                        />
                        <DetailItem icon="🟢" label={t.checkInTimeLabel} value={formatTime(record.check_in_at)} />
                        <DetailItem icon="🔴" label={t.checkOutTimeLabel} value={formatTime(record.check_out_at)} />
                        <DetailItem
                            icon="⏰"
                            label={t.workLate}
                            value={`${Number(record.late_minutes || 0)}${c.minute}`}
                        />
                        <DetailItem
                            icon="🏃"
                            label={t.workEarlyLeave}
                            value={`${Number(record.early_leave_minutes || 0)}${c.minute}`}
                        />
                    </div>

                    {isLongShift ? (
                        <div style={longShiftWarningStyle}>
                            {t.longShiftWarningWithDuration.replace(
                                "{duration}",
                                formatMinutes(Number(record.work_minutes || 0), c)
                            )}
                        </div>
                    ) : null}

                    <div style={editBlockStyle}>
                        <label style={fieldStyle}>
                            <span style={fieldLabelStyle}>{t.note}</span>
                            <textarea
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                                style={textareaStyle}
                                rows={2}
                            />
                        </label>

                        {canEdit ? (
                            <>
                                <label style={fieldStyle}>
                                    <span style={fieldLabelStyle}>{t.checkInDateTimeLabel}</span>
                                    <input
                                        type="datetime-local"
                                        value={checkInDateTime}
                                        onChange={(event) => setCheckInDateTime(event.target.value)}
                                        style={inputStyle}
                                    />
                                    {!workStartTime ? (
                                        <span style={scheduleNoticeStyle}>{t.scheduleCheckInMissingNotice}</span>
                                    ) : null}
                                </label>

                                <label style={fieldStyle}>
                                    <span style={fieldLabelStyle}>{t.checkOutDateTimeLabel}</span>
                                    <input
                                        type="datetime-local"
                                        value={checkOutDateTime}
                                        onChange={(event) => setCheckOutDateTime(event.target.value)}
                                        style={inputStyle}
                                    />
                                    {!workEndTime ? (
                                        <span style={scheduleNoticeStyle}>{t.scheduleCheckOutMissingNotice}</span>
                                    ) : null}
                                </label>
                            </>
                        ) : null}

                        <div style={actionRowStyle}>
                            <button
                                type="button"
                                style={secondaryActionButtonStyle}
                                disabled={isSaving}
                                onClick={() => onSave(buildSavePayload())}
                            >
                                {isSaving ? c.saving : t.saveCorrection}
                            </button>

                            {canEdit && !!record.check_out_at ? (
                                <button
                                    type="button"
                                    style={secondaryActionButtonStyle}
                                    disabled={isSaving}
                                    onClick={() =>
                                        onSave({
                                            ...buildSavePayload(),
                                            clearCheckOut: true,
                                        })
                                    }
                                >
                                    {t.markUnresolved}
                                </button>
                            ) : null}

                            {record.status !== "leave" && Number(record.late_minutes || 0) > 0 ? (
                                <button
                                    type="button"
                                    style={primaryActionButtonStyle}
                                    disabled={isSaving}
                                    onClick={() => onNormalizeLate(record.id)}
                                >
                                    {t.markNormal}
                                </button>
                            ) : null}
                        </div>

                        {message ? <div style={messageStyle}>{message}</div> : null}
                    </div>
                </>
            )}
        </div>
    );
}

function CreateWorkForm({
    selectedDate,
    workStartTime,
    workEndTime,
    isSaving,
    message,
    onCreate,
}: {
    selectedDate: string;
    workStartTime: string | null;
    workEndTime: string | null;
    isSaving: boolean;
    message: string;
    onCreate: (input: SaveRecordInput) => void;
}) {
    const { lang } = useLanguage();
    const c = commonText[lang];
    const t = attendanceText[lang];

    const [checkInDateTime, setCheckInDateTime] = useState(
        getOptionalDefaultShiftDateTimeValue(selectedDate, workStartTime)
    );
    const [checkOutDateTime, setCheckOutDateTime] = useState(
        getOptionalDefaultShiftDateTimeValue(selectedDate, workEndTime)
    );
    const [note, setNote] = useState("");

    return (
        <div style={editBlockStyle}>
            <label style={fieldStyle}>
                <span style={fieldLabelStyle}>{t.checkInDateTimeLabel}</span>
                <input
                    type="datetime-local"
                    value={checkInDateTime}
                    onChange={(event) => setCheckInDateTime(event.target.value)}
                    style={inputStyle}
                />
                {!workStartTime ? (
                    <span style={scheduleNoticeStyle}>{t.scheduleCheckInMissingNotice}</span>
                ) : null}
            </label>

            <label style={fieldStyle}>
                <span style={fieldLabelStyle}>{t.checkOutDateTimeLabel}</span>
                <input
                    type="datetime-local"
                    value={checkOutDateTime}
                    onChange={(event) => setCheckOutDateTime(event.target.value)}
                    style={inputStyle}
                />
                {!workEndTime ? (
                    <span style={scheduleNoticeStyle}>{t.scheduleCheckOutMissingNotice}</span>
                ) : null}
            </label>

            <label style={fieldStyle}>
                <span style={fieldLabelStyle}>{t.note}</span>
                <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    style={textareaStyle}
                    rows={2}
                />
            </label>

            <div style={actionRowStyle}>
                <button
                    type="button"
                    style={primaryActionButtonStyle}
                    disabled={isSaving || !checkInDateTime}
                    onClick={() =>
                        onCreate({
                            note,
                            checkInDateTime,
                            checkOutDateTime: checkOutDateTime || undefined,
                            isNew: true,
                        })
                    }
                >
                    {isSaving ? c.saving : t.createRecordSave}
                </button>
            </div>

            {message ? <div style={messageStyle}>{message}</div> : null}
        </div>
    );
}

function CreateLeaveForm({
    isSaving,
    message,
    onCreate,
}: {
    isSaving: boolean;
    message: string;
    onCreate: (input: { note: string; isNew?: boolean }) => void;
}) {
    const { lang } = useLanguage();
    const c = commonText[lang];
    const t = attendanceText[lang];
    const [reason, setReason] = useState("");

    return (
        <div style={editBlockStyle}>
            <label style={fieldStyle}>
                <span style={fieldLabelStyle}>{t.leaveReasonLabel}</span>
                <input
                    type="text"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    style={inputStyle}
                />
            </label>

            <div style={actionRowStyle}>
                <button
                    type="button"
                    style={primaryActionButtonStyle}
                    disabled={isSaving}
                    onClick={() => onCreate({ note: reason, isNew: true })}
                >
                    {isSaving ? c.saving : t.createLeaveSave}
                </button>
            </div>

            {message ? <div style={messageStyle}>{message}</div> : null}
        </div>
    );
}

function DetailItem({
    icon,
    label,
    value,
}: {
    icon?: string;
    label: string;
    value: string;
}) {
    return (
        <div style={detailItemStyle}>
            <span style={detailItemLabelStyle}>
                {icon ? <span aria-hidden="true">{icon} </span> : null}
                {label}
            </span>
            <strong style={detailItemValueStyle}>{value}</strong>
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

const headerCardStyle: CSSProperties = {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: "10px 12px",
    marginBottom: 12,
};

const headerTopRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
};

const headerIdentityStyle: CSSProperties = {
    minWidth: 0,
    flex: 1,
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

const totalWorkSummaryStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 2,
    flexShrink: 0,
    textAlign: "right",
};

const totalWorkSummaryLabelStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: "#6b7280",
    whiteSpace: "nowrap",
};

const totalWorkSummaryValueStyle: CSSProperties = {
    fontSize: 16,
    fontWeight: 900,
    color: "#111827",
    lineHeight: 1.2,
};

const statStripStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(60px, 1fr))",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1px dashed #e5e7eb",
};

const statChipStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    padding: "6px 4px",
    borderRadius: 10,
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    minWidth: 0,
};

const statChipTopRowStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 12,
    whiteSpace: "nowrap",
};

const statChipValueStyle: CSSProperties = {
    fontWeight: 900,
    color: "#111827",
};

const statChipLabelStyle: CSSProperties = {
    fontSize: 10,
    color: "#6b7280",
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
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
    isSelected,
}: {
    isToday: boolean;
    isMuted: boolean;
    isSunday: boolean;
    isSaturday: boolean;
    isSelected: boolean;
}): CSSProperties {
    return {
        minHeight: 48,
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: 2,
        paddingTop: 4,
        borderTop: "none",
        borderLeft: "none",
        borderRight: "1px solid #e5e7eb",
        borderBottom: "1px solid #e5e7eb",
        background: isSelected ? "#111827" : isToday ? "#f8fbff" : "#ffffff",
        color: isMuted
            ? "#9ca3af"
            : isSelected
                ? "#ffffff"
            : isSunday
                ? "#dc2626"
                : isSaturday
                    ? "#2563eb"
                    : "#111827",
        fontSize: 13,
        fontWeight: isToday ? 800 : 700,
        borderRadius: 0,
        boxSizing: "border-box",
        cursor: isMuted ? "default" : "pointer",
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

const calendarWarningIconStyle: CSSProperties = {
    fontSize: 9,
    lineHeight: 1,
    color: "#f59e0b",
    marginTop: 1,
};

const detailPanelStyle: CSSProperties = {
    ...ui.card,
    marginTop: 12,
    padding: 11,
    display: "grid",
    gap: 8,
};

const detailHeaderStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 13,
    fontWeight: 900,
    color: "#111827",
};

const detailDateStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 800,
    color: "#6b7280",
};

const detailGridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 5,
};

const detailItemStyle: CSSProperties = {
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "6px 7px",
    background: "#ffffff",
};

const detailItemLabelStyle: CSSProperties = {
    display: "block",
    marginBottom: 2,
    fontSize: 10,
    fontWeight: 800,
    color: "#6b7280",
};

const detailItemValueStyle: CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 900,
    color: "#111827",
};

const editBlockStyle: CSSProperties = {
    display: "grid",
    gap: 7,
    borderTop: "1px dashed #e5e7eb",
    paddingTop: 8,
};

const fieldStyle: CSSProperties = {
    display: "grid",
    gap: 4,
};

const fieldLabelStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 900,
    color: "#374151",
};

const scheduleNoticeStyle: CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: "#b45309",
};

const inputStyle: CSSProperties = {
    ...ui.input,
    padding: "7px 8px",
    borderRadius: 8,
    fontSize: 12,
};

const textareaStyle: CSSProperties = {
    ...ui.input,
    minHeight: 54,
    padding: "7px 8px",
    borderRadius: 8,
    fontSize: 12,
    resize: "vertical",
};

const actionRowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6,
};

const secondaryActionButtonStyle: CSSProperties = {
    width: "auto",
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#374151",
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
};

const primaryActionButtonStyle: CSSProperties = {
    ...secondaryActionButtonStyle,
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
};

const messageStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 800,
    color: "#111827",
};

const longShiftWarningStyle: CSSProperties = {
    border: "1px solid #f59e0b",
    background: "#fffbeb",
    color: "#92400e",
    borderRadius: 10,
    padding: "7px 10px",
    fontSize: 12,
    fontWeight: 800,
};

const emptyInlineStyle: CSSProperties = {
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: 10,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.5,
    color: "#6b7280",
    background: "#ffffff",
};

const emptyStateWrapStyle: CSSProperties = {
    display: "grid",
    gap: 8,
};

const blankModeToggleRowStyle: CSSProperties = {
    display: "flex",
    gap: 6,
};

const blankModeButtonBaseStyle: CSSProperties = {
    flex: 1,
    textAlign: "center",
    padding: "8px 10px",
    borderRadius: 10,
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
};

const blankModeActiveButtonStyle: CSSProperties = {
    ...blankModeButtonBaseStyle,
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
};

const blankModeInactiveButtonStyle: CSSProperties = {
    ...blankModeButtonBaseStyle,
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#374151",
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
