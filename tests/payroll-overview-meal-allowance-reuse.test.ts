import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const monthlyRun = read("lib/payroll/monthly-run.ts");
const mealAllowanceServer = read("lib/payroll/meal-allowance-server.ts");
const overviewRoute = read("app/api/admin/payroll/overview/route.ts");
const runRoute = read("app/api/admin/payroll/runs/[runId]/route.ts");

// ---------------------------------------------------------------------------
// /admin/payroll 로딩 성능 최적화 1차 A — loadPayrollMonthSnapshot()이 이미 읽은
// users/attendance/contracts를 식대 표시 계산에 재사용해 overview 1회 호출당
// 중복 조회(users/contracts/attendance 재조회, eligibility 2단계 조회, 배지용 별도
// 조회)를 없앤다. 급여 계산 공식·payment snapshot/hash·매장설정 정책은 건드리지 않는다.
// ---------------------------------------------------------------------------

test("loadPayrollMonthSnapshot: context now also exposes attendance (in addition to the pre-existing users/contracts) for display-only reuse by callers", () => {
  assert.match(monthlyRun, /context:\{users:input\.users,contracts:input\.contracts,attendance:input\.attendance\}/);
});

test("loadPayrollMonthSnapshot: sourceSnapshot (the payment snapshot/hash input) is completely untouched by the context expansion — same fields, same shape", () => {
  assert.match(
    monthlyRun,
    /sourceSnapshot:\{engineVersion:PAYROLL_RUN_ENGINE_VERSION,calculatedAt:new Date\(\)\.toISOString\(\),calculationEndDate,attendanceRecordIds:input\.attendance\.map\(row=>row\.id\),contractRevisions:\[\.\.\.new Set\(input\.contracts\.map\(row=>row\.revision\)\)\],scheduleRevisions:\[\.\.\.new Set\(input\.schedules\.map\(row=>row\.revision\)\)\],levelProgramVersions:\[\.\.\.levelPrograms\.entries\(\)\]\.map\(\(\[userId,version\]\)=>\(\{userId,\.\.\.version\}\)\),storeSettingRevisions:\[\.\.\.new Set\(\[\.\.\.settingsByDate\.values\(\)\]\.map\(value=>value\.revision\)\.filter\(value=>value!==null\)\)\],insuranceSettings:insuranceSettingsSnapshot,penaltySettings:\{\.\.\.penaltySettings,capturedAt:new Date\(\)\.toISOString\(\)\}\}/,
  );
  assert.doesNotMatch(monthlyRun, /mealAllowance/i);
});

test("loadPayrollMonthSnapshot: AttendanceRow is now an exported type so meal-allowance-server.ts (and any other display-only reuser) can reference the exact snapshot shape without a duplicate type", () => {
  assert.match(monthlyRun, /export type AttendanceRow=/);
});

// ---------------------------------------------------------------------------
// lib/payroll/meal-allowance-server.ts — combined cost + badge loader
// ---------------------------------------------------------------------------

