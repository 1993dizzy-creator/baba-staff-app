"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { supabase } from "@/lib/supabase/client";
import { attendanceStaffText } from "@/lib/text/attendance-staff";

type UserRow = {
  id: string;
  name: string;
  username: string;
  part: string | null;
  position: string | null;
  is_active: boolean;
};

type AttendanceRecord = {
  id: number;
  user_id: string;
  work_date: string;
  status: string;
  check_in_at: string | null;
  check_out_at: string | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  work_minutes: number | null;
  approval_status: "pending" | "approved" | null;
};

const PART_META: Record<
  string,
  {
    label: string;
    emoji: string;
    color: string;
    bg: string;
    border: string;
    rank: number;
  }
> = {
  kitchen: {
    label: "Kitchen",
    emoji: "🍳",
    color: "#f59e0b",
    bg: "#fff7ed",
    border: "#f59e0b",
    rank: 1,
  },
  hall: {
    label: "Hall",
    emoji: "🍺",
    color: "#10b981",
    bg: "#ecfdf5",
    border: "#10b981",
    rank: 2,
  },
  bar: {
    label: "Bar",
    emoji: "🍸",
    color: "#3b82f6",
    bg: "#eff6ff",
    border: "#3b82f6",
    rank: 3,
  },
  etc: {
    label: "Etc",
    emoji: "📦",
    color: "#8b5cf6",
    bg: "#f5f3ff",
    border: "#8b5cf6",
    rank: 99,
  },
};

function getVietnamWorkDate() {
  const now = new Date();
  const vietnamTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  if (vietnamTime.getHours() < 3) {
    vietnamTime.setDate(vietnamTime.getDate() - 1);
  }

  const year = vietnamTime.getFullYear();
  const month = String(vietnamTime.getMonth() + 1).padStart(2, "0");
  const day = String(vietnamTime.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatTime(value: string | null) {
  if (!value) return "-";

  return new Date(value).toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatWorkMinutes(minutes?: number | null) {
  const total = Number(minutes || 0);
  const h = String(Math.floor(total / 60)).padStart(2, "0");
  const m = String(total % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function isApprovedLeave(record?: AttendanceRecord) {
  return record?.status === "leave" && record?.approval_status === "approved";
}

function getStatusText(
  t: (typeof attendanceStaffText)["ko"] | (typeof attendanceStaffText)["vi"],
  record?: AttendanceRecord
) {
  if (!record) return t.statusNotChecked;

  if (record.status === "working") return t.statusWorking;
  if (record.status === "done") return t.statusDone;
  if (record.status === "early_leave") return t.statusEarlyLeave;
  if (isApprovedLeave(record)) return t.statusLeave;
  if (record.status === "leave") return t.statusNotChecked;

  return record.status;
}

function getStatusColor(record?: AttendanceRecord) {
  if (!record) return "#6b7280";
  if (record.status === "working") return "#2563eb";
  if (record.status === "done") return "#10b981";
  if (record.status === "early_leave") return "#ef4444";
  if (isApprovedLeave(record)) return "#6b7280";
  if (record.status === "leave") return "#6b7280";
  return "#6b7280";
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

export default function AttendanceStaffPage() {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const tabs = getAttendanceTabs(pathname, lang);
  const t = attendanceStaffText[lang];

  const todayWorkDate = getVietnamWorkDate();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchList();
  }, []);

  const fetchList = async () => {
    setIsLoading(true);

    try {
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
        .select("*")
        .eq("work_date", todayWorkDate);

      if (recordError) {
        console.log("fetch attendance records error:", JSON.stringify(recordError, null, 2));
        return;
      }

      setUsers(userData || []);
      setRecords(recordData || []);
    } finally {
      setIsLoading(false);
    }
  };

  const recordMap = useMemo(() => {
    const map = new Map<string, AttendanceRecord>();

    records.forEach((record) => {
      const prev = map.get(record.user_id);

      if (!prev) {
        map.set(record.user_id, record);
        return;
      }

      if (isApprovedLeave(record)) {
        map.set(record.user_id, record);
      }
    });

    return map;
  }, [records]);

  const groupedUsers = useMemo(() => {
    const groupMap = new Map<string, UserRow[]>();

    users.forEach((user) => {
      const partKey = getPartKey(user.part);
      const prev = groupMap.get(partKey) || [];
      groupMap.set(partKey, [...prev, user]);
    });

    return Array.from(groupMap.entries())
      .map(([part, groupUsers]) => ({
        part,
        meta: getPartMeta(part),
        users: groupUsers.sort((a, b) => {
          const rankDiff = getPositionRank(a.position) - getPositionRank(b.position);
          if (rankDiff !== 0) return rankDiff;
          return a.name.localeCompare(b.name);
        }),
      }))
      .sort((a, b) => {
        const rankDiff = a.meta.rank - b.meta.rank;
        if (rankDiff !== 0) return rankDiff;
        return a.part.localeCompare(b.part);
      });
  }, [users]);

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        {isLoading ? (
          <div style={emptyStyle}>{t.loading}</div>
        ) : groupedUsers.length === 0 ? (
          <div style={emptyStyle}>{t.empty}</div>
        ) : (
          groupedUsers.map((group) => (
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
                <span style={partCountStyle}>{group.users.length}</span>
              </div>

              <div style={partListStyle}>
                {group.users.map((user) => {
                  const record = recordMap.get(user.id);
                  const statusColor = getStatusColor(record);
                  const isExpanded = expandedUserId === user.id;

                  return (
                    <div key={user.id} style={staffCardStyle}>
                      <button
                        type="button"
                        onClick={() => setExpandedUserId(isExpanded ? null : user.id)}
                        style={staffSummaryButtonStyle}
                      >
                        <div style={staffLeftStyle}>
                          <span style={staffNameStyle}>{user.name}</span>
                          <span style={staffMetaStyle}>{user.position || user.username}</span>
                        </div>

                        <div style={staffRightStyle}>
                          <span
                            style={{
                              ...miniBadgeStyle,
                              borderColor: statusColor,
                              color: statusColor,
                            }}
                          >
                            {getStatusText(t, record)}
                          </span>

                          <span style={expandIconStyle}>{isExpanded ? "⌃" : "⌄"}</span>
                        </div>
                      </button>

                      {isExpanded && (
                        <div style={detailGridStyle}>
                          <InfoBox label={t.checkIn} value={formatTime(record?.check_in_at || null)} />
                          <InfoBox label={t.checkOut} value={formatTime(record?.check_out_at || null)} />
                          <InfoBox label={t.workTime} value={formatWorkMinutes(record?.work_minutes)} />
                          <InfoBox
                            label={t.late}
                            value={`${Number(record?.late_minutes || 0)}${t.minute}`}
                          />
                          <InfoBox
                            label={t.earlyLeave}
                            value={`${Number(record?.early_leave_minutes || 0)}${t.minute}`}
                          />
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
  border: "1px solid",
  borderRadius: 999,
  padding: "3px 7px",
  fontSize: 11,
  fontWeight: 800,
  background: "#ffffff",
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
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: 6,
  marginTop: 8,
};

const infoBoxStyle: CSSProperties = {
  background: "#f9fafb",
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