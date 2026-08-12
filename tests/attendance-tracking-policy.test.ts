import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { ATTENDANCE_TRACKING_DISABLED_CODE, getAttendanceTrackingDisabledMessage, isAttendanceTrackingUser } from "../lib/attendance/tracking-policy.ts";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { shouldIncludeMonthlyEmployee } from "../lib/employment/eligibility.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("isAttendanceTrackingUser requires both attendance_tracking_enabled=true and is_system_account=false", () => {
  assert.equal(isAttendanceTrackingUser({ attendance_tracking_enabled: true, is_system_account: false }), true);
  assert.equal(isAttendanceTrackingUser({ attendance_tracking_enabled: false, is_system_account: false }), false);
  assert.equal(isAttendanceTrackingUser({ attendance_tracking_enabled: true, is_system_account: true }), false);
  assert.equal(isAttendanceTrackingUser({ attendance_tracking_enabled: null, is_system_account: false }), false);
});

test("bilingual disabled message and stable error code are provided from one shared place", () => {
  assert.equal(ATTENDANCE_TRACKING_DISABLED_CODE, "ATTENDANCE_TRACKING_DISABLED");
  assert.equal(typeof getAttendanceTrackingDisabledMessage("ko"), "string");
  assert.notEqual(getAttendanceTrackingDisabledMessage("ko"), getAttendanceTrackingDisabledMessage("vi"));
});

test("current-month monthly listing includes attendance-disabled employees only when they already have a real record", () => {
  const trackingOffNoRecord = { hire_date: "2026-08-01", termination_date: null, is_system_account: false, attendance_tracking_enabled: false };
  const trackingOffWithRecord = { hire_date: "2026-08-01", termination_date: null, is_system_account: false, attendance_tracking_enabled: false };
  const trackingOnNoRecord = { hire_date: "2026-08-01", termination_date: null, is_system_account: false, attendance_tracking_enabled: true };

  assert.equal(shouldIncludeMonthlyEmployee(trackingOffNoRecord, "2026-08", false), false);
  assert.equal(shouldIncludeMonthlyEmployee(trackingOffWithRecord, "2026-08", true), true);
  assert.equal(shouldIncludeMonthlyEmployee(trackingOnNoRecord, "2026-08", false), true);
});

test("system accounts are always excluded from the monthly listing regardless of the tracking flag or records", () => {
  const systemAccount = { hire_date: null, termination_date: null, is_system_account: true, attendance_tracking_enabled: true };
  assert.equal(shouldIncludeMonthlyEmployee(systemAccount, "2026-08", true), false);
});

test("a terminated employee's historical month keeps showing via employment-period intersection, unaffected by the new flag", () => {
  const terminatedTracked = { hire_date: "2026-06-01", termination_date: "2026-06-30", is_system_account: false, attendance_tracking_enabled: true };
  assert.equal(shouldIncludeMonthlyEmployee(terminatedTracked, "2026-06", false), true);
});

test("/api/attendance/users selects attendance_tracking_enabled and excludes disabled users only from the current-month roster", () => {
  const route = read("app/api/attendance/users/route.ts");
  assert.match(route, /attendance_tracking_enabled/);
  assert.match(route, /user\.attendance_tracking_enabled === true/);
  assert.match(route, /shouldIncludeMonthlyEmployee/);
});

test("check-in blocks new attendance for attendance-disabled users with a stable code", () => {
  const route = read("app/api/attendance/check-in/route.ts");
  assert.match(route, /isAttendanceTrackingUser\(user\)/);
  assert.match(route, /ATTENDANCE_TRACKING_DISABLED_CODE/);
});

test("check-out (resolving an already-open shift) is never gated by the attendance-tracking flag", () => {
  const route = read("app/api/attendance/check-out/route.ts");
  assert.doesNotMatch(route, /isAttendanceTrackingUser|ATTENDANCE_TRACKING_DISABLED_CODE/);
});

test("new leave requests are blocked for attendance-disabled users, but cancelling an existing leave is untouched", () => {
  const route = read("app/api/attendance/leave/route.ts");
  assert.match(route, /isAttendanceTrackingUser\(trackingUser\)/);
  assert.match(route, /ATTENDANCE_TRACKING_DISABLED_CODE/);
  const cancelBranchStart = route.indexOf('action === LEAVE_ACTION.CANCEL');
  assert.ok(cancelBranchStart > 0);
  assert.doesNotMatch(route.slice(cancelBranchStart), /isAttendanceTrackingUser/);
});

test("admin route only gates the record-creating branches (isCreating / !existing), not corrections or cancellations", () => {
  const route = read("app/api/attendance/admin/route.ts");
  const occurrences = route.match(/isAttendanceTrackingUser\(user\)/g) ?? [];
  // update_record(isCreating), force_check_in(!existing), set_leave(!existing) = 3곳.
  assert.equal(occurrences.length, 3);
  assert.match(route, /isCreating && !isAttendanceTrackingUser\(user\)/);
  assert.match(route, /!existing && !isAttendanceTrackingUser\(user\)/g);
  // force_check_out / auto_close_missing_checkout / cancel_* / normalize_late는 기존 기록만 다루므로
  // 게이트가 없어야 한다.
  const forceCheckOutStart = route.indexOf('action === "force_check_out"');
  const autoCloseStart = route.indexOf('action === "auto_close_missing_checkout"');
  assert.ok(forceCheckOutStart > 0 && autoCloseStart > 0);
});

test("the GET (unresolved open shift) admin endpoint keeps showing every open record regardless of the flag", () => {
  const route = read("app/api/attendance/admin/route.ts");
  const getStart = route.indexOf("export async function GET(");
  const postStart = route.indexOf("export async function POST(");
  const getSource = route.slice(getStart, postStart);
  assert.doesNotMatch(getSource, /isAttendanceTrackingUser|attendance_tracking_enabled/);
});