test("loadMealAllowanceCostSummary: input now requires the reused snapshot context (users/contracts/attendance/payrollUserIds), not just calculationEndDate", () => {
  assert.match(mealAllowanceServer, /export type MealAllowanceOverviewInput = \{/);
  assert.match(mealAllowanceServer, /users: readonly PayrollSnapshotUserRow\[\];/);
  assert.match(mealAllowanceServer, /contracts: readonly PayrollContract\[\];/);
  assert.match(mealAllowanceServer, /attendance: readonly AttendanceRow\[\];/);
  assert.match(mealAllowanceServer, /payrollUserIds: readonly number\[\];/);
  assert.match(mealAllowanceServer, /input: MealAllowanceOverviewInput,/);
});

test("loadMealAllowanceCostSummary: return type gains eligibleUserIds alongside the pre-existing currentAmount/projectedAmount/policyMissing fields", () => {
  assert.match(mealAllowanceServer, /eligibleUserIds: number\[\];/);
});

test("loadMealAllowanceCostSummary: queries exactly two tables (policy + eligibility) — users/payroll_contract_versions/attendance_records are no longer re-fetched here", () => {
  assert.equal((mealAllowanceServer.match(/supabaseServer\s*\n?\s*\.from\(/g) ?? []).length, 2);
  assert.match(mealAllowanceServer, /\.from\("payroll_meal_allowance_policy_versions"\)/);
  assert.match(mealAllowanceServer, /\.from\("payroll_meal_allowance_eligibility_versions"\)/);
  assert.doesNotMatch(mealAllowanceServer, /\.from\("users"\)/);
  assert.doesNotMatch(mealAllowanceServer, /\.from\("payroll_contract_versions"\)/);
  assert.doesNotMatch(mealAllowanceServer, /\.from\("attendance_records"\)/);
});

test("loadMealAllowanceCostSummary: eligibility is read once, with no candidate-user_id prefilter — the old 'fetch user_id list, then fetch details for those ids' two-step is gone", () => {
  const eligibilityQuery = mealAllowanceServer.slice(
    mealAllowanceServer.indexOf('.from("payroll_meal_allowance_eligibility_versions")'),
  );
  const nextClauseBreak = eligibilityQuery.indexOf("]);");
  const queryChain = eligibilityQuery.slice(0, nextClauseBreak);
  assert.doesNotMatch(queryChain, /\.in\("user_id"/);
  assert.match(queryChain, /\.lt\("effective_from", monthEndExclusive\)/);
  // Only one .select( immediately following the eligibility .from( — proves there is no second detail query.
  assert.equal((mealAllowanceServer.match(/\.from\("payroll_meal_allowance_eligibility_versions"\)/g) ?? []).length, 1);
});

test("loadMealAllowanceCostSummary: policy and eligibility are fetched in parallel (Promise.all), not sequentially", () => {
  assert.match(mealAllowanceServer, /await Promise\.all\(\[/);
  const fromPromiseAll = mealAllowanceServer.slice(mealAllowanceServer.indexOf("await Promise.all(["));
  const parallelBlock = fromPromiseAll.slice(0, fromPromiseAll.indexOf("]);") + 3);
  assert.match(parallelBlock, /payroll_meal_allowance_policy_versions/);
  assert.match(parallelBlock, /payroll_meal_allowance_eligibility_versions/);
});

test("loadMealAllowanceCostSummary: eligibleUserIds is computed from payrollUserIds before either early return, so a missing policy never hides the badge (badge and cost stay independently correct)", () => {
  const fn = mealAllowanceServer.slice(mealAllowanceServer.indexOf("export async function loadMealAllowanceCostSummary"));
  const eligibleUserIdsIndex = fn.indexOf("const eligibleUserIds");
  const policyMissingReturnIndex = fn.indexOf("if (policyMissing) {");
  assert.ok(eligibleUserIdsIndex > -1 && policyMissingReturnIndex > -1);
  assert.ok(eligibleUserIdsIndex < policyMissingReturnIndex, "eligibleUserIds must be computed before the policyMissing early return");
  assert.match(fn, /if \(policyMissing\) \{\s*\n\s*return \{ currentAmount: 0, projectedAmount: 0, policyMissing: true, eligibleUserIds \};/);
});

test("loadMealAllowanceCostSummary: reuses the shared pure resolver (selectMealAllowanceEligibilityDuringMonth) for the badge instead of re-deriving latest-version logic", () => {
  assert.match(mealAllowanceServer, /import\s*\{[\s\S]*selectMealAllowanceEligibilityDuringMonth[\s\S]*\}\s*from "@\/lib\/payroll\/meal-allowance"/);
});

test("loadMealAllowanceCostSummary: stays decoupled from meal-allowance-eligibility-server.ts — it builds its own eligibility map from the single query above, it does not call the /admin/users-facing helper", () => {
  assert.doesNotMatch(mealAllowanceServer, /meal-allowance-eligibility-server/);
});

test("loadMealAllowanceCostSummary: contract/attendance reuse applies only an in-memory candidate/check_in_at filter — no re-derivation of the [monthStart, monthEndExclusive] window that loadPayrollMonthSnapshot() already applied", () => {
  assert.match(mealAllowanceServer, /if \(!candidateSet\.has\(contract\.userId\)\) continue;/);
  assert.match(mealAllowanceServer, /row\.check_in_at !== null && candidateSet\.has\(Number\(row\.user_id\)\)/);
});

// ---------------------------------------------------------------------------
// app/api/admin/payroll/overview/route.ts — single combined call, snapshot context passthrough
// ---------------------------------------------------------------------------

test("overview route: passes the already-loaded snapshot context (users/contracts/attendance) into loadMealAllowanceCostSummary instead of letting it re-query", () => {
  const callSite = overviewRoute.slice(overviewRoute.indexOf("const mealAllowance=await loadMealAllowanceCostSummary("));
  const callBody = callSite.slice(0, callSite.indexOf("});") + 3);
  assert.match(callBody, /calculationEndDate:overview\.period\.calculationEndDate,/);
  assert.match(callBody, /users:overview\.snapshot\.context\.users,/);
  assert.match(callBody, /contracts:overview\.snapshot\.context\.contracts,/);
  assert.match(callBody, /attendance:overview\.snapshot\.context\.attendance,/);
  assert.match(callBody, /payrollUserIds:overview\.employees\.map\(employee=>employee\.userId\),/);
});

test("overview route: no longer imports the eligibility-server module — the badge is produced by the single combined call", () => {
  assert.doesNotMatch(overviewRoute, /meal-allowance-eligibility-server/);
});

test("scope discipline: /admin/payroll/[runId] (payment run detail) is untouched — it still calls loadMealAllowanceEligibilityDuringMonth independently, proving this optimization is scoped to the overview route only", () => {
  assert.match(runRoute, /import \{loadMealAllowanceEligibilityDuringMonth\} from "@\/lib\/payroll\/meal-allowance-eligibility-server";/);
  assert.match(runRoute, /loadMealAllowanceEligibilityDuringMonth\(\(employees\?\?\[\]\)\.map\(employee=>Number\(employee\.user_id\)\),String\(run\.payroll_month\)\.slice\(0,7\)\)/);
});

test("scope discipline: loadPayrollOverview() itself still never mentions meal allowance — the feature stays attached only at the overview route level (per instruction E)", () => {
  const overviewServer = read("lib/payroll/overview-server.ts");
  assert.doesNotMatch(overviewServer, /mealAllowance/i);
  assert.doesNotMatch(overviewServer, /meal-allowance/i);
});
