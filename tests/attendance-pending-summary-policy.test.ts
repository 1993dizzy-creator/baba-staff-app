import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const apiPolicyModulePath = "../lib/attendance/api-policy.ts";
const { isAttendanceAdminRole } = await import(apiPolicyModulePath);

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("pending leave summary is restricted to owner and master", () => {
  assert.equal(isAttendanceAdminRole("owner"), true);
  assert.equal(isAttendanceAdminRole("master"), true);
  for (const role of ["manager", "leader", "staff"]) {
    assert.equal(isAttendanceAdminRole(role), false);
  }
});

test("pending summary route uses server session and returns only summary data", () => {
  const route = read("app/api/attendance/leave-pending-summary/route.ts");

  assert.match(route, /requireAttendanceActor\(\)/);
  assert.match(route, /isAttendanceAdminRole\(auth\.actor\.role\)/);
  assert.match(route, /\.eq\("status", ATTENDANCE_STATUS\.LEAVE\)/);
  assert.match(route, /\.eq\("approval_status", APPROVAL_STATUS\.PENDING\)/);
  assert.match(route, /pendingCount/);
  assert.match(route, /hasPending/);
  assert.match(route, /oldestWorkDate/);
  assert.doesNotMatch(route, /searchParams|headers\(|cookies\(\).*role/);
  assert.doesNotMatch(route, /note|birth_date|gender|latitude|longitude/);
});

test("protected layout no longer reads attendance tables from the browser", () => {
  const layout = read("app/(protected)/layout.tsx");

  assert.match(layout, /fetch\("\/api\/attendance\/leave-pending-summary"/);
  assert.doesNotMatch(layout, /@\/lib\/supabase\/client/);
  assert.doesNotMatch(layout, /\.from\(["']attendance_(?:records|check_logs)["']\)/);
  assert.match(layout, /if \(!response\.ok \|\| controller\.signal\.aborted\) return/);
});
