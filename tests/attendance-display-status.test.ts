import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error test runner imports the TypeScript source directly.
import { getAttendanceDisplayStatus, getRecentAttendanceDateKeys } from "../lib/attendance/display-status.ts";

test("current month uses Vietnam today and the previous six days", () => {
  assert.deepEqual(
    getRecentAttendanceDateKeys("2026-07", new Date("2026-07-29T17:30:00.000Z")),
    [
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]
  );
});

test("past and future months use the selected month end", () => {
  const now = new Date("2026-07-30T05:00:00.000Z");
  assert.deepEqual(getRecentAttendanceDateKeys("2026-06", now), [
    "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27",
    "2026-06-28", "2026-06-29", "2026-06-30",
  ]);
  assert.deepEqual(getRecentAttendanceDateKeys("2026-08", now), [
    "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28",
    "2026-08-29", "2026-08-30", "2026-08-31",
  ]);
});

test("February month end supports leap and non-leap years", () => {
  const now = new Date("2026-07-30T05:00:00.000Z");
  assert.equal(getRecentAttendanceDateKeys("2024-02", now).at(-1), "2024-02-29");
  assert.equal(getRecentAttendanceDateKeys("2026-02", now).at(-1), "2026-02-28");
});

test("attendance status follows calendar priority and handles missing records", () => {
  assert.equal(getAttendanceDisplayStatus(null), "none");
  assert.equal(getAttendanceDisplayStatus({ status: "done" }), "normal");
  assert.equal(getAttendanceDisplayStatus({ status: "done", late_minutes: 5 }), "late");
  assert.equal(getAttendanceDisplayStatus({ status: "early_leave" }), "early_leave");
  assert.equal(getAttendanceDisplayStatus({ status: "unauthorized_absence" }), "unauthorized_absence");
  assert.equal(
    getAttendanceDisplayStatus({ status: "leave", approval_status: "approved" }),
    "approved_leave"
  );
  assert.equal(
    getAttendanceDisplayStatus({ status: "done", late_minutes: 5, early_leave_minutes: 1 }),
    "early_leave"
  );
});
