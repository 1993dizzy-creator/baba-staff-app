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
import { getUser, isAdmin } from "@/lib/supabase/auth";

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

function buildVietnamIso(workDate: string, timeValue: string) {
  const [hourText, minuteText] = timeValue.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  const base = new Date(`${workDate}T00:00:00+07:00`);

  if (hour < 3) {
    base.setDate(base.getDate() + 1);
  }

  base.setHours(hour, minute, 0, 0);

  return base.toISOString();
}

function getMinutesBetween(startIso: string | null, endIso: string | null) {
  if (!startIso || !endIso) return 0;

  const diff = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(0, Math.floor(diff / 60000));
}

function getLateMinutes(checkInIso: string, workDate: string, workStartTime?: string | null) {
  const standardTime = workStartTime || "16:00";
  const standardIso = buildVietnamIso(workDate, standardTime);

  return Math.max(
    0,
    Math.floor((new Date(checkInIso).getTime() - new Date(standardIso).getTime()) / 60000)
  );
}

function getEarlyLeaveMinutes(checkOutIso: string, workDate: string, workEndTime?: string | null) {
  const standardTime = workEndTime || "01:00";
  const standardIso = buildVietnamIso(workDate, standardTime);

  return Math.max(
    0,
    Math.floor((new Date(standardIso).getTime() - new Date(checkOutIso).getTime()) / 60000)
  );
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
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("id, name, username, role, part, position, is_active, work_start_time, work_end_time")
        .eq("is_active", true)

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

  const handleForceCheckIn = async (targetUser: UserRow, timeValue: string) => {
    if (!isAdmin(loginUser)) {
      alert(t.noPermission);
      return;
    }

    if (!timeValue) {
      alert(t.inputTimeRequired);
      return;
    }

    setManualModal(null);

    const record = recordMap.get(targetUser.id);
    const checkInIso = buildVietnamIso(todayWorkDate, timeValue);
    const checkOutIso = record?.check_out_at || null;

    const workMinutes = getMinutesBetween(checkInIso, checkOutIso);
    const lateMinutes = getLateMinutes(checkInIso, todayWorkDate, targetUser.work_start_time);

    const payload = {
      user_id: targetUser.id,
      work_date: todayWorkDate,
      status: checkOutIso ? "done" : "working",
      check_in_at: checkInIso,
      late_minutes: lateMinutes,
      work_minutes: workMinutes,
      updated_at: new Date().toISOString(),
    };

    const { error } = record
      ? await supabase.from("attendance_records").update(payload).eq("id", record.id)
      : await supabase.from("attendance_records").insert([
        {
          ...payload,
          check_out_at: null,
          early_leave_minutes: 0,
          approval_status: "approved",
        },
      ]);

    if (error) {
      console.log("force check-in error:", JSON.stringify(error, null, 2));
      alert(t.checkInUpdateFailed);
      return;
    }

    await supabase.from("attendance_check_logs").insert([
      {
        user_id: targetUser.id,
        user_name: targetUser.name,
        username: targetUser.username,
        work_date: todayWorkDate,
        action: "manual_check_in",
        checked_at: new Date().toISOString(),
        success: true,
        fail_reason: null,
        device_id: "ADMIN",
        device_info: {
          admin_id: loginUser?.id,
          admin_name: loginUser?.name,
          admin_username: loginUser?.username,
          prev_check_in_at: record?.check_in_at || null,
          new_check_in_at: checkInIso,
        },
        user_agent: navigator.userAgent,
      },
    ]);

    alert(t.checkInUpdated);
    await fetchList();
  };

  const handleForceCheckOut = async (targetUser: UserRow, timeValue: string) => {
    if (!isAdmin(loginUser)) {
      alert(t.noPermission);
      return;
    }

    if (!timeValue) {
      alert(t.inputTimeRequired);
      return;
    }

    setManualModal(null);

    const record = recordMap.get(targetUser.id);

    if (!record?.check_in_at) {
      alert(t.checkInRequiredFirst);
      return;
    }

    const checkOutIso = buildVietnamIso(todayWorkDate, timeValue);
    const workMinutes = getMinutesBetween(record.check_in_at, checkOutIso);
    const earlyLeaveMinutes = getEarlyLeaveMinutes(
      checkOutIso,
      todayWorkDate,
      targetUser.work_end_time
    );

    const { error } = await supabase
      .from("attendance_records")
      .update({
        status: earlyLeaveMinutes > 0 ? "early_leave" : "done",
        check_out_at: checkOutIso,
        work_minutes: workMinutes,
        early_leave_minutes: earlyLeaveMinutes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", record.id);

    if (error) {
      console.log("force check-out error:", JSON.stringify(error, null, 2));
      alert(t.checkOutUpdateFailed);
      return;
    }

    await supabase.from("attendance_check_logs").insert([
      {
        user_id: targetUser.id,
        user_name: targetUser.name,
        username: targetUser.username,
        work_date: todayWorkDate,
        action: "manual_check_out",
        checked_at: new Date().toISOString(),
        success: true,
        fail_reason: null,
        device_id: "ADMIN",
        device_info: {
          admin_id: loginUser?.id,
          admin_name: loginUser?.name,
          admin_username: loginUser?.username,
          prev_check_out_at: record?.check_out_at || null,
          new_check_out_at: checkOutIso,
        },
        user_agent: navigator.userAgent,
      },
    ]);

    alert(t.checkOutUpdated);
    await fetchList();
  };

  const handleResetDevice = async (targetUser: UserRow) => {
    if (!isAdmin(loginUser)) {
      alert(t.noPermission);
      return;
    }

    const ok = confirm(`${targetUser.name} ${t.resetDeviceConfirm}`);
    if (!ok) return;

    const { error } = await supabase
      .from("users")
      .update({
        device_id: null,
        device_info: null,
        device_registered_at: null,
        device_updated_at: null,
      })
      .eq("id", targetUser.id);

    if (error) {
      console.log("device reset error:", error);
      alert(t.resetDeviceFailed);
      return;
    }

    await supabase.from("attendance_check_logs").insert([
      {
        user_id: targetUser.id,
        user_name: targetUser.name,
        username: targetUser.username,
        work_date: todayWorkDate,
        action: "reset_device",
        checked_at: new Date().toISOString(),
        success: true,
        fail_reason: null,
        device_id: "ADMIN",
        device_info: {
          admin_id: loginUser?.id,
          admin_name: loginUser?.name,
          admin_username: loginUser?.username,
        },
        user_agent: navigator.userAgent,
      },
    ]);

    alert(t.resetDeviceDone);
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
                        <>
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
                                onClick={() => handleResetDevice(user)}
                              >
                                {t.resetDevice}
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
                    {t.manualInput}
                  </button>
                </div>

                <button
                  type="button"
                  style={{ ...modalCancelButtonStyle, width: "100%", marginTop: 8 }}
                  onClick={() => setManualModal(null)}
                >
                  {t.cancel}
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
                    {t.submit}
                  </button>
                </div>

                <button
                  type="button"
                  style={{ ...modalCancelButtonStyle, width: "100%", marginTop: 8 }}
                  onClick={() => setManualModal(null)}
                >
                  {t.cancel}
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