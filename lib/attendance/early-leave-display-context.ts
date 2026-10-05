// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import { normalizeTime } from "./time.ts";
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import { getBusinessWindowByBusinessDate } from "../common/business-time.ts";

export type EarlyLeaveDisplayContext = {
  effectiveScheduleStart: string | null;
  effectiveScheduleEnd: string | null;
  actualCheckOutAt: string | null;
  peerAverageCheckOutAt: string | null;
  peerCount: number;
};

export type EarlyLeaveDisplayTarget = { id: number; user_id: number; work_date: string };
export type EarlyLeaveDisplayAttendance = EarlyLeaveDisplayTarget & { status: string; check_out_at: string | null };
export type EarlyLeaveDisplaySchedule = {
  user_id: number;
  start_time: string;
  end_time: string;
  effective_from: string;
  effective_to: string | null;
};

// Display evidence only: this helper never evaluates early-leave or payroll policy.
export function buildEarlyLeaveDisplayContexts(
  targets: readonly EarlyLeaveDisplayTarget[],
  attendance: readonly EarlyLeaveDisplayAttendance[],
  schedules: readonly EarlyLeaveDisplaySchedule[],
): Map<number, EarlyLeaveDisplayContext> {
  const schedulesByUser = new Map<number, EarlyLeaveDisplaySchedule[]>();
  for (const schedule of schedules) {
    const versions = schedulesByUser.get(schedule.user_id) ?? [];
    versions.push(schedule);
    schedulesByUser.set(schedule.user_id, versions);
  }
  const scheduleCache = new Map<string, { start: string; end: string } | null>();
  const resolveSchedule = (userId: number, date: string) => {
    const key = `${userId}:${date}`;
    if (!scheduleCache.has(key)) {
      const matches = (schedulesByUser.get(userId) ?? []).filter((schedule) =>
        schedule.effective_from <= date && (!schedule.effective_to || date < schedule.effective_to));
      const start = matches.length === 1 ? normalizeTime(matches[0].start_time) : null;
      const end = matches.length === 1 ? normalizeTime(matches[0].end_time) : null;
      scheduleCache.set(key, start && end ? { start, end } : null);
    }
    return scheduleCache.get(key) ?? null;
  };

  const origins = new Map<string, number>();
  const originFor = (date: string) => {
    if (!origins.has(date)) origins.set(date, getBusinessWindowByBusinessDate(date).start.getTime());
    return origins.get(date)!;
  };
  const groupKey = (date: string, schedule: { start: string; end: string }) => `${date}:${schedule.start}:${schedule.end}`;
  const groups = new Map<string, { sum: number; byUser: Map<number, number> }>();
  const recordsById = new Map(attendance.map((record) => [record.id, record]));
  for (const record of attendance) {
    if (record.status === "leave" || !record.check_out_at) continue;
    const checkout = new Date(record.check_out_at).getTime();
    if (!Number.isFinite(checkout)) continue;
    const schedule = resolveSchedule(record.user_id, record.work_date);
    if (!schedule) continue;
    const key = groupKey(record.work_date, schedule);
    const group = groups.get(key) ?? { sum: 0, byUser: new Map<number, number>() };
    // One contribution per employee, including if an input accidentally contains duplicates.
    const offset = checkout - originFor(record.work_date);
    group.sum += offset - (group.byUser.get(record.user_id) ?? 0);
    group.byUser.set(record.user_id, offset);
    groups.set(key, group);
  }

  return new Map(targets.map((target) => {
    const schedule = resolveSchedule(target.user_id, target.work_date);
    const group = schedule ? groups.get(groupKey(target.work_date, schedule)) : undefined;
    const ownOffset = group?.byUser.get(target.user_id);
    const peerCount = (group?.byUser.size ?? 0) - (ownOffset === undefined ? 0 : 1);
    const average = peerCount > 0 && group
      ? originFor(target.work_date) + (group.sum - (ownOffset ?? 0)) / peerCount : null;
    return [target.id, {
      effectiveScheduleStart: schedule?.start ?? null,
      effectiveScheduleEnd: schedule?.end ?? null,
      actualCheckOutAt: recordsById.get(target.id)?.check_out_at ?? null,
      // Round the continuous timestamp to the nearest displayed minute, then format in Vietnam time in the UI.
      peerAverageCheckOutAt: average === null ? null : new Date(Math.round(average / 60_000) * 60_000).toISOString(),
      peerCount,
    }];
  }));
}
