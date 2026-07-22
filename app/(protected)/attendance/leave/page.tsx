"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getAttendanceTabs } from "@/lib/navigation/attendance-tabs";
import { commonText, attendanceText } from "@/lib/text";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { useSearchParams } from "next/navigation";
import { APPROVAL_STATUS, LEAVE_ACTION, } from "@/lib/attendance/status";
import { getPartMeta, getPartKey } from "@/lib/common/parts";
import { getPositionRank } from "@/lib/common/positions";
import { getBusinessDate } from "@/lib/common/business-time";
import { attendanceFetch } from "@/lib/auth/client-session";

type UserRow = {
  id: string | number;
  name: string;
  username: string;
  part: string | null;
  position: string | null;
  is_active: boolean;
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

type Feedback = {
  type: "success" | "error";
  message: string;
} | null;

const usersRequests = new Map<string, Promise<UserRow[]>>();
const leaveRecordRequests = new Map<string, Promise<AttendanceRecord[]>>();

function requestUsers() {
  const requestKey = "active-attendance-users";
  const existing = usersRequests.get(requestKey);
  if (existing) return existing;

  const request = attendanceFetch("/api/attendance/users")
    .then(async (response) => {
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(result?.message || "USERS_REQUEST_FAILED");
      }
      return ((result.users || []) as UserRow[]).filter(
        (user) => user.position !== "owner"
      );
    })
    .finally(() => {
      if (usersRequests.get(requestKey) === request) usersRequests.delete(requestKey);
    });

  usersRequests.set(requestKey, request);
  return request;
}

function requestLeaveRecords(date: Date) {
  const { startDate } = getMonthRange(date);
  const month = startDate.slice(0, 7);
  const requestKey = `${month}:all`;
  const existing = leaveRecordRequests.get(requestKey);
  if (existing) return existing;

  const request = attendanceFetch(
    `/api/attendance/records?scope=leave_month&month=${month}`
  )
    .then(async (response) => {
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(result?.message || "LEAVE_RECORDS_REQUEST_FAILED");
      }
      return (result.records || []) as AttendanceRecord[];
    })
    .finally(() => {
      if (leaveRecordRequests.get(requestKey) === request) {
        leaveRecordRequests.delete(requestKey);
      }
    });

  leaveRecordRequests.set(requestKey, request);
  return request;
}

