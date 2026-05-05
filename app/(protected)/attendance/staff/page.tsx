"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { commonText, attendanceText } from "@/lib/text";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { ATTENDANCE_STATUS } from "@/lib/attendance/status";
import { PART_META, type PartValue,} from "@/lib/common/parts";


type UserRow = {
  id: string;
  name: string;
  username: string;
  role: string | null;
  part: string | null;
  position: string | null;
  is_active: boolean;
  work_start_time: string | null;
  work_end_time: string | null;
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
  return record?.status === ATTENDANCE_STATUS.LEAVE && record?.approval_status === "approved";
}

function getStatusText(
  t: (typeof attendanceText)["ko"] | (typeof attendanceText)["vi"],
  record?: AttendanceRecord
) {
  if (!record) return t.workBefore;

  if (record.status === ATTENDANCE_STATUS.WORKING) return t.working;
  if (record.status === ATTENDANCE_STATUS.DONE) return t.workDone;
  if (record.status === ATTENDANCE_STATUS.EARLY_LEAVE) return t.workEarlyLeave;
  if (isApprovedLeave(record)) return t.workLeave;
  if (record.status === ATTENDANCE_STATUS.LEAVE) return t.workBefore;

  return record.status;
}

function getStatusColor(record?: AttendanceRecord) {
  if (!record) return "#6b7280";
  if (record.status === ATTENDANCE_STATUS.WORKING) return "#10b981";
  if (record.status === ATTENDANCE_STATUS.DONE) return "#2563eb";
  if (record.status === ATTENDANCE_STATUS.EARLY_LEAVE) return "#ef4444";
  if (isApprovedLeave(record)) return "#6b7280";
  if (record.status === ATTENDANCE_STATUS.LEAVE) return "#6b7280";
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

function getPartKey(part?: string | null): PartValue {
  if (part === "kitchen") return "kitchen";
  if (part === "hall") return "hall";
  if (part === "bar") return "bar";
  return "etc";
}

function getPartMeta(part?: string | null) {
  const key = getPartKey(part);
  return PART_META[key];
}

export default function AttendanceStaffPage() {
  const { lang } = useLanguage();
  const pathname = usePathname();
  const tabs = getAttendanceTabs(pathname, lang);
  const t = attendanceText[lang];
const c = commonText[lang];

  const todayWorkDate = getVietnamWorkDate();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loginUser, setLoginUser] = useState<any>(null);
  const canManage = isAdmin(loginUser);

  const [manualModal, setManualModal] = useState<{
    type: "check_in" | "check_out";
    user: UserRow;
    mode: "standard" | "manual";
    timeValue: string;
  } | null>(null);

  useEffect(() => {
    setLoginUser(getUser());
    fetchList();
  }, []);

  const fetchList = async () => {
    setIsLoading(true);

    try {
      const userRes = await fetch("/api/attendance/users");
      const userResult = await userRes.json();

      if (!userRes.ok || !userResult.ok) {
        console.log("fetch users error:", userResult);
        return;
      }

      const userData = userResult.users || [];

      const recordRes = await fetch(
        `/api/attendance/records?work_date=${todayWorkDate}`
      );

      const recordResult = await recordRes.json();

      if (!recordRes.ok || !recordResult.ok) {
        console.log("fetch attendance records error:", recordResult);
        return;
      }

      const recordData = recordResult.records || [];

      setUsers((userData as UserRow[]).filter((user) => !isAdmin(user)));
      setRecords(recordData || []);
    } finally {
      setIsLoading(false);
    }
  };

  const handleForceCheckIn = async (user: UserRow, time: string) => {
    const me = getUser();
    try {
      const res = await fetch("/api/attendance/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "force_check_in",
          user_id: user.id,
          work_date: todayWorkDate,
          time,
          admin_name: me?.name || "",
        }),
      });

      const result = await res.json();

      if (!res.ok || !result.ok) {
        alert(result.message || c.editFail);
        return;
      }

      await fetchList();
    } catch (err) {
      console.error(err);
      alert(c.editFail);
    }
  };

  const handleForceCheckOut = async (user: UserRow, time: string) => {
    const me = getUser();

    try {
      const res = await fetch("/api/attendance/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "force_check_out",
          user_id: user.id,
          work_date: todayWorkDate,
          time,
          admin_name: me?.name || "",
        }),
      });

      const result = await res.json();

      if (!res.ok || !result.ok) {
        alert(result.message || c.editFail);
        return;
      }

      await fetchList();
    } catch (err) {
      console.error(err);
      alert(c.editFail);
    }
  };

  const handleSetLeave = async (user: UserRow) => {
    const me = getUser();
    try {
      const res = await fetch("/api/attendance/admin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "set_leave",
          user_id: user.id,
          work_date: todayWorkDate,
          admin_name: me?.name || "",
        }),
      });

      const result = await res.json();

      if (!res.ok || !result.ok) {
        alert(result.message || c.editFail);
        return;
      }

      await fetchList();
    } catch (err) {
      console.error(err);
      alert(c.editFail);
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
          <div style={emptyStyle}>{c.loading}</div>
        ) : groupedUsers.length === 0 ? (
          <div style={emptyStyle}>{c.noData}</div>
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
                <span>
                 {c[group.part as keyof typeof c] || group.part}
                </span>
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
                          <span style={staffMetaStyle}>
                            {user.position
  ? c[user.position as keyof typeof c] || user.position
  : user.username}
                          </span>
                        </div>

                        <div style={staffRightStyle}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span
                              style={{
                                ...miniBadgeStyle,
                                borderColor: statusColor,
                                color: statusColor,
                              }}
                            >
                              {getStatusText(t, record)}
                            </span>

                            {Number(record?.late_minutes || 0) > 0 && (
                              <span
                                style={{
                                  ...miniBadgeStyle,
                                  borderColor: "#f59e0b",
                                  color: "#f59e0b",
                                }}
                              >
                                {t.workLate}
                              </span>
                            )}
                          </div>

                          <span style={expandIconStyle}>{isExpanded ? "⌃" : "⌄"}</span>
                        </div>
                      </button>

                      {isExpanded && (
                        <>
                          <div style={detailGridStyle}>
                            <InfoBox label={t.checkIn} value={formatTime(record?.check_in_at || null)} />
                            <InfoBox label={t.checkOut} value={formatTime(record?.check_out_at || null)} />
                            <InfoBox label={t.workTime} value={formatWorkMinutes(record?.work_minutes)} />
                            <InfoBox
                              label={t.workLate}
                              value={`${Number(record?.late_minutes || 0)}${c.minute}`}
                            />
                            <InfoBox
                              label={t.workEarlyLeave}
                              value={`${Number(record?.early_leave_minutes || 0)}${c.minute}`}
                            />
                          </div>

                          {canManage && (
                            <div
                              style={{
                                marginTop: 8,
                                padding: 8,
                                borderRadius: 12,
                                border: "1px solid #d1d5db",
                                background: "#ffffff",
                                display: "grid",
                                gridTemplateColumns: "repeat(3, 1fr)",
                                gap: 6,
                              }}
                            >
                              <button
                                type="button"
                                style={{
                                  padding: "7px 6px",
                                  borderRadius: 9,
                                  border: "1px solid #bfdbfe",
                                  background: "#eff6ff",
                                  color: "#1d4ed8",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  cursor: "pointer",
                                }}
                                onClick={() =>
                                  setManualModal({
                                    type: "check_in",
                                    user,
                                    mode: "standard",
                                    timeValue: user.work_start_time || "16:00",
                                  })
                                }
                              >
                                {t.updateCheckIn}
                              </button>

                              <button
                                type="button"
                                style={{
                                  padding: "7px 6px",
                                  borderRadius: 9,
                                  border: "1px solid #bbf7d0",
                                  background: "#f0fdf4",
                                  color: "#15803d",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  cursor: "pointer",
                                }}
                                onClick={() =>
                                  setManualModal({
                                    type: "check_out",
                                    user,
                                    mode: "standard",
                                    timeValue: user.work_end_time || "01:00",
                                  })
                                }
                              >
                                {t.updateCheckOut}
                              </button>

                              <button
                                type="button"
                                style={{
                                  padding: "7px 6px",
                                  borderRadius: 9,
                                  border: "1px solid #fecaca",
                                  background: "#fef2f2",
                                  color: "#dc2626",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  cursor: "pointer",
                                }}
                                onClick={() => handleSetLeave(user)}
                              >
                                {t.workLeave}
                              </button>
                            </div>
                          )}
                        </>
                      )}

                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {manualModal && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <div style={modalTitleStyle}>
              {manualModal.user.name}{" "}
              {manualModal.type === "check_in" ? t.checkInProcess : t.checkOutProcess}
            </div>

            {manualModal.mode === "standard" ? (
              <>
                <div style={modalOptionGridStyle}>
                  <button
                    type="button"
                    style={{
                      ...modalOptionButtonStyle,
                      borderColor: "#2563eb",
                      background: "#eff6ff",
                      color: "#1d4ed8",
                    }}
                    onClick={() => {
                      if (manualModal.type === "check_in") {
                        handleForceCheckIn(manualModal.user, manualModal.timeValue);
                      } else {
                        handleForceCheckOut(manualModal.user, manualModal.timeValue);
                      }
                    }}
                  >
                    {manualModal.type === "check_in" ? t.standardCheckIn : t.standardCheckOut}
                  </button>

                  <button
                    type="button"
                    style={modalOptionButtonStyle}
                    onClick={() =>
                      setManualModal((prev) =>
                        prev
                          ? {
                            ...prev,
                            mode: "manual",
                            timeValue:
                              prev.type === "check_in"
                                ? recordMap.get(prev.user.id)?.check_in_at
                                  ? formatTime(recordMap.get(prev.user.id)?.check_in_at || null)
                                  : prev.user.work_start_time || "16:00"
                                : recordMap.get(prev.user.id)?.check_out_at
                                  ? formatTime(recordMap.get(prev.user.id)?.check_out_at || null)
                                  : prev.user.work_end_time || "01:00",
                          }
                          : prev
                      )
                    }
                  >
                    {c.directInput}
                  </button>
                </div>

                <button
                  type="button"
                  style={{ ...modalCancelButtonStyle, width: "100%", marginTop: 8 }}
                  onClick={() => setManualModal(null)}
                >
                  {c.cancel}
                </button>
              </>
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <input
                    type="time"
                    value={manualModal.timeValue}
                    onChange={(e) =>
                      setManualModal((prev) =>
                        prev ? { ...prev, timeValue: e.target.value } : prev
                      )
                    }
                    style={modalInputStyle}
                  />

                  <button
                    type="button"
                    style={modalSubmitButtonStyle}
                    onClick={() => {
                      if (manualModal.type === "check_in") {
                        handleForceCheckIn(manualModal.user, manualModal.timeValue);
                      } else {
                        handleForceCheckOut(manualModal.user, manualModal.timeValue);
                      }
                    }}
                  >
                    {c.submit}
                  </button>
                </div>

                <button
                  type="button"
                  style={{ ...modalCancelButtonStyle, width: "100%", marginTop: 8 }}
                  onClick={() => setManualModal(null)}
                >
                  {c.cancel}
                </button>
              </>
            )}
          </div>
        </div>
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

const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};

const modalBoxStyle: CSSProperties = {
  width: "100%",
  maxWidth: 340,
  background: "#ffffff",
  borderRadius: 16,
  padding: 16,
  boxShadow: "0 18px 40px rgba(0,0,0,0.18)",
};

const modalTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 900,
  color: "#111827",
  marginBottom: 12,
};

const modalOptionGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
};

const modalOptionButtonStyle: CSSProperties = {
  padding: "10px 8px",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

const modalInputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #d1d5db",
  fontSize: 14,
  fontWeight: 700,
  boxSizing: "border-box",
};

const modalSubmitButtonStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "none",
  background: "#111827",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const modalCancelButtonStyle: CSSProperties = {
  padding: "10px 8px",
  borderRadius: 10,
  border: "1px solid #d1d5db",
  background: "#ffffff",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
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
  border: "1px solid #d1d5db",
  borderRadius: 10,
  padding: "7px 5px",
  textAlign: "center",
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.7)",
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