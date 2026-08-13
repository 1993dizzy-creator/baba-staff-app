import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260813180226_add_safe_approved_leave_cancellation.sql");
const route = read("app/api/attendance/admin/route.ts");
const page = read("app/(protected)/admin/payroll/attendance/[userId]/page.tsx");

test("approved and direct leave cancellation share the atomic cancellation RPC", () => {
  assert.match(migration, /p_action = 'cancel_leave'/);
  assert.match(migration, /v_record\.is_staff_direct_leave is true[\s\S]*or v_record\.approval_status = 'approved'/);
  assert.match(migration, /v_record\.status <> 'leave'/);
  assert.match(migration, /v_record\.check_in_at is not null/);
  assert.match(migration, /v_record\.check_out_at is not null/);
  assert.match(migration, /for update/);
  assert.match(migration, /'status', 'record_changed'/);
});

test("RPC revalidates owner or master and rejects every other role", () => {
  assert.match(migration, /where id = p_actor_user_id and is_active = true/);
  assert.match(migration, /v_actor_role not in \('owner', 'master'\)/);
  assert.match(migration, /'status', 'forbidden'/);
  assert.match(route, /forbidden:[\s\S]*http: 403/);
});

test("leave cancellation follows payroll payment lock order and rejects paid months", () => {
  assert.match(migration, /pg_advisory_xact_lock\([\s\S]*82118/);
  assert.match(migration, /pg_advisory_xact_lock\(82119, p_target_user_id::integer\)/);
  assert.match(migration, /public\.payroll_employee_payments ep/);
  assert.match(migration, /public\.payroll_payment_batches b/);
  assert.match(migration, /ep\.payment_status = 'paid'/);
  assert.match(migration, /'status', 'payroll_paid_locked'/);
  assert.match(route, /payroll_paid_locked:[\s\S]*PAYROLL_PAID_LOCKED/);
  assert.ok(migration.indexOf("'status', 'record_changed'") < migration.indexOf("'status', 'payroll_paid_locked'"));
});

test("leave deletion preserves immutable audit context and before snapshot", () => {
  assert.match(migration, /v_before_snapshot := to_jsonb\(v_record\)/);
  assert.match(migration, /p_action = 'cancel_leave'[\s\S]*insert into public\.attendance_record_audit_logs[\s\S]*v_record\.id, v_record\.id, v_record\.user_id, v_record\.work_date,[\s\S]*p_action, p_actor_user_id, v_before_snapshot[\s\S]*delete from public\.attendance_records/);
});

test("approved leave UI cancels independently and reloads server records", () => {
  assert.match(page, /record\.status === "leave" && record\.approval_status === "approved"/);
  assert.match(page, /window\.confirm\(t\.leaveCancelConfirm\)/);
  assert.match(page, /action: "cancel_leave"/);
  assert.match(page, /await fetchDetail\(\)/);
  assert.match(page, /setMessage\(t\.leaveCancelDone\)/);
  assert.doesNotMatch(page.match(/const handleCancelLeave[\s\S]*?\n    };/)?.[0] ?? "", /unauthorized_absence/);
});

test("no-record flow still exposes the existing unauthorized absence action", () => {
  assert.match(page, /!record \?/);
  assert.match(page, /blankMode === "unauthorized_absence"/);
  assert.match(page, /onUnauthorizedAbsence\("set_unauthorized_absence", reason\)/);
});