function isNetworkError(error: unknown) {
  return error instanceof TypeError;
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function normalizeId(value?: string | number | null) {
  return String(value ?? "");
}

function getApprovalStatus(record: AttendanceRecord) {
  return record.approval_status === APPROVAL_STATUS.APPROVED
    ? APPROVAL_STATUS.APPROVED
    : APPROVAL_STATUS.PENDING;
}

function formatSummaryDate(dateKey: string) {
  const date = new Date(`${dateKey}T12:00:00`);
  return {
    text: String(date.getDate()),
    day: date.getDay(),
  };
}

export default function AttendanceLeavePage() {
  const searchParams = useSearchParams();
  const monthParam = searchParams.get("month");
  const { lang } = useLanguage();
  const pathname = usePathname();
  const tabs = getAttendanceTabs(pathname, lang);
  const t = attendanceText[lang];
  const c = commonText[lang];


  const [currentUser] = useState(() => getUser());
  const canManageLeave = isAdmin(currentUser);

  const todayWorkDate = getBusinessDate();

  const initialCalendarDate = monthParam
    ? new Date(`${monthParam}-01T12:00:00`)
    : new Date();

  const initialSelectedDate = monthParam
    ? formatDateKey(initialCalendarDate)
    : todayWorkDate;

  const [calendarDate, setCalendarDate] = useState(initialCalendarDate);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [leaveRecords, setLeaveRecords] = useState<AttendanceRecord[]>([]);
  const [selectedDate, setSelectedDate] = useState(initialSelectedDate);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [isLoadingRecords, setIsLoadingRecords] = useState(true);
  const [hasLoadedRecords, setHasLoadedRecords] = useState(false);
  const [isRefreshingRecords, setIsRefreshingRecords] = useState(false);
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const mountedRef = useRef(true);
  const hasLoadedRecordsRef = useRef(false);
  const recordsRequestSequenceRef = useRef(0);
  const pendingActionKeysRef = useRef(new Set<string>());
  const calendarDateRef = useRef(calendarDate);
  calendarDateRef.current = calendarDate;

  const copy = useMemo(
    () =>
      lang === "vi"
        ? {
            loadError: "Không thể tải dữ liệu nghỉ. Vui lòng thử lại.",
            networkError: "Vui lòng kiểm tra kết nối mạng và thử lại.",
            requestSuccess: "Đã đăng ký nghỉ.",
            cancelSuccess: "Đã hủy yêu cầu nghỉ.",
            approveSuccess: "Đã duyệt ngày nghỉ.",
            cancelApprovalSuccess: "Đã hủy duyệt ngày nghỉ.",
            refreshing: "Đang cập nhật...",
            total: "Tổng số đơn",
            pending: "Chờ duyệt",
            approved: "Đã duyệt",
            selectedDate: "Ngày đã chọn",
            reason: "Lý do",
          }
        : {
            loadError: "휴무 정보를 불러오지 못했습니다. 다시 시도해 주세요.",
            networkError: "네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
            requestSuccess: "휴무 신청이 완료되었습니다.",
            cancelSuccess: "휴무 신청이 취소되었습니다.",
            approveSuccess: "휴무 승인이 완료되었습니다.",
            cancelApprovalSuccess: "휴무 승인이 취소되었습니다.",
            refreshing: "갱신 중...",
            total: "전체 신청",
            pending: "승인 대기",
            approved: "승인 완료",
            selectedDate: "선택 날짜",
            reason: "사유",
          },
    [lang]
  );

  const loadUsers = useCallback(async () => {
    setIsLoadingUsers(true);
    try {
      const data = await requestUsers();
      if (mountedRef.current) setUsers(data);
    } catch (error) {
      console.error("fetch users error:", error);
      if (mountedRef.current) {
        setFeedback({ type: "error", message: copy.loadError });
      }
    } finally {
      if (mountedRef.current) setIsLoadingUsers(false);
    }
  }, [copy.loadError]);

  const loadLeaveRecords = useCallback(
    async (date: Date, options?: { background?: boolean }) => {
      if (!canManageLeave && !currentUser?.id) {
        setLeaveRecords([]);
        setHasLoadedRecords(true);
        hasLoadedRecordsRef.current = true;
        setIsLoadingRecords(false);
        setFeedback({ type: "error", message: c.loginAgain });
        return;
      }

      const requestSequence = ++recordsRequestSequenceRef.current;
      if (options?.background) setIsRefreshingRecords(true);
      else setIsLoadingRecords(true);

      try {
        const data = await requestLeaveRecords(date);
        if (
          mountedRef.current &&
          requestSequence === recordsRequestSequenceRef.current
        ) {
          setLeaveRecords(data);
          hasLoadedRecordsRef.current = true;
          setHasLoadedRecords(true);
        }
      } catch (error) {
        console.error("fetch leave records error:", error);
        if (
          mountedRef.current &&
          requestSequence === recordsRequestSequenceRef.current
        ) {
          setFeedback({ type: "error", message: copy.loadError });
        }
      } finally {
        if (
          mountedRef.current &&
          requestSequence === recordsRequestSequenceRef.current
        ) {
          setIsLoadingRecords(false);
          setIsRefreshingRecords(false);
        }
      }
    },
    [c.loginAgain, canManageLeave, copy.loadError, currentUser?.id]
  );

  useEffect(() => {
    mountedRef.current = true;
    void loadUsers();
    return () => {
      mountedRef.current = false;
    };
  }, [loadUsers]);

  useEffect(() => {
    void loadLeaveRecords(calendarDate, {
      background: hasLoadedRecordsRef.current,
    });
  }, [calendarDate, loadLeaveRecords]);

  const beginAction = (actionKey: string) => {
    if (pendingActionKeysRef.current.has(actionKey)) return false;
    pendingActionKeysRef.current.add(actionKey);
    setPendingActionKeys(Array.from(pendingActionKeysRef.current));
    setFeedback(null);
    return true;
  };

  const finishAction = (actionKey: string) => {
    pendingActionKeysRef.current.delete(actionKey);
    if (mountedRef.current) {
      setPendingActionKeys(Array.from(pendingActionKeysRef.current));
    }
  };

  const invalidateCurrentMonthRequest = () => {
    recordsRequestSequenceRef.current += 1;
    setIsLoadingRecords(false);
    setIsRefreshingRecords(false);
  };

  const replaceRecord = (record: AttendanceRecord) => {
    if (!record.work_date.startsWith(formatDateKey(calendarDateRef.current).slice(0, 7))) {
      return;
    }
    invalidateCurrentMonthRequest();
    setLeaveRecords((current) => {
      const index = current.findIndex((item) => item.id === record.id);
      if (index < 0) return [...current, record];
      const next = [...current];
      next[index] = record;
      return next;
    });
  };

  const removeRecord = (record: Pick<AttendanceRecord, "id" | "work_date">) => {
    if (!record.work_date.startsWith(formatDateKey(calendarDateRef.current).slice(0, 7))) {
      return;
    }
    invalidateCurrentMonthRequest();
    setLeaveRecords((current) => current.filter((item) => item.id !== record.id));
  };

  const postLeaveAction = async (url: string, body: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (isNetworkError(error)) throw new Error(copy.networkError);
      throw error;
    }

    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      throw new Error(result?.message || c.errorDefault);
    }
    return result as { record?: AttendanceRecord; message?: string };
  };

  const handleLeaveRequest = async () => {
    if (!currentUser?.id) {
      setFeedback({ type: "error", message: c.loginAgain });
      return;
    }

    const alreadyRequested = leaveRecords.find(
      (record) =>
        normalizeId(record.user_id) === normalizeId(currentUser.id) &&
        record.work_date === selectedDate
    );

    if (alreadyRequested) {
      const ok = confirm(t.leaveCancelConfirm);
      if (!ok) return;

      const actionKey = `record-${alreadyRequested.id}`;
      if (!beginAction(actionKey)) return;
      try {
        const result = await postLeaveAction("/api/attendance/leave", {
          action: LEAVE_ACTION.CANCEL,
          record_id: alreadyRequested.id,
          language: lang,
        });
        removeRecord(result.record ?? alreadyRequested);
        setFeedback({ type: "success", message: result.message || copy.cancelSuccess });
      } catch (error) {
        setFeedback({
          type: "error",
          message: error instanceof Error ? error.message : c.errorDefault,
        });
      } finally {
        finishAction(actionKey);
      }
      return;
    }

    const day = new Date(`${selectedDate}T12:00:00`).getDay();
    const isFridayOrSaturday = day === 5 || day === 6;

    let reason = "";

    if (isFridayOrSaturday) {
      const input = prompt(t.leaveReasonRequired);

      if (!input?.trim()) return;
      reason = input.trim();
    }

    const actionKey = `request-${selectedDate}`;
    if (!beginAction(actionKey)) return;
    try {
      const result = await postLeaveAction("/api/attendance/leave", {
        action: LEAVE_ACTION.REQUEST,
        user_id: currentUser.id,
        work_date: selectedDate,
        note: reason,
        language: lang,
      });
      if (result.record) replaceRecord(result.record);
      else void loadLeaveRecords(calendarDateRef.current, { background: true });
      setFeedback({ type: "success", message: result.message || copy.requestSuccess });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : c.errorDefault,
      });
    } finally {
      finishAction(actionKey);
    }
  };

  const handleApproveLeave = async (recordId: number) => {
    if (!canManageLeave) return;

    const actionKey = `record-${recordId}`;
    if (!beginAction(actionKey)) return;

    try {
      const result = await postLeaveAction("/api/attendance/leave-admin", {
        action: LEAVE_ACTION.APPROVE,
        record_id: recordId,
        admin_name: currentUser?.name || currentUser?.username || null,
        admin_id: currentUser?.id,
        language: lang,
      });
      if (result.record) replaceRecord(result.record);
      else void loadLeaveRecords(calendarDateRef.current, { background: true });
      setFeedback({ type: "success", message: result.message || copy.approveSuccess });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : c.errorDefault,
      });
    } finally {
      finishAction(actionKey);
    }
  };

  const handleCancelApproval = async (recordId: number) => {
    if (!canManageLeave) return;

    const actionKey = `record-${recordId}`;
    if (!beginAction(actionKey)) return;

    try {
      const result = await postLeaveAction("/api/attendance/leave-admin", {
        action: LEAVE_ACTION.CANCEL_APPROVAL,
        record_id: recordId,
        admin_id: currentUser?.id,
        language: lang,
      });
      if (result.record) replaceRecord(result.record);
      else void loadLeaveRecords(calendarDateRef.current, { background: true });
      setFeedback({
        type: "success",
        message: result.message || copy.cancelApprovalSuccess,
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : c.errorDefault,
      });
    } finally {
      finishAction(actionKey);
    }
  };

  const handleCancelPendingLeave = async (recordId: number) => {
    const actionKey = `record-${recordId}`;
    if (pendingActionKeysRef.current.has(actionKey)) return;

    const ok = confirm(t.leaveCancelConfirm);
    if (!ok) return;

    if (!beginAction(actionKey)) return;
    try {
      const result = await postLeaveAction("/api/attendance/leave", {
        action: LEAVE_ACTION.CANCEL,
        record_id: recordId,
        language: lang,
      });
      const currentRecord = leaveRecords.find((record) => record.id === recordId);
      if (result.record) removeRecord(result.record);
      else if (currentRecord) removeRecord(currentRecord);
      else void loadLeaveRecords(calendarDateRef.current, { background: true });
      setFeedback({ type: "success", message: result.message || copy.cancelSuccess });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : c.errorDefault,
      });
    } finally {
      finishAction(actionKey);
    }
  };

  const userMap = useMemo(() => {
    const map = new Map<string, UserRow>();
    users.forEach((user) => map.set(normalizeId(user.id), user));
    if (!canManageLeave && currentUser?.id && !map.has(normalizeId(currentUser.id))) {
      map.set(normalizeId(currentUser.id), {
        id: currentUser.id,
        name: currentUser.name || currentUser.username || normalizeId(currentUser.id),
        username: currentUser.username || "",
        part: currentUser.part ?? null,
        position: currentUser.position ?? currentUser.role ?? null,
        is_active: true,
      });
    }
    return map;
  }, [canManageLeave, currentUser, users]);



  const visibleLeaveRecords = leaveRecords;

  const selectedDateLeaves = useMemo(() => {
    return visibleLeaveRecords
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

        const approvalDiff =
          Number(getApprovalStatus(itemA.record) === APPROVAL_STATUS.APPROVED) -
          Number(getApprovalStatus(itemB.record) === APPROVAL_STATUS.APPROVED);
        if (approvalDiff !== 0) return approvalDiff;

        if (itemA.record.created_at && itemB.record.created_at) {
          return itemA.record.created_at.localeCompare(itemB.record.created_at);
        }

        return itemA.record.id - itemB.record.id;
      }) as Array<{ user: UserRow; record: AttendanceRecord }>;
  }, [selectedDate, userMap, visibleLeaveRecords]);

  const leaveCountByDate = useMemo(() => {
    const map = new Map<string, { approved: number; pending: number }>();
    visibleLeaveRecords.forEach((record) => {
      const prev = map.get(record.work_date) || { approved: 0, pending: 0 };
      const isApproved = getApprovalStatus(record) === APPROVAL_STATUS.APPROVED;

      map.set(record.work_date, {
        approved: prev.approved + (isApproved ? 1 : 0),
        pending: prev.pending + (isApproved ? 0 : 1),
      });
    });
    return map;
  }, [visibleLeaveRecords]);

  const staffSummaryGroups = useMemo(() => {
    const summaryMap = new Map<string, { count: number; dates: string[] }>();

    visibleLeaveRecords.forEach((record) => {
      const userId = normalizeId(record.user_id);
      const prev = summaryMap.get(userId) || { count: 0, dates: [] };
      prev.count += 1;
      prev.dates.push(record.work_date);
      summaryMap.set(userId, prev);
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
      prev.push({
        user,
        count: summary.count,
        dates: summary.dates.sort(),
      });
      groupMap.set(key, prev);
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
  }, [visibleLeaveRecords, userMap]);

  const calendarCells = useMemo(() => getCalendarCells(calendarDate), [calendarDate]);

  const mySelectedRecord = visibleLeaveRecords.find(
    (record) =>
      normalizeId(record.user_id) === normalizeId(currentUser?.id) &&
      record.work_date === selectedDate
  );
  const hasMySelectedLeave = Boolean(mySelectedRecord);
  const leaveRequestButtonLabel = getLeaveRequestButtonLabel(
    lang,
    hasMySelectedLeave
  );
  const summary = useMemo(
    () =>
      visibleLeaveRecords.reduce(
        (result, record) => {
          result.total += 1;
          if (getApprovalStatus(record) === APPROVAL_STATUS.APPROVED) {
            result.approved += 1;
          } else {
            result.pending += 1;
          }
          return result;
        },
        { total: 0, pending: 0, approved: 0 }
      ),
    [visibleLeaveRecords]
  );
  const isInitialLoading =
    (isLoadingUsers && users.length === 0) ||
    (isLoadingRecords && !hasLoadedRecords);
  const isRequestBusy = pendingActionKeys.some(
    (key) =>
      key === `request-${selectedDate}` ||
      (mySelectedRecord ? key === `record-${mySelectedRecord.id}` : false)
  );

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        {feedback && (
          <div
            role={feedback.type === "error" ? "alert" : "status"}
            style={{
              ...feedbackStyle,
              color: feedback.type === "error" ? "#b91c1c" : "#047857",
              background: feedback.type === "error" ? "#fef2f2" : "#ecfdf5",
              borderColor: feedback.type === "error" ? "#fecaca" : "#a7f3d0",
            }}
          >
            {feedback.message}
          </div>
        )}

        <div style={summaryCardsStyle}>
          <SummaryCard label={copy.total} value={summary.total} color="#111827" />
          <SummaryCard label={copy.pending} value={summary.pending} color="#d97706" />
          <SummaryCard label={copy.approved} value={summary.approved} color="#059669" />
        </div>

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

            <div style={calendarTitleStyle}>
              {formatMonthTitle(lang, calendarDate)}
              {isRefreshingRecords && (
                <span style={refreshingTextStyle}>{copy.refreshing}</span>
              )}
            </div>

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
            {c.calendarWeekdays.map((day, index) => (
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

              const leaveCount = leaveCountByDate.get(cell.dateKey || "") || {
                approved: 0,
                pending: 0,
              };
              const active = selectedDate === cell.dateKey;
              const isSunday = index % 7 === 0;
              const isSaturday = index % 7 === 6;
              const hasApproved = leaveCount.approved > 0;
              const hasPending = leaveCount.pending > 0;

              return (
                <button
                  key={cell.dateKey}
                  type="button"
                  onClick={() => setSelectedDate(cell.dateKey || todayWorkDate)}
                  style={{
                    ...calendarCellStyle,
                    borderColor: active
                      ? "#111827"
                      : hasPending
                        ? "#f59e0b"
                        : hasApproved
                          ? "#10b981"
                          : "#e5e7eb",
                    background: active
                      ? "#111827"
                      : hasPending
                        ? "#fffbeb"
                        : hasApproved
                          ? "#ecfdf5"
                          : "#ffffff",
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
                  {(hasApproved || hasPending) && (
                    <span style={countGroupStyle}>
                      {hasApproved && (
                        <span
                          style={{
                            ...countDotStyle,
                            background: active ? "#dcfce7" : "#10b981",
                            color: active ? "#065f46" : "#ffffff",
                          }}
                        >
                          {leaveCount.approved}
                        </span>
                      )}
                      {hasPending && (
                        <span
                          style={{
                            ...countDotStyle,
                            background: active ? "#fef3c7" : "#f59e0b",
                            color: active ? "#92400e" : "#ffffff",
                          }}
                        >
                          {leaveCount.pending}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={selectedListStyle}>
            <div style={selectedDateTitleStyle}>
              {copy.selectedDate} · {selectedDate}
            </div>

            {isInitialLoading ? (
              <div style={selectedEmptyStyle}>{c.loading}</div>
            ) : selectedDateLeaves.length === 0 ? (
              <div style={selectedEmptyStyle}>{c.noLogs}</div>
            ) : (
              selectedDateLeaves.map((item, index) => {
                const { user, record } = item;
                const meta = getPartMeta(user.part);
                const isApproved = getApprovalStatus(record) === APPROVAL_STATUS.APPROVED;

                const isRecordBusy = pendingActionKeys.some((key) =>
                  key.endsWith(`-${record.id}`)
                );

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
                        <span style={userNameStyle}>{index + 1}. {user.name}</span>
                        <span style={userMetaStyle}>
                          {t.positions?.[user.position as keyof typeof t.positions] || user.position || user.username}
                        </span>
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
                          {isApproved ? t.approvalApproved : t.approvalPending}
                        </span>

                        {canManageLeave && (
                          <div style={leaveButtonGroupStyle}>
                            {!isApproved && (
                              <button
                                type="button"
                                style={{
                                  ...approveButtonStyle,
                                  opacity: isRecordBusy ? 0.45 : 1,
                                  cursor: isRecordBusy ? "not-allowed" : "pointer",
                                }}
                                disabled={isRecordBusy}
                                onClick={() => handleApproveLeave(record.id)}
                              >
                                {isRecordBusy ? t.processing : t.approve}
                              </button>
                            )}

                            {isApproved ? (
                              <button
                                type="button"
                                style={{
                                  ...cancelApprovalButtonStyle,
                                  opacity: isRecordBusy ? 0.45 : 1,
                                  cursor: isRecordBusy ? "not-allowed" : "pointer",
                                }}
                                disabled={isRecordBusy}
                                onClick={() => handleCancelApproval(record.id)}
                              >
                                {isRecordBusy ? t.processing : t.cancelApproval}
                              </button>
                            ) : (
                              <button
                                type="button"
                                style={{
                                  ...cancelApprovalButtonStyle,
                                  opacity: isRecordBusy ? 0.45 : 1,
                                  cursor: isRecordBusy ? "not-allowed" : "pointer",
                                }}
                                disabled={isRecordBusy}
                                onClick={() => handleCancelPendingLeave(record.id)}
                              >
                                {isRecordBusy ? t.processing : t.cancelRequest}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {record.note && (
                      <div style={reasonStyle}>
                        <strong>{copy.reason}</strong> · {record.note}
                      </div>
                    )}


                  </div>
                );
              })
            )}

            {!canManageLeave && (
              <button
                type="button"
                style={{
                  ...(hasMySelectedLeave
                    ? leaveCancelRequestButtonStyle
                    : requestButtonStyle),
                  opacity: isRequestBusy ? 0.45 : 1,
                  cursor: isRequestBusy ? "not-allowed" : "pointer",
                }}
                disabled={isRequestBusy}
                onClick={handleLeaveRequest}
              >
                {isRequestBusy ? t.processing : leaveRequestButtonLabel}
              </button>
            )}
          </div>
        </div>

        <SectionTitle title={t.staffSummary} />

        <div style={cardStyle}>
          {isInitialLoading ? (
            <Empty text={c.loading} />
          ) : staffSummaryGroups.length === 0 ? (
            <Empty text={c.noLogs} />
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
                    {group.meta.emoji} {c[group.part as keyof typeof c] || group.meta.label}
                  </div>

                  {group.items.map((item) => (
                    <div key={item.user.id} style={summaryRowStyle}>
                      <span style={userNameStyle}>{item.user.name}</span>
                      <span style={userMetaStyle}>
                        {t.positions?.[item.user.position as keyof typeof t.positions] || item.user.position || item.user.username}
                      </span>
                      <span style={summaryCountStyle}>
                        {item.count}
                        {c.days}
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

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div style={summaryCardStyle}>
      <span style={summaryCardLabelStyle}>{label}</span>
      <strong style={{ ...summaryCardValueStyle, color }}>{value}</strong>
    </div>
  );
}

function getLeaveRequestButtonLabel(
  lang: "ko" | "vi",
  hasSelectedLeave: boolean
) {
  if (hasSelectedLeave) {
    return lang === "vi"
      ? "\u21A9\uFE0F H\u1EE7y ngh\u1EC9"
      : "\u21A9\uFE0F \uD734\uBB34\uCDE8\uC18C";
  }

  return lang === "vi"
    ? "\uD83D\uDCDD Xin ngh\u1EC9"
    : "\uD83D\uDCDD \uD734\uBB34\uC2E0\uCCAD";
}

const summaryDatesStyle: CSSProperties = {
  marginLeft: 4,
  fontSize: 11,
  fontWeight: 800,
};

const feedbackStyle: CSSProperties = {
  border: "1px solid",
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 13,
  fontWeight: 700,
  overflowWrap: "anywhere",
};

const summaryCardsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
  gap: 8,
};

const summaryCardStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "10px 12px",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  background: "#ffffff",
};

const summaryCardLabelStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  fontWeight: 800,
  color: "#6b7280",
};

const summaryCardValueStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 20,
  lineHeight: 1,
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

const refreshingTextStyle: CSSProperties = {
  display: "block",
  marginTop: 2,
  fontSize: 9,
  fontWeight: 700,
  color: "#6b7280",
  whiteSpace: "nowrap",
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
  gap: 2,
  cursor: "pointer",
};

const countGroupStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
};

const countDotStyle: CSSProperties = {
  minWidth: 14,
  height: 14,
  borderRadius: 999,
  fontSize: 9,
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

const selectedDateTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 900,
  color: "#374151",
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
  flexWrap: "wrap",
};

const selectedUserLeftStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  flexWrap: "wrap",
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
  flexWrap: "wrap",
};

const leaveButtonGroupStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

const reasonStyle: CSSProperties = {
  fontSize: 11,
  color: "#6b7280",
  paddingLeft: 30,
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
};



const approveButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 8,
  background: "#10b981",
  color: "#ffffff",
  minHeight: 36,
  padding: "7px 11px",
  fontSize: 12,
  fontWeight: 900,
  cursor: "pointer",
};

const cancelApprovalButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 8,
  background: "#ef4444",
  color: "#ffffff",
  minHeight: 36,
  padding: "7px 11px",
  fontSize: 12,
  fontWeight: 900,
  cursor: "pointer",
};

const requestButtonStyle: CSSProperties = {
  width: "100%",
  minHeight: 44,
  border: "none",
  borderRadius: 10,
  backgroundColor: "#111827",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 900,
  cursor: "pointer",
};

const leaveCancelRequestButtonStyle: CSSProperties = {
  ...requestButtonStyle,
  backgroundColor: "#fee2e2",
  color: "#b91c1c",
  border: "1px solid #fecaca",
  borderColor: "#fecaca",
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
  flexWrap: "wrap",
};

const summaryCountStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 12,
  fontWeight: 900,
  color: "#111827",
  overflowWrap: "anywhere",
};

const emptyStyle: CSSProperties = {
  padding: 14,
  textAlign: "center",
  color: "#6b7280",
  fontSize: 13,
};
