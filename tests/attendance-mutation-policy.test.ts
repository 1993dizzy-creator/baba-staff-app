import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const policyModulePath = "../lib/attendance/mutation-policy.ts";
const apiPolicyModulePath = "../lib/attendance/api-policy.ts";
const { canCancelOwnLeave, getNormalizedLatePatch } = await import(
  policyModulePath
);
const { isAttendanceAdminRole, validateLeaveRequestTarget } = await import(
  apiPolicyModulePath
);

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("leave requests are forced to the signed actor", () => {
  assert.deepEqual(validateLeaveRequestTarget(7, undefined), {
    ok: true,
    userId: 7,
  });
  assert.equal(validateLeaveRequestTarget(7, 7).ok, true);
  assert.equal(validateLeaveRequestTarget(7, 8).status, 403);
  assert.equal(validateLeaveRequestTarget(7, "owner").status, 403);
});

test("only the record owner can cancel leave while preserving existing approval behavior", () => {
  assert.equal(
    canCancelOwnLeave({ actorId: 7, recordUserId: 7 }),
    true
  );
  assert.equal(
    canCancelOwnLeave({ actorId: 7, recordUserId: 8 }),
    false
  );
  assert.equal(
    canCancelOwnLeave({ actorId: 7, recordUserId: 7 }),
    true
  );
});

test("attendance administration is restricted to owner and master", () => {
  assert.equal(isAttendanceAdminRole("owner"), true);
  assert.equal(isAttendanceAdminRole("master"), true);
  for (const role of ["manager", "leader", "staff"]) {
    assert.equal(isAttendanceAdminRole(role), false);
  }
});

test("late normalization changes only late state and preserves open checkout", () => {
  const patch = getNormalizedLatePatch(
    { status: "late", check_out_at: null, early_leave_minutes: 0 },
    "2026-07-22T00:00:00.000Z"
  );
  assert.deepEqual(patch, {
    late_minutes: 0,
    status: "working",
    updated_at: "2026-07-22T00:00:00.000Z",
  });
  for (const forbidden of [
    "check_in_at",
    "check_out_at",
    "work_minutes",
    "early_leave_minutes",
    "work_date",
    "user_id",
  ]) {
    assert.equal(Object.hasOwn(patch, forbidden), false, forbidden);
  }
});

test("routes authenticate the session and clients do not send actor identity", () => {
  const leave = read("app/api/attendance/leave/route.ts");
  const leaveAdmin = read("app/api/attendance/leave-admin/route.ts");
  const admin = read("app/api/attendance/admin/route.ts");
  for (const route of [leave, leaveAdmin, admin]) {
    assert.match(route, /requireAttendanceActor\(\)/);
  }
  assert.doesNotMatch(leaveAdmin, /admin_id|admin_name/);
  assert.doesNotMatch(admin, /actorUsername|admin_name/);

  const screens = [
    "app/(protected)/attendance/leave/page.tsx",
    "app/(protected)/attendance/staff/page.tsx",
    "app/(protected)/attendance/overview/page.tsx",
    "app/(protected)/attendance/overview/[userId]/page.tsx",
  ].map(read).join("\n");
  assert.doesNotMatch(screens, /actorUsername|admin_id|admin_name/);
  assert.match(screens, /attendanceFetch\("\/api\/attendance\/admin"/);
  assert.match(screens, /attendanceFetch\(url/);
});
