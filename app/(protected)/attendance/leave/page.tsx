"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { supabase } from "@/lib/supabase/client";
import { attendanceLeaveText } from "@/lib/text/attendance-leave";
import { getUser, isAdmin } from "@/lib/supabase/auth";

type UserRow = {
  id: string | number;
  name: string;
  username: string;
  part: string | null;
  position: string | null;
  is_active: boolean;
};

type CurrentUser = {
  id: string | number;
  name?: string;
  username?: string;
  role?: string;
};

type AttendanceRecord = {
  id: number;
  user_id: string | number;
  work_date: string;
  status: string;
  note: string | null;
  approval_status: "pending" | "approved" | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string | null;
};

const PART_META: Record<
  string,
  { label: string; color: string; soft: string; emoji: string; rank: number }
> = {
  kitchen: { label: "Kitchen", color: "#f59e0b", soft: "#fff7ed", emoji: "🍳", rank: 1 },
  hall: { label: "Hall", color: "#10b981", soft: "#ecfdf5", emoji: "🍺", rank: 2 },
  bar: { label: "Bar", color: "#3b82f6", soft: "#eff6ff", emoji: "🍸", rank: 3 },
  etc: { label: "Etc", color: "#8b5cf6", soft: "#f5f3ff", emoji: "📦", rank: 99 },
};



function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getVietnamWorkDate() {
  const now = new Date();
  const vietnamTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  if (vietnamTime.getHours() < 3) {
    vietnamTime.setDate(vietnamTime.getDate() - 1);
  }

  return formatDateKey(vietnamTime);
}

function getMonthRange(date: Date) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);

  return {
    startDate: formatDateKey(start),
    endDate: formatDateKey(end),
  };
}

function getCalendarCells(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const firstDate = new Date(year, month, 1);
  const lastDate = new Date(year, month + 1, 0);

  const cells: Array<{ day: number; type: "empty" | "current"; dateKey?: string }> = [];

  for (let i = 0; i < firstDate.getDay(); i += 1) {
    cells.push({ day: 0, type: "empty" });
  }

  for (let day = 1; day <= lastDate.getDate(); day += 1) {
    cells.push({
      day,
      type: "current",
      dateKey: formatDateKey(new Date(year, month, day)),
    });
  }

  return cells;
}

function formatMonthTitle(lang: "ko" | "vi", date: Date) {
  if (lang === "vi") return `Tháng ${date.getMonth() + 1}\n${date.getFullYear()}`;
  return `${String(date.getFullYear()).slice(2)}년 ${date.getMonth() + 1}월`;
}

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
  return (
    PART_META[key] || {
      label: part || "Etc",
      color: "#8b5cf6",
      soft: "#f5f3ff",
      emoji: "📦",
      rank: 99,
    }
  );
}

function normalizeId(value?: string | number | null) {
  return String(value ?? "");
}

