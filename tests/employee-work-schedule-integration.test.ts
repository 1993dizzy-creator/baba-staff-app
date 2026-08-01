import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/202608010002_unify_employee_work_schedule_source.sql");
const usersRoute = read("app/api/admin/users/route.ts");
const usersCreateRoute = read("app/api/admin/users/create/route.ts");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
const monthlyRun = read("lib/payroll/monthly-run.ts");

test("employee profile update and schedule revision share one RPC transaction", () => {
  assert.match(usersRoute, /employee_update_profile_and_level_v4/);
  assert.match(migration, /employee_update_profile_and_level_v3\(/);
  assert.match(migration, /pg_advisory_xact_lock\(-p_user_id\)/);
  assert.match(migration, /Asia\/Ho_Chi_Minh/);
  assert.match(migration, /is distinct from v_start_time/);
  assert.match(migration, /is distinct from v_end_time/);
  assert.match(migration, /unpaid_break_minutes[\s\S]*0,/);
  assert.match(usersCreateRoute, /employee_create_with_schedule_v1/);
  assert.doesNotMatch(usersCreateRoute, /\.from\("users"\)[\s\S]*\.insert\(/);
});

test("same-day edits preserve revisions and leave one open schedule", () => {
  assert.match(migration, /set effective_to = v_effective_date/);
  assert.match(migration, /coalesce\(max\(revision\), 0\) \+ 1/);
  assert.match(migration, /v_effective_date, null, v_revision/);
  assert.match(migration, /effective_to >= effective_from/);
  assert.doesNotMatch(migration, /delete from public\.employee_work_schedule_versions/i);
});

test("payroll settings no longer exposes a second schedule editor", () => {
  assert.doesNotMatch(settings, /PayrollScheduleVersions|급여용 근무시간|Giờ làm việc tính lương/);
  assert.equal(fs.existsSync(path.join(process.cwd(), "components/PayrollScheduleVersions.tsx")), false);
});

test("monthly payroll still resolves effective-dated schedule revisions", () => {
  assert.match(monthlyRun, /employee_work_schedule_versions/);
  assert.match(monthlyRun, /activeOn\(schedules,date\)/);
  assert.match(monthlyRun, /scheduleRevision:schedule\.revision/);
});
