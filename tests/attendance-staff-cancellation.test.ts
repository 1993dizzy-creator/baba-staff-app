import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strip-types resolves the TypeScript source directly.
import { getStaffCancellationDecision } from "../lib/attendance/mutation-policy.ts";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/admin/route.ts");
const page = read("app/(protected)/attendance/staff/page.tsx");
const recordsPolicy = read("lib/attendance/api-policy.ts");
const employeeLeaveRoute = read("app/api/attendance/leave/route.ts");
const migration = read(
  "supabase/migrations/202607240002_add_attendance_staff_direct_leave_marker.sql"
);

test("check-in cancellation permits only an open non-leave record", () => {
  assert.deepEqual(
    getStaffCancellationDecision("cancel_check_in", {
      status: "working",
      check_in_at: "2026-07-24T09:00:00Z",
      check_out_at: null,
      late_minutes: 0,
    }),
    { ok: true, mutation: "delete" }
  );
  assert.equal(
    getStaffCancellationDecision("cancel_check_in", {
      status: "done",
      check_in_at: "2026-07-24T09:00:00Z",
      check_out_at: "2026-07-24T17:00:00Z",
      late_minutes: 0,
    }).code,
    "CHECK_OUT_MUST_BE_CANCELLED_FIRST"
  );
  assert.equal(
    getStaffCancellationDecision("cancel_check_in", {
      status: "leave",
      check_in_at: null,
      check_out_at: null,
      late_minutes: 0,
    }).code,
    "CHECK_IN_CANNOT_BE_CANCELLED"
  );
});

test("check-out cancellation preserves check-in semantics and restores open status", () => {
  const late = getStaffCancellationDecision("cancel_check_out", {
    status: "done",
    check_in_at: "2026-07-24T09:06:00Z",
    check_out_at: "2026-07-24T17:00:00Z",
    late_minutes: 6,
  });
  assert.deepEqual(late, {
    ok: true,
    mutation: "update",
    patch: {
      check_out_at: null,
      work_minutes: 0,
      early_leave_minutes: 0,
      status: "late",
    },
  });

  const onTime = getStaffCancellationDecision("cancel_check_out", {
    status: "done",
    check_in_at: "2026-07-24T09:00:00Z",
    check_out_at: "2026-07-24T17:00:00Z",
    late_minutes: 0,
  });
  assert.equal(onTime.ok, true);
  assert.equal(onTime.ok && onTime.mutation === "update" && onTime.patch.status, "working");

  const earlyLeave = getStaffCancellationDecision("cancel_check_out", {
    status: "early_leave",
    check_in_at: "2026-07-24T09:00:00Z",
    check_out_at: "2026-07-24T15:00:00Z",
    late_minutes: 0,
  });
  assert.deepEqual(earlyLeave, {
    ok: true,
    mutation: "update",
    patch: {
      check_out_at: null,
      work_minutes: 0,
      early_leave_minutes: 0,
      status: "working",
    },
  });

  assert.equal(
    getStaffCancellationDecision("cancel_check_out", {
      status: "working",
      check_in_at: "2026-07-24T09:00:00Z",
      check_out_at: null,
      late_minutes: 0,
    }).code,
    "CHECK_OUT_CANNOT_BE_CANCELLED"
  );
  assert.equal(
    getStaffCancellationDecision("cancel_check_out", {
      status: "leave",
      check_in_at: null,
      check_out_at: null,
      late_minutes: 0,
    }).code,
    "CHECK_OUT_CANNOT_BE_CANCELLED"
  );
});

test("leave cancellation is limited to direct staff-list leave records", () => {
  assert.deepEqual(
    getStaffCancellationDecision("cancel_leave", {
      status: "leave",
      check_in_at: null,
      check_out_at: null,
      late_minutes: 0,
      is_staff_direct_leave: true,
    }),
    { ok: true, mutation: "delete" }
  );
  assert.equal(
    getStaffCancellationDecision("cancel_leave", {
      status: "leave",
      check_in_at: null,
      check_out_at: null,
      late_minutes: 0,
      is_staff_direct_leave: false,
    }).code,
    "DIRECT_LEAVE_CANNOT_BE_CANCELLED"
  );
  assert.equal(
    getStaffCancellationDecision("cancel_leave", {
      status: "leave",
      check_in_at: "2026-07-24T09:00:00Z",
      check_out_at: null,
      late_minutes: 0,
      is_staff_direct_leave: true,
    }).code,
    "DIRECT_LEAVE_CANNOT_BE_CANCELLED"
  );

  const noteChanged = {
    status: "leave",
    check_in_at: null,
    check_out_at: null,
    late_minutes: 0,
    is_staff_direct_leave: true,
    note: "운영자가 수정한 업무 메모",
  };
  assert.deepEqual(
    getStaffCancellationDecision("cancel_leave", noteChanged),
    { ok: true, mutation: "delete" }
  );
});

test("admin route rechecks identity, date, and current row state for cancellation", () => {
  assert.match(route, /"cancel_check_in"/);
  assert.match(route, /"cancel_check_out"/);
  assert.match(route, /"cancel_leave"/);
  assert.match(route, /\.rpc\("attendance_admin_cancel_record_v1"/);
  assert.match(route, /p_target_user_id: targetUserId/);
  assert.match(route, /p_work_date: work_date/);
  assert.match(route, /p_actor_user_id: auth\.actor\.id/);
  assert.match(route, /p_reason: reason/);
  assert.match(route, /is_staff_direct_leave: true/);
  assert.match(route, /note: note \?\? existing\?\.note \?\? null/);
  assert.match(route, /is_staff_direct_leave: false/);
  assert.doesNotMatch(route, /attendance_staff_direct_leave/);
  assert.doesNotMatch(route, /\/api\/attendance\/leave(?:-admin)?/);
  assert.match(route, /\{ status: 409 \}/);
});

test("staff modal distinguishes destructive cancellation and closes only after success", () => {
  assert.match(page, /출근취소/);
  assert.match(page, /퇴근취소/);
  assert.match(page, /휴무취소/);
  assert.match(page, /modalDangerButtonStyle/);
  assert.match(page, /window\.confirm\(confirmMessage\)/);
  assert.match(page, /if \(!response\.ok \|\| !result\?\.ok\)/);
  assert.match(page, /setMutationError\(result\?\.message \|\| c\.editFail\)/);
  assert.match(page, /closeActionModal\(\)/);
  assert.match(page, /disabled=\{mutationBusy\}/);
  assert.match(page, /setManualModal\(null\)/);
});

test("dedicated marker migration is secure, false by default, and visible only to staff admin UI", () => {
  assert.match(
    migration,
    /add column if not exists is_staff_direct_leave boolean not null default false/
  );
  assert.match(migration, /comment on column public\.attendance_records\.is_staff_direct_leave/);
  assert.match(migration, /where is_staff_direct_leave is null/);
  assert.match(migration, /where is_staff_direct_leave is distinct from false/);
  assert.doesNotMatch(migration, /\bgrant\b|\brevoke\b|enable row level security/i);
  assert.match(
    recordsPolicy,
    /staff_today:[\s\S]*approval_status,is_staff_direct_leave/
  );
  assert.match(page, /\.is_staff_direct_leave !== true/);
  assert.doesNotMatch(page, /attendance_staff_direct_leave/);
  assert.doesNotMatch(employeeLeaveRoute, /is_staff_direct_leave:\s*true/);
});