function getApprovalStatus(record: AttendanceRecord) {
  return record.approval_status === "approved" ? "approved" : "pending";
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

function formatSummaryDate(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00`);
  return {
    text: String(date.getDate()),
    day: date.getDay(),
  };
}

export default function AttendanceLeavePage() {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const tabs = getAttendanceTabs(pathname, lang);
  const t = attendanceLeaveText[lang];

  const currentUser = getUser();
  const canManageLeave = isAdmin(currentUser);

  const todayWorkDate = getVietnamWorkDate();

  const [calendarDate, setCalendarDate] = useState(new Date());
  const [users, setUsers] = useState<UserRow[]>([]);
  const [leaveRecords, setLeaveRecords] = useState<AttendanceRecord[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayWorkDate);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchLeaveData();
  }, [calendarDate]);

  const fetchLeaveData = async () => {
    setIsLoading(true);

    try {
      const { startDate, endDate } = getMonthRange(calendarDate);

      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("id, name, username, part, position, is_active")
        .eq("is_active", true)
        .neq("position", "owner");

      if (userError) {
        console.log("fetch users error:", JSON.stringify(userError, null, 2));
        return;
      }

      const { data: recordData, error: recordError } = await supabase
        .from("attendance_records")
        .select("id, user_id, work_date, status, note, approval_status, approved_by, approved_at, created_at")
        .eq("status", "leave")
        .gte("work_date", startDate)
        .lte("work_date", endDate);

      if (recordError) {
        console.log("fetch leave records error:", JSON.stringify(recordError, null, 2));
        return;
      }

      setUsers(userData || []);
      setLeaveRecords(recordData || []);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLeaveRequest = async () => {
    if (!currentUser?.id) {
      alert(lang === "vi" ? "Vui lòng đăng nhập lại." : "다시 로그인해주세요.");
      return;
    }

    const alreadyRequested = leaveRecords.find(
      (record) =>
        normalizeId(record.user_id) === normalizeId(currentUser.id) &&
        record.work_date === selectedDate
    );

    if (alreadyRequested) {
      const ok = confirm(lang === "vi" ? "Hủy ngày nghỉ này?" : "이 휴무 신청을 취소할까요?");
      if (!ok) return;

      const { data, error } = await supabase
        .from("attendance_records")
        .delete()
        .eq("id", alreadyRequested.id)
        .eq("status", "leave")
        .select("id");

      console.log("leave cancel result:", { data, error });

      if (error) {
        alert(error.message);
        return;
      }

      if (!data || data.length === 0) {
        alert("삭제된 휴무 신청이 없습니다. 조건 불일치 또는 권한 문제입니다.");
        return;
      }

      await fetchLeaveData();
      return;
    }

    const day = new Date(`${selectedDate}T12:00:00`).getDay();
    const isFridayOrSaturday = day === 5 || day === 6;

    let reason = "";

    if (isFridayOrSaturday) {
      const input = prompt(
        lang === "vi"
          ? "Vui lòng nhập lý do nghỉ."
          : "금/토요일 휴무는 사유를 입력해주세요."
      );

      if (!input?.trim()) return;
      reason = input.trim();
    }

    const { error } = await supabase.from("attendance_records").insert({
      user_id: currentUser.id,
      work_date: selectedDate,
      status: "leave",
      note: reason,
      approval_status: "pending",
    });

    if (error) {
      alert(error.message);
      return;
    }

    await fetchLeaveData();
  };

  const handleApproveLeave = async (recordId: number) => {
    if (!canManageLeave) return;

    const { error } = await supabase
      .from("attendance_records")
      .update({
        approval_status: "approved",
        approved_by: currentUser?.name || currentUser?.username || null,
        approved_at: new Date().toISOString(),
      })
      .eq("id", recordId);

    if (error) {
      alert(error.message);
      return;
    }

    await fetchLeaveData();
  };

  const handleCancelApproval = async (recordId: number) => {
    if (!canManageLeave) return;

    const { data, error } = await supabase
      .from("attendance_records")
      .update({
        approval_status: "pending",
        approved_by: null,
        approved_at: null,
      })
      .eq("id", recordId)
      .eq("status", "leave")
      .select("id, approval_status, approved_by, approved_at");

    console.log("cancel approval result:", { data, error });

    if (error) {
      alert(error.message);
      return;
    }

    if (!data || data.length === 0) {
      alert("승인취소된 데이터가 없습니다. 조건 불일치 또는 권한 문제입니다.");
      return;
    }

    await fetchLeaveData();
  };

  const handleCancelPendingLeave = async (recordId: number) => {

    const ok = confirm(
      lang === "vi"
        ? "Hủy yêu cầu nghỉ này?"
        : "이 휴무 신청을 취소할까요?"
    );
    if (!ok) return;

    const { data, error } = await supabase
      .from("attendance_records")
      .delete()
      .eq("id", recordId)
      .eq("status", "leave")
      .select("id");

    console.log("cancel pending leave result:", { data, error });

    if (error) {
      alert(error.message);
      return;
    }

    if (!data || data.length === 0) {
      alert("취소된 휴무 신청이 없습니다. 조건 불일치 또는 권한 문제입니다.");
      return;
    }

    await fetchLeaveData();
  };

  const userMap = useMemo(() => {
    const map = new Map<string, UserRow>();
    users.forEach((user) => map.set(normalizeId(user.id), user));
    return map;
  }, [users]);



  const selectedDateLeaves = useMemo(() => {
    return leaveRecords
      .filter((record) => record.work_date === selectedDate)
      .map((record) => {
        const user = userMap.get(normalizeId(record.user_id));
        if (!user) return null;
        return { user, record };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const itemA = a as { user: UserRow; record: AttendanceRecord };
        const itemB = b as { user: UserRow; record: AttendanceRecord };

        if (itemA.record.created_at && itemB.record.created_at) {
          return itemA.record.created_at.localeCompare(itemB.record.created_at);
        }

        return itemA.record.id - itemB.record.id;
      }) as Array<{ user: UserRow; record: AttendanceRecord }>;
  }, [leaveRecords, selectedDate, userMap]);

  const leaveCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    leaveRecords.forEach((record) => {
      map.set(record.work_date, (map.get(record.work_date) || 0) + 1);
    });
    return map;
  }, [leaveRecords]);

  const staffSummaryGroups = useMemo(() => {
    const summaryMap = new Map<string, { count: number; dates: string[] }>();

    leaveRecords.forEach((record) => {
      const userId = normalizeId(record.user_id);
      const prev = summaryMap.get(userId) || { count: 0, dates: [] };

      summaryMap.set(userId, {
        count: prev.count + 1,
        dates: [...prev.dates, record.work_date],
      });
    });

    const groupMap = new Map<
      string,
      Array<{ user: UserRow; count: number; dates: string[] }>
    >();

    summaryMap.forEach((summary, userId) => {
      const user = userMap.get(userId);
      if (!user) return;

      const key = getPartKey(user.part);
      const prev = groupMap.get(key) || [];

      groupMap.set(key, [
        ...prev,
        {
          user,
          count: summary.count,
          dates: summary.dates.sort(),
        },
      ]);
    });

    return Array.from(groupMap.entries())
      .map(([part, items]) => ({
        part,
        meta: getPartMeta(part),
        items: items.sort((a, b) => {
          const positionDiff =
            getPositionRank(a.user.position) - getPositionRank(b.user.position);
          if (positionDiff !== 0) return positionDiff;
          return a.user.name.localeCompare(b.user.name);
        }),
      }))
      .sort((a, b) => a.meta.rank - b.meta.rank);
  }, [leaveRecords, userMap]);

  const calendarCells = useMemo(() => getCalendarCells(calendarDate), [calendarDate]);

  const mySelectedRecord = leaveRecords.find(
    (record) =>
      normalizeId(record.user_id) === normalizeId(currentUser?.id) &&
      record.work_date === selectedDate
  );

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        <SectionTitle title={t.monthCalendar} />

        <div style={cardStyle}>
          <div style={calendarHeaderStyle}>
            <button
              type="button"
              style={monthButtonStyle}
              onClick={() => {
                const next = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
                setCalendarDate(next);
                setSelectedDate(formatDateKey(next));
              }}
            >
              ‹
            </button>

            <div style={calendarTitleStyle}>{formatMonthTitle(lang, calendarDate)}</div>

            <button
              type="button"
              style={monthButtonStyle}
              onClick={() => {
                const next = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
                setCalendarDate(next);
                setSelectedDate(formatDateKey(next));
              }}
            >
              ›
            </button>
          </div>

          <div style={weekGridStyle}>
            {(lang === "vi"
              ? ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]
              : ["일", "월", "화", "수", "목", "금", "토"]
            ).map((day, index) => (
              <div
                key={day}
                style={{
                  ...weekCellStyle,
                  color: index === 0 ? "#dc2626" : index === 6 ? "#2563eb" : "#6b7280",
                }}
              >
                {day}
              </div>
            ))}
          </div>

          <div style={calendarGridStyle}>
            {calendarCells.map((cell, index) => {
              if (cell.type === "empty") {
                return <div key={`empty-${index}`} style={emptyCalendarCellStyle} />;
              }

              const count = leaveCountByDate.get(cell.dateKey || "") || 0;
              const active = selectedDate === cell.dateKey;
              const isSunday = index % 7 === 0;
              const isSaturday = index % 7 === 6;

              return (
                <button
                  key={cell.dateKey}
                  type="button"
                  onClick={() => setSelectedDate(cell.dateKey || todayWorkDate)}
                  style={{
                    ...calendarCellStyle,
                    borderColor: active ? "#111827" : "#e5e7eb",
                    background: active ? "#111827" : "#ffffff",
                    color: active
                      ? "#ffffff"
                      : isSunday
                        ? "#dc2626"
                        : isSaturday
                          ? "#2563eb"
                          : "#111827",
                  }}
                >
                  <span>{cell.day}</span>
                  {count > 0 && (
                    <span
                      style={{
                        ...countDotStyle,
                        background: active ? "#ffffff" : "#111827",
                        color: active ? "#111827" : "#ffffff",
                      }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={selectedListStyle}>
            {selectedDateLeaves.length === 0 ? (
              <div style={selectedEmptyStyle}>{t.noLeave}</div>
            ) : (
              selectedDateLeaves.map((item, index) => {
                const { user, record } = item;
                const meta = getPartMeta(user.part);
                const isApproved = getApprovalStatus(record) === "approved";

                return (
                  <div
                    key={record.id}
                    style={{
                      ...selectedUserCardStyle,
                      borderLeft: `4px solid ${meta.color}`,
                    }}
                  >
                    <div style={selectedUserTopStyle}>
                      <div style={selectedUserLeftStyle}>
                        <span
                          style={{
                            ...partMiniStyle,
                            color: meta.color,
                            background: meta.soft,
                          }}
                        >
                          {meta.emoji}
                        </span>
                        <span style={userNameStyle}>
                          {index + 1}. {user.name}
                        </span>
                        <span style={userMetaStyle}>{user.position || user.username}</span>
                      </div>

                      <div style={leaveActionRowStyle}>
                        <span
                          style={{
                            ...approvalBadgeStyle,
                            color: isApproved ? "#10b981" : "#f59e0b",
                            borderColor: isApproved ? "#10b981" : "#f59e0b",
                            background: isApproved ? "#ecfdf5" : "#fffbeb",
                          }}
                        >
                          {isApproved
                            ? lang === "vi"
                              ? "Đã duyệt"
                              : "승인완료"
                            : lang === "vi"
                              ? "Chờ duyệt"
                              : "승인대기"}
                        </span>

                        {canManageLeave ? (
                          <button
                            type="button"
                            style={isApproved ? cancelApprovalButtonStyle : approveButtonStyle}
                            onClick={() =>
                              isApproved ? handleCancelApproval(record.id) : handleApproveLeave(record.id)
                            }
                          >
                            {isApproved
                              ? lang === "vi"
                                ? "Hủy"
                                : "취소"
                              : lang === "vi"
                                ? "Duyệt"
                                : "승인"}
                          </button>
                        ) : (
                          normalizeId(currentUser?.id) === normalizeId(record.user_id) &&
                          !isApproved && (
                            <button
                              type="button"
                              style={cancelApprovalButtonStyle}
                              onClick={() => handleCancelPendingLeave(record.id)}
                            >
                              {lang === "vi" ? "Hủy" : "취소"}
                            </button>
                          )
                        )}
                      </div>
                    </div>

                    {record.note && <div style={reasonStyle}>{record.note}</div>}


                  </div>
                );
              })
            )}

            {!canManageLeave && (
              <button type="button" style={requestButtonStyle} onClick={handleLeaveRequest}>
                {mySelectedRecord
                  ? lang === "vi"
                    ? "Hủy ngày nghỉ"
                    : "휴무취소"
                  : lang === "vi"
                    ? "Đăng ký nghỉ"
                    : "휴무신청"}
              </button>
            )}
          </div>
        </div>

        <SectionTitle title={t.staffSummary} />

        <div style={cardStyle}>
          {isLoading ? (
            <Empty text={t.loading} />
          ) : staffSummaryGroups.length === 0 ? (
            <Empty text={t.noLeave} />
          ) : (
            <div style={summaryListStyle}>
              {staffSummaryGroups.map((group) => (
                <div key={group.part} style={summaryGroupStyle}>
                  <div
                    style={{
                      ...partTitleStyle,
                      color: group.meta.color,
                      background: group.meta.soft,
                      borderLeft: `4px solid ${group.meta.color}`,
                    }}
                  >
                    {group.meta.emoji} {group.meta.label}
                  </div>

                  {group.items.map((item) => (
                    <div key={item.user.id} style={summaryRowStyle}>
                      <span style={userNameStyle}>{item.user.name}</span>
                      <span style={userMetaStyle}>{item.user.position || item.user.username}</span>
                      <span style={summaryCountStyle}>
                        {item.count}
                        {t.days}
                        <span style={summaryDatesStyle}>
                          (
                          {item.dates.map((dateKey, index) => {
                            const date = formatSummaryDate(dateKey);

                            return (
                              <span
                                key={dateKey}
                                style={{
                                  color:
                                    date.day === 0
                                      ? "#dc2626"
                                      : date.day === 6
                                        ? "#2563eb"
                                        : "#6b7280",
                                }}
                              >
                                {index > 0 ? ", " : ""}
                                {date.text}
                              </span>
                            );
                          })}
                          )
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Container>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <div style={sectionTitleStyle}>{title}</div>;
}

function Empty({ text }: { text: string }) {
  return <div style={emptyStyle}>{text}</div>;
}

const summaryDatesStyle: CSSProperties = {
  marginLeft: 4,
  fontSize: 11,
  fontWeight: 800,
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 10,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 900,
  color: "#111827",
  padding: "0 2px",
};

const cardStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 14,
  padding: 12,
};

const calendarHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  marginBottom: 10,
};

const calendarTitleStyle: CSSProperties = {
  width: 70,
  textAlign: "center",
  fontSize: 13,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "pre-line",
  lineHeight: 1.2,
};

const monthButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 8,
  border: "1px solid #d1d5db",
  background: "#ffffff",
  color: "#111827",
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
};

const weekGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 4,
  marginBottom: 4,
};

const weekCellStyle: CSSProperties = {
  textAlign: "center",
  fontSize: 11,
  fontWeight: 800,
};

const calendarGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(7, 1fr)",
  gap: 4,
};

const emptyCalendarCellStyle: CSSProperties = {
  height: 34,
};

const calendarCellStyle: CSSProperties = {
  height: 34,
  border: "1px solid #e5e7eb",
  borderRadius: 9,
  background: "#ffffff",
  fontSize: 12,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  cursor: "pointer",
};

const countDotStyle: CSSProperties = {
  minWidth: 15,
  height: 15,
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 900,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const selectedListStyle: CSSProperties = {
  marginTop: 10,
  display: "grid",
  gap: 7,
};

const selectedEmptyStyle: CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: "#f9fafb",
  color: "#6b7280",
  fontSize: 12,
  textAlign: "center",
};

const selectedUserCardStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: "8px 9px",
  borderRadius: 10,
  background: "#f9fafb",
};

const selectedUserTopStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const selectedUserLeftStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

const partMiniStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
};

const userNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
};

const userMetaStyle: CSSProperties = {
  fontSize: 11,
  color: "#6b7280",
};

const approvalBadgeStyle: CSSProperties = {
  border: "1px solid",
  borderRadius: 999,
  padding: "3px 7px",
  fontSize: 11,
  fontWeight: 900,
  whiteSpace: "nowrap",
};

const leaveActionRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
};

const reasonStyle: CSSProperties = {
  fontSize: 11,
  color: "#6b7280",
  paddingLeft: 30,
};



const approveButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 8,
  background: "#10b981",
  color: "#ffffff",
  padding: "6px 9px",
  fontSize: 12,
  fontWeight: 900,
  cursor: "pointer",
};

const cancelApprovalButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 8,
  background: "#ef4444",
  color: "#ffffff",
  padding: "6px 9px",
  fontSize: 12,
  fontWeight: 900,
  cursor: "pointer",
};

const requestButtonStyle: CSSProperties = {
  width: "100%",
  height: 40,
  border: "none",
  borderRadius: 10,
  background: "#111827",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 900,
  cursor: "pointer",
};

const summaryListStyle: CSSProperties = {
  display: "grid",
  gap: 10,
};

const summaryGroupStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const partTitleStyle: CSSProperties = {
  borderRadius: 10,
  padding: "7px 9px",
  fontSize: 13,
  fontWeight: 900,
};

const summaryRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 8px",
  border: "1px solid #f3f4f6",
  borderRadius: 10,
};

const summaryCountStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 12,
  fontWeight: 900,
  color: "#111827",
};

const emptyStyle: CSSProperties = {
  padding: 14,
  textAlign: "center",
  color: "#6b7280",
  fontSize: 13,
};