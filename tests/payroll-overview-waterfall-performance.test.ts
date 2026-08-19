import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const standing = read("lib/attendance/monthly-standing-server.ts");
const overview = read("lib/payroll/overview-server.ts");
const route = read("app/api/admin/payroll/overview/route.ts");

test("monthly standing accepts a resolved period while preserving the existing fallback", () => {
  assert.match(standing, /options\?: \{ period\?: PayrollOverviewPeriod; userId\?: number \}/);
  assert.match(standing, /const period = options\?\.period \?\? await resolvePayrollOverviewPeriod\(month\)/);
  assert.match(standing, /const calculationEndDate = period\.calculationEndDate/);
  assert.match(standing, /return \{ asOfDate: period\.asOfDate, users, standings \}/);
});

test("payroll overview overlaps adjustments with period resolution and shares that period", () => {
  const adjustmentIndex = overview.indexOf("const adjustmentPromise=");
  const periodIndex = overview.indexOf("const period=await resolvePayrollOverviewPeriod(month)");
  assert.ok(adjustmentIndex > -1 && adjustmentIndex < periodIndex);
  assert.match(overview, /void adjustmentPromise\.catch\(\(\)=>undefined\)/);
  assert.match(overview, /loadMonthlyAttendanceStandings\(month,\{period\}\)/);
  assert.equal((overview.match(/resolvePayrollOverviewPeriod\(month\)/g) ?? []).length, 1);
});

test("snapshot and standing remain parallel and bonus versions start from snapshot completion", () => {
  assert.match(overview, /const snapshotPromise=loadPayrollMonthSnapshot/);
  assert.match(overview, /const attendanceStandingPromise=loadMonthlyAttendanceStandings/);
  assert.match(overview, /const bonusVersionsPromise=snapshotPromise\.then\(snapshot=>[\s\S]*?loadAttendanceBonusVersions\(month,snapshot\.employees\.map/);
  assert.match(overview, /Promise\.all\(\[[\s\S]*?snapshotPromise,[\s\S]*?adjustmentPromise,[\s\S]*?attendanceStandingPromise,[\s\S]*?bonusVersionsPromise/);
});

test("overview route overlaps overview with its payment batch query", () => {
  assert.match(route, /const overviewPromise=loadPayrollOverview\(month\)/);
  assert.match(route, /const paymentBatchPromise=Promise\.resolve\([\s\S]*?payroll_payment_batches/);
  assert.match(route, /Promise\.all\(\[overviewPromise,paymentBatchPromise\]\)/);
});

test("employee payments and meal allowance run together without changing response inputs", () => {
  assert.match(route, /const paymentsPromise=run[\s\S]*?: Promise\.resolve\(\{data:\[\],error:null\}\)/);
  assert.match(route, /const mealAllowancePromise=loadMealAllowanceCostSummary\(month,\{[\s\S]*?users:overview\.snapshot\.context\.users,[\s\S]*?contracts:overview\.snapshot\.context\.contracts,[\s\S]*?attendance:overview\.snapshot\.context\.attendance,[\s\S]*?payrollUserIds:overview\.employees\.map/);
  assert.match(route, /Promise\.all\(\[paymentsPromise,mealAllowancePromise\]\)/);
  assert.match(route, /payrollPaymentSnapshotHash\(buildEmployeePaymentSnapshot/);
  assert.match(route, /PAYROLL_OVERVIEW_READ_FAILED/);
});
