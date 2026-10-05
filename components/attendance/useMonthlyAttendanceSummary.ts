"use client";
import { useEffect, useMemo, useState } from "react";

export type PublicMonthlyAttendanceSummary = {
  userId: number;
  actualWorkDays: number;
  lateCount: number;
  earlyLeaveCount: number;
  unauthorizedAbsenceCount: number;
  blockingCount: number;
  perfectAttendanceCurrent: boolean;
  attendanceBonusEligible: boolean;
};

const cache = new Map<string, Promise<PublicMonthlyAttendanceSummary[]>>();

export function currentVietnamMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

export function useMonthlyAttendanceSummary(month: string, refreshKey?: unknown, staffCurrent = false) {
  const [snapshot, setSnapshot] = useState<{
    month: string;
    refreshKey: unknown;
    staffCurrent: boolean;
    rows: PublicMonthlyAttendanceSummary[];
  } | null>(null);

  useEffect(() => {
    let active = true;
    const controller = staffCurrent ? new AbortController() : null;
    const url = `/api/attendance/monthly-summary?month=${month}` + (staffCurrent ? "&scope=staff_current" : "");
    // Preserve other screens' existing month cache; live staff snapshots never use it.
    let request = staffCurrent ? undefined : cache.get(month);
    if (!request) {
      request = fetch(url, { cache: "no-store", signal: controller?.signal })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.code);
          return (data.summaries ?? []) as PublicMonthlyAttendanceSummary[];
        });
      if (!staffCurrent) {
        cache.set(month, request);
        const cachedRequest = request;
        void request.catch(() => { if (cache.get(month) === cachedRequest) cache.delete(month); });
      }
    }
    void request.then((rows) => {
      if (active) setSnapshot({ month, refreshKey, staffCurrent, rows });
    }).catch(() => undefined);
    return () => {
      active = false;
      controller?.abort();
    };
  }, [month, refreshKey, staffCurrent]);

  return useMemo(() => {
    // Only the live staff screen hides obsolete badges while a replacement is loading.
    const rows = !staffCurrent ? snapshot?.rows ?? []
      : snapshot?.month === month && snapshot.refreshKey === refreshKey && snapshot.staffCurrent === staffCurrent
        ? snapshot.rows : [];
    return new Map(rows.map((row) => [row.userId, row]));
  }, [snapshot, month, refreshKey, staffCurrent]);
}
