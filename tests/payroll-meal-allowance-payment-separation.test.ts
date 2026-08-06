import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const overviewType = read("lib/payroll/overview.ts");
const paymentSnapshot = read("lib/payroll/payment-snapshot.ts");
const overviewServer = read("lib/payroll/overview-server.ts");
const paymentsRoute = read("app/api/admin/payroll/payments/route.ts");
const monthlyRun = read("lib/payroll/monthly-run.ts");
const overviewRoute = read("app/api/admin/payroll/overview/route.ts");

test("PayrollOverviewEmployee (lib/payroll/overview.ts) has no meal allowance field — per-employee payout objects never carry meal data", () => {
  assert.doesNotMatch(overviewType, /mealAllowance/i);
});

test("buildEmployeePaymentSnapshot (payment-snapshot.ts) has no meal allowance field — the hashed payment snapshot is untouched", () => {
  assert.doesNotMatch(paymentSnapshot, /mealAllowance/i);
});

test("loadPayrollOverview (overview-server.ts) is completely untouched by this feature — the shared loader used by both /overview and /payments never queries meal allowance data", () => {
  assert.doesNotMatch(overviewServer, /mealAllowance/i);
  assert.doesNotMatch(overviewServer, /meal-allowance/i);
});

test("the payments POST route (payroll_pay_employee_v1 caller) never references meal allowance — actualPaidAmount/netPayoutAmount/calculationHash flow is unchanged", () => {
  assert.doesNotMatch(paymentsRoute, /mealAllowance/i);
  assert.doesNotMatch(paymentsRoute, /meal_allowance/i);
});

test("monthly-run.ts (the payroll fact-calculation engine) never references meal allowance — base_work/incentive/penalty items are unaffected", () => {
  assert.doesNotMatch(monthlyRun, /mealAllowance/i);
});

test("overview route: meal allowance is computed strictly AFTER employees[].calculationHash is built, proving the hash cannot depend on it", () => {
  const employeesIndex = overviewRoute.indexOf("const employees=overview.employees.map");
  const calculationHashIndex = overviewRoute.indexOf("calculationHash");
  const mealAllowanceIndex = overviewRoute.indexOf("loadMealAllowanceCostSummary(");
  assert.ok(employeesIndex > -1 && calculationHashIndex > -1 && mealAllowanceIndex > -1);
  assert.ok(calculationHashIndex < mealAllowanceIndex, "calculationHash must be computed before meal allowance is loaded");
});

test("overview route: employees[] payload passed to the client is the same array used for calculationHash — meal allowance is only merged into summary/projectedSummary, never into employees[]", () => {
  const responseCallIndex = overviewRoute.lastIndexOf("payrollJson({ok:true");
  const responseCall = overviewRoute.slice(responseCallIndex);
  assert.match(responseCall, /employees,summary,projectedSummary,mealAllowancePolicyMissing:mealAllowance\.policyMissing/);
});

test("overview route: summary/projectedSummary meal allowance merge only adds mealAllowanceAmount and increases totalCompanyCostAmount — no other field is touched", () => {
  assert.match(
    overviewRoute,
    /const summary=\{\.\.\.overview\.summary,mealAllowanceAmount:mealAllowance\.currentAmount,totalCompanyCostAmount:overview\.summary\.totalCompanyCostAmount\+mealAllowance\.currentAmount\};/,
  );
  assert.match(
    overviewRoute,
    /const projectedSummary=overview\.projectedSummary\?\{\.\.\.overview\.projectedSummary,mealAllowanceAmount:mealAllowance\.projectedAmount,totalCompanyCostAmount:overview\.projectedSummary\.totalCompanyCostAmount\+mealAllowance\.projectedAmount\}:null;/,
  );
});

test("payment-critical migrations (contract/insurance/payment RPCs, payroll_run_*, payroll_payment_batches) are not touched by the new migration file", () => {
  // 헤더 주석에서 "이 함수들을 건드리지 않는다"고 설명하며 이름을 언급하는 것은 허용한다 —
  // 여기서 검증할 것은 실제로 정의(create/alter/drop)하는 문장이 없다는 것이다.
  const migration = read("supabase/migrations/202608070001_add_payroll_meal_allowance.sql");
  assert.doesNotMatch(migration, /(create|create or replace|alter|drop) (table|function) public\.payroll_run_employees/);
  assert.doesNotMatch(migration, /(create|create or replace|alter|drop) (table|function) public\.payroll_run_items/);
  assert.doesNotMatch(migration, /(create|create or replace|alter|drop) (table|function) public\.payroll_run_reviews/);
  assert.doesNotMatch(migration, /(create|create or replace|alter|drop) (table|function) public\.payroll_payment_batches/);
  assert.doesNotMatch(migration, /(create|create or replace|alter|drop) (table|function) public\.payroll_employee_payments/);
  assert.doesNotMatch(migration, /create or replace function public\.payroll_pay_employee/);
});
