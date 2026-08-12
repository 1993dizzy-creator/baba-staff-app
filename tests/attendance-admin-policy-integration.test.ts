import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const admin = read("app/api/attendance/admin/route.ts");
const checkOut = read("app/api/attendance/check-out/route.ts");
const checkIn = read("app/api/attendance/check-in/route.ts");
const time = read("lib/attendance/time.ts");

test("admin route no longer imports the legacy fixed-threshold early-leave calculation", () => {
  assert.doesNotMatch(admin, /getEarlyLeaveMinutes/);
  assert.doesNotMatch(admin, /getStatusByMinutes/);
  assert.doesNotMatch(admin, /NORMAL_EARLY_CLOSE_TIME/);
  assert.doesNotMatch(admin, /getLateMinutes/);
});

test("check-out route no longer imports the legacy fixed-threshold early-leave calculation", () => {
  assert.doesNotMatch(checkOut, /getEarlyLeaveMinutes/);
  assert.doesNotMatch(checkOut, /getStatusByMinutes/);
});

test("check-in route no longer imports or calls the legacy raw-only late calculation", () => {
  assert.doesNotMatch(checkIn, /getLateMinutes/);
});

test("the legacy 23:30 hardcode and 90-minute threshold constant are removed from time.ts", () => {
  assert.doesNotMatch(time, /NORMAL_EARLY_CLOSE_TIME/);
  assert.doesNotMatch(time, /EARLY_LEAVE_STATUS_THRESHOLD_MINUTES/);
});

test("getLateMinutes itself no longer exists anywhere in time.ts — it was fully orphaned once check-in switched to the shared policy engine", () => {
  assert.doesNotMatch(time, /getLateMinutes/);
});

test("admin reads and mutations, including schedule-based missing-checkout auto-close, resolve through the shared date-scoped policy engine", () => {
  const occurrences = admin.match(/resolveAttendanceRecordPolicy\(/g) ?? [];
  assert.ok(occurrences.length >= 6);
  assert.match(admin, /action === "auto_close_missing_checkout"/);
  assert.match(admin, /const autoCheckOutIso = openPolicy\.normalCheckoutThresholdAt/);
  assert.doesNotMatch(admin, /getShiftAutoCloseIso/);
});

test("employee self checkout resolves through the same shared policy engine", () => {
  assert.match(checkOut, /resolveAttendanceRecordPolicy\(/);
});

test("employee self check-in resolves late_minutes through the same shared policy engine as checkout/admin, storing lateMinutes rather than inventing its own raw calculation", () => {
  assert.match(checkIn, /resolveAttendanceRecordPolicy\(/);
  assert.match(checkIn, /late_minutes:\s*lateMinutes/);
  assert.match(checkIn, /const lateMinutes = policyResult\.lateMinutes;/);
});

test("check-in does not hardcode a grace value or duplicate the threshold formula — it only reads policyResult.lateMinutes", () => {
  assert.doesNotMatch(checkIn, /lateGraceMinutes\s*[:=]\s*\d/);
  assert.doesNotMatch(checkIn, /rawLate/i);
});

test("admin mutation paths write before/after/actor/reason/work_date audit log entries without a new migration or RPC", () => {
  assert.match(admin, /recordAttendanceAuditLog\(/);
  assert.match(admin, /beforeSnapshot: existing/);
  assert.match(admin, /afterSnapshot: data/);
  assert.match(admin, /actorUserId: auth\.actor\.id/);
  // manual corrections vs. the unattended auto-close action are tagged distinctly,
  // matching the existing attendance_record_audit_logs action enum.
  assert.match(admin, /action: "manual_update"/);
  assert.match(admin, /action: "auto_close"/);
});

test("missing-checkout auto-close enforces server timing, record ownership, and compare-and-set race protection", () => {
  assert.match(admin, /BUSINESS_CLOSE_NOT_REACHED/);
  assert.match(admin, /isAdminMissingCheckoutReviewAvailable\(/);
  assert.match(admin, /\.eq\("id", attendance_id\)[\s\S]*?Number\(recordById\.user_id\) !== Number\(user_id\)/);
  assert.match(admin, /\.eq\("id", existing\.id\)\s*\.is\("check_out_at", null\)/);
  assert.match(admin, /\.maybeSingle\(\)[\s\S]*?if \(!data\)/);
});

test("the normalize_late (지각 정상처리) RPC path is untouched by the early-leave fix", () => {
  assert.match(admin, /rpc\(\s*"attendance_admin_normalize_late_v1"/);
});

test("the cancellation RPC path is untouched by the early-leave fix", () => {
  assert.match(admin, /rpc\(\s*"attendance_admin_cancel_record_v1"/);
});
