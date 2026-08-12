import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node direct TypeScript tests require extensions.
import { normalizeAttendanceDayFacts } from "../lib/payroll/attendance-facts.ts";
// @ts-expect-error Node direct TypeScript tests require extensions.
import { calculateUnauthorizedAbsencePenalty } from "../lib/payroll/penalties.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260812162019_add_unauthorized_absence_attendance.sql");
const payroll = read("lib/payroll/monthly-run.ts");
const admin = read("app/api/attendance/admin/route.ts");

test("confirmed unauthorized absence is a calculable zero-minute fact without missing or mismatch warnings", () => {
  const facts = normalizeAttendanceDayFacts({
    userId: 21,
    businessDate: "2026-08-03",
    schedule: { id: 1, userId: 21, startTime: "16:00", endTime: "01:00", unpaidBreakMinutes: 0, effectiveFrom: "2026-08-01", effectiveTo: null, revision: 4, changeReason: null },
    attendanceRecord: { id: 99, status: "unauthorized_absence", checkInAt: null, checkOutAt: null, approvalStatus: "approved", storedLateMinutes: 0, storedEarlyLeaveMinutes: 0, storedWorkMinutes: 0 },
  });
  assert.equal(facts.attendanceStatus, "unauthorized_absence");
  assert.equal(facts.actualMinutes, 0);
  assert.equal(facts.scheduledOverlapMinutes, 0);
  assert.equal(facts.lateMinutes, 0);
  assert.equal(facts.earlyLeaveMinutes, 0);
  assert.equal(facts.payrollStatus, "calculable");
  assert.doesNotMatch(facts.warningCodes.join(","), /MISSING_CHECK_IN|STORED_STATUS_POLICY_MISMATCH/);
});

test("penalty uses the configured day count and never hardcodes three", () => {
  assert.equal(calculateUnauthorizedAbsencePenalty({ dayRate: 300_000, penaltyDays: 3 }), 900_000);
  assert.equal(calculateUnauthorizedAbsencePenalty({ dayRate: 300_000, penaltyDays: 2 }), 600_000);
});

test("RPC validates every mutation condition and writes attendance plus audit atomically", () => {
  for (const marker of [
    "attendance_tracking_disabled", "before_hire_date", "after_termination_date", "future_date",
    "business_day_not_completed", "work_schedule_not_found", "store_closed", "payroll_paid_locked",
    "already_unauthorized_absence", "leave_conflict", "attendance_conflict", "reason_required",
    "unauthorized_absence_cannot_be_cancelled",
  ]) assert.match(migration, new RegExp(marker));
  assert.match(migration, /payment_status = 'paid'/);
  assert.match(migration, /insert into public\.attendance_records[\s\S]*insert into public\.attendance_record_audit_logs/);
  assert.match(migration, /delete from public\.attendance_records/);
  assert.match(migration, /'set_unauthorized_absence', 'cancel_unauthorized_absence'/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /revoke all on function[\s\S]*from public[\s\S]*from anon[\s\S]*from authenticated[\s\S]*grant execute[\s\S]*service_role/);
  assert.doesNotMatch(migration, /payroll_run_reviews|confirm_unauthorized_absence|payroll_runs/);
});

test("admin API delegates both actions to the transactional RPC", () => {
  assert.match(admin, /action === "set_unauthorized_absence" \|\| action === "cancel_unauthorized_absence"/);
  assert.match(admin, /attendance_admin_unauthorized_absence_v1/);
  assert.match(admin, /payroll_paid_locked/);
});

test("monthly payroll creates only the unauthorized deduction on that day in regular and fixed-monthly paths", () => {
  assert.ok((payroll.match(/item\("unauthorized_absence_deduction","deduction"/g) ?? []).length >= 2);
  assert.match(payroll, /record\?\.status==="unauthorized_absence"[\s\S]*unauthorized_absence_deduction[\s\S]*continue;/);
  assert.match(payroll, /calculationBasis:"fixed_monthly"[\s\S]*records\.filter\(row=>row\.status==="unauthorized_absence"/);
  for (const field of ["attendanceRecordId", "businessDate", "dayRate", "penaltyDays", "calculatedAmount", "contractRevision", "scheduleRevision", "storeSettingsRevision", "engineVersion"]) assert.match(payroll, new RegExp(field));
});
