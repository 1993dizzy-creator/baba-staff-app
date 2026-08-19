import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/monthly-summary/route.ts");
const server = read("lib/attendance/monthly-standing-server.ts");
const employeeBonus = read("components/payroll/EmployeeAttendanceBonusSettings.tsx");
const fullSummaryHook = read("components/attendance/useMonthlyAttendanceSummary.ts");
const payrollOverview = read("lib/payroll/overview-server.ts");

test("monthly summary keeps the full path and adds an optional positive safe user id", () => {
  assert.match(route, /const userIdParam = searchParams\.get\("userId"\)/);
  assert.match(route, /!Number\.isSafeInteger\(Number\(userIdParam\)\)/);
  assert.match(route, /Number\(userIdParam\) < 1/);
  assert.match(route, /code: "INVALID_USER_ID"/);
  assert.match(route, /loadMonthlyAttendanceStandings\(month, \{ userId \}\)/);
});

test("targeted standing filters only employee-scoped database inputs", () => {
  assert.match(server, /options\?: \{ period\?: PayrollOverviewPeriod; userId\?: number \}/);
  assert.match(server, /baseUserQuery\.eq\("id", options\.userId\)/);
  assert.match(server, /baseAttendanceQuery\.eq\("user_id", options\.userId\)/);
  assert.match(server, /baseScheduleQuery\.eq\("user_id", options\.userId\)/);
  assert.match(server, /\.in\("attendance_record_id", attendanceRecordIds\)/);
  assert.doesNotMatch(server, /settingResult[\s\S]*\.eq\("user_id"/);
  assert.doesNotMatch(server, /holidayResult[\s\S]*\.eq\("user_id"/);
});

test("full consumers stay unfiltered while payroll employee settings requests one user", () => {
  assert.match(employeeBonus, /monthly-summary\?month=\$\{payrollMonth\}&userId=\$\{userId\}/);
  assert.match(fullSummaryHook, /monthly-summary\?month=\$\{month\}`/);
  assert.doesNotMatch(fullSummaryHook, /userId=/);
  assert.match(payrollOverview, /loadMonthlyAttendanceStandings\(month,\{period\}\)/);
});

test("full and targeted paths share one calculation implementation", () => {
  assert.equal(server.match(/for \(const user of users\)/g)?.length, 1);
  assert.equal(server.match(/classifyMonthlyAttendanceDay\(/g)?.length, 1);
  assert.equal(server.match(/normalizeAttendanceDayFacts\(/g)?.length, 1);
  assert.equal(server.match(/evaluateMonthlyAttendanceStanding\(/g)?.length, 1);
});
