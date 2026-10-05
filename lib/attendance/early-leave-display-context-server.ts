import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import {
  buildEarlyLeaveDisplayContexts,
  type EarlyLeaveDisplayAttendance,
  type EarlyLeaveDisplaySchedule,
  type EarlyLeaveDisplayTarget,
  type EarlyLeaveDisplayContext,
} from "./early-leave-display-context";

export async function loadEarlyLeaveDisplayContexts(targets: readonly EarlyLeaveDisplayTarget[]): Promise<Map<number, EarlyLeaveDisplayContext>> {
  if (targets.length === 0) return new Map();
  const dates = [...new Set(targets.map((record) => record.work_date))].sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];

  // Batch by dates, never by cards. Page large backlogs rather than silently truncating at the API row limit.
  const attendanceQuery = () => supabaseServer.from("attendance_records")
    .select("id,user_id,work_date,status,check_out_at").in("work_date", dates)
    .not("check_out_at", "is", null).order("id");
  const scheduleQuery = () => supabaseServer.from("employee_work_schedule_versions")
    .select("id,user_id,start_time,end_time,effective_from,effective_to")
    .lte("effective_from", lastDate).or(`effective_to.is.null,effective_to.gt.${firstDate}`).order("id");
  async function readAll<T>(query: () => {
    range(start: number, end: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
  }): Promise<T[]> {
    const rows: T[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await query().range(offset, offset + pageSize - 1);
      if (error) throw new Error("EARLY_LEAVE_DISPLAY_CONTEXT_READ_FAILED");
      rows.push(...(data ?? []) as unknown as T[]);
      if (!data || data.length < pageSize) return rows;
    }
  }
  const [attendance, schedules] = await Promise.all([
    readAll<EarlyLeaveDisplayAttendance>(attendanceQuery),
    readAll<EarlyLeaveDisplaySchedule>(scheduleQuery),
  ]);
  return buildEarlyLeaveDisplayContexts(targets, attendance, schedules);
}
