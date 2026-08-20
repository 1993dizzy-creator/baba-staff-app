import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/payroll-summary/route.ts");
const overview = read("lib/payroll/overview-server.ts");
const snapshot = read("lib/payroll/monthly-run.ts");
const adminOverviewRoute = read("app/api/admin/payroll/overview/route.ts");

test("attendance payroll summary targets only the server-authenticated actor", () => {
  assert.match(route, /loadPayrollOverview\(month, \{\s*userId: auth\.actor\.id,\s*\}\)/);
  assert.doesNotMatch(route, /searchParams\.get\("userId"\)|body\.userId/);
});

test("payroll overview forwards the optional target without changing the full default", () => {
  assert.match(overview, /options\?:\{userId\?:number;onSnapshotReady\?:/);
  assert.match(overview, /options\?\.userId===undefined\?adjustmentQuery:adjustmentQuery\.eq\("user_id",options\.userId\)/);
  assert.match(overview, /loadPayrollMonthSnapshot\(month,\{calculationEndDate:period\.calculationEndDate,userId:options\?\.userId,attendancePromise\}\)/);
  assert.match(overview, /loadMonthlyAttendanceStandings\(month,\{period,userId:options\?\.userId,attendancePromise\}\)/);
  // Phase 2 (meal-allowance early start) added an onSnapshotReady hook to
  // this call site, so it now passes an options object — but still never a
  // userId, so this route remains the full/unfiltered consumer.
  assert.match(adminOverviewRoute, /loadPayrollOverview\(month,\{/);
  const overviewCallSite = adminOverviewRoute.slice(
    adminOverviewRoute.indexOf("const overviewPromise=loadPayrollOverview(month,{"),
  );
  const overviewCallBody = overviewCallSite.slice(0, overviewCallSite.indexOf("});") + 3);
  assert.doesNotMatch(overviewCallBody, /userId:/);
});

test("targeted snapshot filters only employee-scoped queries", () => {
  for (const [query, column] of [
    ["userQuery", "id"],
    ["attendanceQuery", "user_id"],
    ["contractQuery", "user_id"],
    ["scheduleQuery", "user_id"],
    ["insuranceQuery", "user_id"],
    ["levelProgramQuery", "user_id"],
  ] as const) {
    assert.match(
      snapshot,
      new RegExp(`targetUserId===undefined\\?${query}:${query}\\.eq\\("${column}",targetUserId\\)`),
    );
  }

  assert.match(snapshot, /from\("attendance_record_manual_overrides"\)[\s\S]*is\("revoked_at",null\)/);
  assert.match(snapshot, /from\("store_setting_versions"\)/);
  assert.match(snapshot, /from\("payroll_settings"\)/);
  assert.doesNotMatch(snapshot, /overrideQuery\.eq\("user_id"|settingTimelineQuery\.eq\("user_id"|payrollSettingsQuery\.eq\("user_id"/);
});

test("targeting changes input scope without duplicating payroll formulas", () => {
  assert.equal((snapshot.match(/export function calculatePayrollBatch/g) ?? []).length, 1);
  assert.equal((snapshot.match(/function calculateEmployee/g) ?? []).length, 1);
  assert.match(overview, /snapshot\.employees\.map\(employee=>employee\.userId\)/);
  assert.doesNotMatch(overview, /function calculateEmployee|calculateCombinedSalary|calculateLatePenalty/);
});
