import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const overview = read("lib/payroll/overview-server.ts");
const route = read("app/api/admin/payroll/overview/route.ts");
const monthlyRun = read("lib/payroll/monthly-run.ts");

// ---------------------------------------------------------------------------
// Phase 2 — meal allowance starts as soon as the payroll snapshot resolves,
// not after the full overview (standing/bonus/adjustments) or paymentBatch.
// ---------------------------------------------------------------------------

test("loadPayrollOverview: existing callers without onSnapshotReady are unaffected — the hook is optional and only fires when supplied", () => {
  assert.match(
    overview,
    /onSnapshotReady\?:\(input:\{snapshot:PayrollMonthSnapshot;period:PayrollOverviewPeriod\}\)=>void/,
  );
  assert.match(overview, /const onSnapshotReady=options\?\.onSnapshotReady;/);
  assert.match(overview, /if\(onSnapshotReady\)\{void snapshotPromise\.then/);
  // The other existing caller (payments/route.ts) still calls
  // loadPayrollOverview(month) with no options object at all.
  const paymentsRoute = read("app/api/admin/payroll/payments/route.ts");
  assert.match(paymentsRoute, /loadPayrollOverview\(month\);/);
});

test("onSnapshotReady fires only after snapshot resolves, and does not gate on standing/bonus versions/adjustments", () => {
  const fn = overview.slice(overview.indexOf("export async function loadPayrollOverview"));
  const snapshotPromiseIndex = fn.indexOf("const snapshotPromise=loadPayrollMonthSnapshot");
  const hookIndex = fn.indexOf("if(onSnapshotReady){void snapshotPromise.then");
  const standingIndex = fn.indexOf("const attendanceStandingPromise=loadMonthlyAttendanceStandings");
  const bonusIndex = fn.indexOf("const bonusVersionsPromise=snapshotPromise.then");
  const promiseAllIndex = fn.indexOf("await Promise.all([");
  assert.ok(snapshotPromiseIndex >= 0 && hookIndex > snapshotPromiseIndex);
  // The hook attaches to snapshotPromise BEFORE standing/bonus are even
  // created, and well before the outer Promise.all that waits for all four.
  assert.ok(hookIndex < standingIndex);
  assert.ok(hookIndex < bonusIndex);
  assert.ok(hookIndex < promiseAllIndex);
  // The hook's .then() has no onRejected branch of its own — a rejected
  // snapshotPromise skips the callback and is still surfaced by the real
  // Promise.all await below (attached to the SAME snapshotPromise variable,
  // untouched by the hook's separate derived chain).
  assert.match(fn, /void snapshotPromise\.then\(snapshot=>\{onSnapshotReady\(\{snapshot,period\}\);\}\)\.catch\(\(\)=>undefined\);/);
  assert.match(fn, /Promise\.all\(\[\s*snapshotPromise,\s*adjustmentPromise,\s*attendanceStandingPromise,\s*bonusVersionsPromise,?\s*\]\)/);
});

test("route: mealAllowancePromise is created inside onSnapshotReady, not after awaiting overview+paymentBatch", () => {
  const hookStart = route.indexOf("onSnapshotReady:({snapshot,period})=>{");
  const mealAllowanceAssignIndex = route.indexOf("mealAllowancePromise=loadMealAllowanceCostSummary(month,{", hookStart);
  const paymentBatchPromiseIndex = route.indexOf("const paymentBatchPromise=Promise.resolve(");
  const firstAwaitIndex = route.indexOf("await Promise.all([overviewPromise,paymentBatchPromise])");
  assert.ok(hookStart >= 0);
  // mealAllowancePromise is assigned strictly inside the onSnapshotReady
  // callback body, which is textually (and, per the previous test,
  // temporally) before paymentBatchPromise is even constructed and long
  // before the first await in this handler.
  assert.ok(mealAllowanceAssignIndex > hookStart && mealAllowanceAssignIndex < paymentBatchPromiseIndex);
  assert.ok(paymentBatchPromiseIndex < firstAwaitIndex);
});

test("route: meal allowance no longer depends on finalized overview.employees or run/paymentBatch", () => {
  // The old call site read overview.snapshot.context.* and
  // overview.employees.map(...) — both are gone.
  assert.doesNotMatch(route, /overview\.snapshot\.context/);
  assert.doesNotMatch(route, /overview\.employees\.map\(employee=>employee\.userId\)/);
  // meal allowance never references `run` (the paymentBatch result) anywhere.
  const mealAllowanceCall = route.slice(
    route.indexOf("mealAllowancePromise=loadMealAllowanceCostSummary(month,{"),
    route.indexOf("});", route.indexOf("mealAllowancePromise=loadMealAllowanceCostSummary(month,{")),
  );
  assert.doesNotMatch(mealAllowanceCall, /\brun\b/);
});

test("route: meal allowance still reuses snapshot.context.{users,contracts,attendance} and snapshot.employees' userIds, not overview.employees", () => {
  const mealAllowanceCall = route.slice(
    route.indexOf("mealAllowancePromise=loadMealAllowanceCostSummary(month,{"),
    route.indexOf("});", route.indexOf("mealAllowancePromise=loadMealAllowanceCostSummary(month,{")),
  );
  assert.match(mealAllowanceCall, /calculationEndDate:period\.calculationEndDate,/);
  assert.match(mealAllowanceCall, /users:snapshot\.context\.users,/);
  assert.match(mealAllowanceCall, /contracts:snapshot\.context\.contracts,/);
  assert.match(mealAllowanceCall, /attendance:snapshot\.context\.attendance,/);
  assert.match(mealAllowanceCall, /payrollUserIds:snapshot\.employees\.map\(employee=>employee\.userId\),/);
});

test("snapshot.employees' userId set is structurally identical to the finalized overview.employees' userId set (both derive from the same input.users)", () => {
  // monthly-run.ts: context.users and employees (via calculatePayrollBatch ->
  // selectPayrollUsers) both come from the same `input.users` array, so
  // every employee.userId in snapshot.employees is guaranteed to exist in
  // snapshot.context.users. overview-server.ts's userById.get(employee.userId)
  // filter in the finalized `employees` build is therefore never actually
  // exclusionary — the userId set doesn't change between snapshot.employees
  // and overview.employees.
  assert.match(monthlyRun, /return\{employees:calculatePayrollBatch\(input\),context:\{users:input\.users,contracts:input\.contracts,attendance:input\.attendance\}/);
  assert.match(overview, /const userById=new Map\(snapshot\.context\.users\.map\(user=>\[user\.id,user\]\)\);/);
  assert.match(
    overview,
    /const employees=snapshot\.employees\.flatMap\(employee=>\{const user=userById\.get\(employee\.userId\);return user\?\[buildPayrollOverviewEmployee/,
  );
});

test("mealAllowancePromise rejection is not swallowed: the guard catch is on a separate derived chain, and the real promise is still awaited (with a non-null assertion reflecting the always-assigned-by-then guarantee)", () => {
  assert.match(route, /void mealAllowancePromise\.catch\(\(\)=>undefined\);/);
  assert.match(route, /await Promise\.all\(\[paymentsPromise,mealAllowancePromise!\]\);if\(paymentError\)throw paymentError;/);
});

test("failure contract unchanged: any thrown error (including a meal allowance rejection) still collapses to the same PAYROLL_OVERVIEW_READ_FAILED 500 response", () => {
  assert.match(route, /catch \{\s*return payrollJson\(\{ ok: false, code: "PAYROLL_OVERVIEW_READ_FAILED" \}, 500\);/);
});

test("response shape and other route logic (payments, employees, summary, projectedSummary, paymentBatch) are untouched", () => {
  assert.match(
    route,
    /return payrollJson\(\{ok:true,month,asOfDate:overview\.period\.asOfDate,future:overview\.period\.future,monthClosed:isClosedPayrollMonth\(month\),employees,summary,projectedSummary,mealAllowancePolicyMissing:mealAllowance\.policyMissing,mealAllowanceEligibleUserIds,paymentBatch:run\?\?null\}\);/,
  );
  assert.match(route, /const summary=\{\.\.\.overview\.summary,mealAllowanceAmount:mealAllowance\.currentAmount/);
});

test("loadPayrollOverview return shape is unchanged (period, snapshot, employees, rawByUser, directorInsuranceAmount, summary, projectedSummary)", () => {
  assert.match(
    overview,
    /return \{period,snapshot,employees,rawByUser,directorInsuranceAmount,summary:buildPayrollOverviewSummary\(employees,directorInsuranceAmount\),projectedSummary:buildPayrollOverviewProjectedSummary\(employees,directorInsuranceAmount\)\};/,
  );
});
