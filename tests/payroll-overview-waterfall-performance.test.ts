import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const standing = read("lib/attendance/monthly-standing-server.ts");
const overview = read("lib/payroll/overview-server.ts");
const route = read("app/api/admin/payroll/overview/route.ts");

test("monthly standing accepts a resolved period while preserving the existing fallback", () => {
  // options widened (Phase 2) to also accept the shared attendancePromise —
  // period/userId acceptance and the resolvePayrollOverviewPeriod fallback
  // are unchanged.
  assert.match(standing, /options\?: \{ period\?: PayrollOverviewPeriod; userId\?: number; attendancePromise\?: Promise<\{ data: AttendanceRow\[\] \| null; error: unknown \}> \}/);
  assert.match(standing, /const period = options\?\.period \?\? await resolvePayrollOverviewPeriod\(month\)/);
  assert.match(standing, /const calculationEndDate = period\.calculationEndDate/);
  assert.match(standing, /return \{ asOfDate: period\.asOfDate, users, standings \}/);
});

test("payroll overview overlaps adjustments with period resolution and shares that period", () => {
  const adjustmentIndex = overview.indexOf("const adjustmentPromise=");
  const periodIndex = overview.indexOf("const period=await resolvePayrollOverviewPeriod(month)");
  assert.ok(adjustmentIndex > -1 && adjustmentIndex < periodIndex);
  assert.match(overview, /void adjustmentPromise\.catch\(\(\)=>undefined\)/);
  // Phase 2: standing now also receives the shared attendancePromise, still
  // invoked directly from period (not chained off snapshotPromise).
  assert.match(overview, /loadMonthlyAttendanceStandings\(month,\{period,userId:options\?\.userId,attendancePromise\}\)/);
  assert.equal((overview.match(/resolvePayrollOverviewPeriod\(month\)/g) ?? []).length, 1);
});

test("snapshot and standing remain parallel and bonus versions start from snapshot completion", () => {
  assert.match(overview, /const snapshotPromise=loadPayrollMonthSnapshot/);
  assert.match(overview, /const attendanceStandingPromise=loadMonthlyAttendanceStandings/);
  assert.match(overview, /const bonusVersionsPromise=snapshotPromise\.then\(snapshot=>[\s\S]*?loadAttendanceBonusVersions\(month,snapshot\.employees\.map/);
  assert.match(overview, /Promise\.all\(\[[\s\S]*?snapshotPromise,[\s\S]*?adjustmentPromise,[\s\S]*?attendanceStandingPromise,[\s\S]*?bonusVersionsPromise/);
});

test("overview route overlaps overview with its payment batch query", () => {
  // Phase 2 (meal-allowance early start): the call now carries an
  // onSnapshotReady options object instead of being argument-less, but
  // paymentBatchPromise is still built independently and still only
  // overlaps with overviewPromise via the same Promise.all below.
  assert.match(route, /const overviewPromise=loadPayrollOverview\(month,\{/);
  assert.match(route, /const paymentBatchPromise=Promise\.resolve\([\s\S]*?payroll_payment_batches/);
  assert.match(route, /Promise\.all\(\[overviewPromise,paymentBatchPromise\]\)/);
  // paymentBatchPromise is constructed textually after the onSnapshotReady
  // hook body, and the hook body (up to that point) never references
  // paymentBatchPromise/run — confirming no dependency either direction.
  const onSnapshotReadyBody = route.slice(
    route.indexOf("onSnapshotReady:({snapshot,period})=>{"),
    route.indexOf("const paymentBatchPromise="),
  );
  assert.doesNotMatch(onSnapshotReadyBody, /paymentBatchPromise|\brun\b/);
});

test("employee payments and meal allowance are awaited together at the end, without changing response inputs", () => {
  assert.match(route, /const paymentsPromise=run[\s\S]*?: Promise\.resolve\(\{data:\[\],error:null\}\)/);
  // Phase 2 (meal-allowance early start): mealAllowancePromise is now built
  // inside onSnapshotReady, from snapshot.context.*/snapshot.employees —
  // not overview.snapshot.context.*/overview.employees — see
  // payroll-overview-meal-allowance-early-start.test.ts for the full
  // dependency-graph coverage of that change. This test only re-confirms
  // the two promises are still awaited together in one Promise.all here.
  assert.match(route, /mealAllowancePromise=loadMealAllowanceCostSummary\(month,\{[\s\S]*?users:snapshot\.context\.users,[\s\S]*?contracts:snapshot\.context\.contracts,[\s\S]*?attendance:snapshot\.context\.attendance,[\s\S]*?payrollUserIds:snapshot\.employees\.map/);
  assert.match(route, /Promise\.all\(\[paymentsPromise,mealAllowancePromise!\]\)/);
  assert.match(route, /payrollPaymentSnapshotHash\(buildEmployeePaymentSnapshot/);
  assert.match(route, /PAYROLL_OVERVIEW_READ_FAILED/);
});
