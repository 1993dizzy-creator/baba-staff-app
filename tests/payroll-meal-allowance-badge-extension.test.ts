import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { selectMealAllowanceEligibilityDuringMonth } from "../lib/payroll/meal-allowance.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const overviewRoute = read("app/api/admin/payroll/overview/route.ts");
const runRoute = read("app/api/admin/payroll/runs/[runId]/route.ts");
const payrollPage = read("app/(protected)/admin/payroll/page.tsx");
const runPage = read("app/(protected)/admin/payroll/[runId]/page.tsx");
const compensationCard = read("components/payroll/CompensationCard.tsx");
const usersText = read("lib/text/admin-users.ts");
const settingsPage = read("app/(protected)/admin/payroll/settings/page.tsx");
const attendancePage = read("app/(protected)/admin/payroll/attendance/page.tsx");
const attendanceUserPage = read("app/(protected)/admin/payroll/attendance/[userId]/page.tsx");

// ---------------------------------------------------------------------------
// selectMealAllowanceEligibilityDuringMonth(순수 함수) — 급여월 기준 판정.
// 요청 시나리오: 8월 대상 → 10월부터 제외 / 8월 비대상 → 10월부터 대상, 어느 쪽이든
// 8월 급여장부를 나중에(10월에) 다시 열어봐도 8월 시점 상태가 그대로 유지되어야 한다.
// ---------------------------------------------------------------------------

test("month-based eligibility: 8월 내내 대상이었다면 true", () => {
  const versions = [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 }];
  assert.equal(selectMealAllowanceEligibilityDuringMonth(versions, "2026-08-01", "2026-09-01"), true);
});

test("month-based eligibility: 8월 대상 → 10월부터 제외된 경우, 10월에 8월 run을 다시 봐도 8월은 여전히 true (미래 변경이 과거 월을 바꾸지 않음)", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-10-01", revision: 1 },
  ];
  assert.equal(selectMealAllowanceEligibilityDuringMonth(versions, "2026-08-01", "2026-09-01"), true);
});

test("month-based eligibility: 8월엔 비대상이었다가 10월부터 대상이 된 경우, 8월 run에는 여전히 false (미래에 생긴 대상 전환이 과거 월을 바꾸지 않음)", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-10-01", revision: 1 },
  ];
  assert.equal(selectMealAllowanceEligibilityDuringMonth(versions, "2026-08-01", "2026-09-01"), false);
});

test("month-based eligibility: 버전이 아예 없으면(등록 전) false", () => {
  assert.equal(selectMealAllowanceEligibilityDuringMonth([], "2026-08-01", "2026-09-01"), false);
});

test("month-based eligibility: 월 중간에 대상으로 전환되면(예: 8/15부터) 그 달은 true — 실제 그 기간 식대비용이 발생했으므로", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-07-01", revision: 1 },
    { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-08-15", revision: 1 },
  ];
  assert.equal(selectMealAllowanceEligibilityDuringMonth(versions, "2026-08-01", "2026-09-01"), true);
});

test("month-based eligibility: 월 중간에 대상에서 제외되면(예: 8/15부터 제외) 그 달은 여전히 true — 8/1~8/14는 대상이었으므로", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-08-15", revision: 1 },
  ];
  assert.equal(selectMealAllowanceEligibilityDuringMonth(versions, "2026-08-01", "2026-09-01"), true);
});

test("month-based eligibility: 다음 달 1일(monthEndExclusive) 정각에 시작하는 버전은 그 달에 포함되지 않는다(half-open 경계)", () => {
  const versions = [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-09-01", revision: 1 }];
  assert.equal(selectMealAllowanceEligibilityDuringMonth(versions, "2026-08-01", "2026-09-01"), false);
});

// ---------------------------------------------------------------------------
// /api/admin/payroll/overview — mealAllowanceEligibleUserIds는 employees[]와 완전히 분리된
// 응답 최상위 필드다 (기존 "employees[]에는 식대 데이터를 절대 섞지 않는다" 불변식 유지).
// ---------------------------------------------------------------------------

test("overview route: eligibility is computed inside the same meal-allowance-cost call, not a separate today-scoped judgment path", () => {
  assert.doesNotMatch(overviewRoute, /loadMealAllowanceEligibilityDuringMonth/);
  assert.doesNotMatch(overviewRoute, /loadMealAllowanceEligibilityAt\(/);
  assert.doesNotMatch(overviewRoute, /getVietnamDateKey/);
});

test("overview route: eligibility is bulk-loaded once from snapshot.employees (pre-payment-merge array, sourced via onSnapshotReady) scoped to the *browsed* payroll month, not today — a past/future month browse must never depend on today's date", () => {
  // Phase 2 (meal-allowance early start) moved this to snapshot.employees
  // instead of overview.employees — provably the same userId set (see
  // payroll-overview-meal-allowance-early-start.test.ts) and still entirely
  // derived from the browsed month's snapshot, never from today's date.
  assert.equal((overviewRoute.match(/loadMealAllowanceCostSummary\(/g) ?? []).length, 1);
  assert.match(overviewRoute, /payrollUserIds:snapshot\.employees\.map\(employee=>employee\.userId\),/);
  assert.match(overviewRoute, /const mealAllowanceEligibleUserIds=mealAllowance\.eligibleUserIds;/);
});

test("overview route: mealAllowanceEligibleUserIds is appended as a sibling response field, and the pre-existing employees/summary/projectedSummary substring is untouched (no regression to the payment-separation invariant)", () => {
  const responseCallIndex = overviewRoute.lastIndexOf("payrollJson({ok:true");
  const responseCall = overviewRoute.slice(responseCallIndex);
  assert.match(responseCall, /employees,summary,projectedSummary,mealAllowancePolicyMissing:mealAllowance\.policyMissing,mealAllowanceEligibleUserIds,paymentBatch:run\?\?null/);
});

test("overview route: PayrollOverviewEmployee (lib/payroll/overview.ts) still has no meal allowance field after this extension", () => {
  const overviewType = read("lib/payroll/overview.ts");
  assert.doesNotMatch(overviewType, /mealAllowance/i);
});

// ---------------------------------------------------------------------------
// /admin/payroll 메인 — CompensationCard
// ---------------------------------------------------------------------------

test("CompensationCard: mealAllowanceEligible is an optional prop defaulting to false, and exports a single shared badge-label function", () => {
  assert.match(compensationCard, /mealAllowanceEligible\?: boolean;/);
  assert.match(compensationCard, /mealAllowanceEligible = false,/);
  assert.match(compensationCard, /export function mealAllowanceBadgeLabel\(lang: "ko" \| "vi"\)/);
});

test("CompensationCard: badge renders only when eligible, placed right after the name/level, before the '·'/position text", () => {
  const identityIndex = compensationCard.indexOf("<span style={s.identity}>");
  const nameIndex = compensationCard.indexOf("<EmployeeNameWithLevel", identityIndex);
  const badgeIndex = compensationCard.indexOf("mealAllowanceEligible ? (", identityIndex);
  const separatorIndex = compensationCard.indexOf("s.separator", identityIndex);
  assert.ok(identityIndex > -1 && nameIndex > -1 && badgeIndex > -1 && separatorIndex > -1);
  assert.ok(nameIndex < badgeIndex && badgeIndex < separatorIndex, "badge must sit between the name and the '·' separator");
});

test("CompensationCard: badge carries the bilingual title/aria-label from the shared label function (not a hardcoded duplicate string)", () => {
  assert.match(compensationCard, /title=\{mealAllowanceBadgeLabel\(lang\)\} aria-label=\{mealAllowanceBadgeLabel\(lang\)\}/);
});

test("mealAllowanceBadgeLabel: wording is 대상-neutral (never 지급/nhận), matching the /admin/users wording exactly", () => {
  assert.match(compensationCard, /return lang === "vi" \? "Đối tượng trợ cấp ăn" : "식대 대상";/);
  assert.match(usersText, /mealAllowanceEligibleBadge: "식대 대상"/);
  assert.match(usersText, /mealAllowanceEligibleBadge: "Đối tượng trợ cấp ăn"/);
});

test("payroll main page: month navigation is unrestricted in both directions (moveMonth(-1)/moveMonth(1) with no bound) — confirms this screen is not 'current month only', so the eligibility judgment must be month-scoped rather than today-scoped", () => {
  assert.match(payrollPage, /function moveMonth\(amount:number\)/);
  assert.match(payrollPage, /onClick=\{\(\)=>moveMonth\(-1\)\}/);
  assert.match(payrollPage, /onClick=\{\(\)=>moveMonth\(1\)\}/);
});

test("payroll main page: builds a Set from overview.mealAllowanceEligibleUserIds (client-side membership check, no extra request) and passes membership per employee into CompensationCard", () => {
  assert.match(payrollPage, /mealAllowanceEligibleUserIds:number\[\]/);
  assert.match(payrollPage, /new Set\(overview\?\.mealAllowanceEligibleUserIds\?\?\[\]\)/);
  assert.match(payrollPage, /mealAllowanceEligible=\{mealAllowanceEligibleUserIds\.has\(employee\.userId\)\}/);
});

// ---------------------------------------------------------------------------
// /admin/payroll/[runId] — 실제 지급 관리(급여장부) 화면
// ---------------------------------------------------------------------------

test("run route: eligibility is bulk-loaded once from the payment rows' user_id list, scoped to this run's payroll_month (not today), and the pre-existing payroll_employee_payments select('*') projection is untouched", () => {
  assert.match(runRoute, /import \{loadMealAllowanceEligibilityDuringMonth\} from "@\/lib\/payroll\/meal-allowance-eligibility-server";/);
  assert.doesNotMatch(runRoute, /loadMealAllowanceEligibilityAt\(/);
  assert.doesNotMatch(runRoute, /getVietnamDateKey/);
  assert.equal((runRoute.match(/loadMealAllowanceEligibilityDuringMonth\(/g) ?? []).length, 1);
  assert.match(runRoute, /loadMealAllowanceEligibilityDuringMonth\(\(employees\?\?\[\]\)\.map\(employee=>Number\(employee\.user_id\)\),String\(run\.payroll_month\)\.slice\(0,7\)\)/);
  assert.match(runRoute, /supabaseServer\.from\("payroll_employee_payments"\)\.select\("\*,paid_actor:users!payroll_employee_payments_paid_by_fkey\(name,full_name,username\)"\)/);
});

test("run route: response still returns run/employees/audit unmodified, with mealAllowanceEligibleUserIds only appended alongside them", () => {
  assert.match(runRoute, /payrollJson\(\{ok:true,run,employees:employees\?\?\[\],audit:audit\?\?\[\],mealAllowanceEligibleUserIds\}\)/);
});

test("run page: renders the badge next to employee_name using the same shared label function and a client Set for membership", () => {
  assert.match(runPage, /import \{ mealAllowanceBadgeLabel \} from "@\/components\/payroll\/CompensationCard";/);
  assert.match(runPage, /const mealAllowanceEligibleSet=new Set\(mealAllowanceEligibleUserIds\);/);
  const employeeMapIndex = runPage.indexOf("employees.map(employee=>");
  const nameIndex = runPage.indexOf("employee.employee_name", employeeMapIndex);
  const badgeIndex = runPage.indexOf("mealAllowanceEligibleSet.has(employee.user_id)", employeeMapIndex);
  assert.ok(employeeMapIndex > -1 && nameIndex > -1 && badgeIndex > -1);
  assert.ok(nameIndex < badgeIndex, "badge check must come right after the employee name");
});

test("run page: calculation_snapshot / actual_paid_amount / difference fields remain rendered exactly as before (no payment-data change)", () => {
  assert.match(runPage, /employee\.calculation_snapshot&&<details>/);
  assert.match(runPage, /formatVnd\(employee\.actual_paid_amount\?\?0\)/);
  assert.match(runPage, /formatVnd\(employee\.difference_amount\?\?0\)/);
});

// ---------------------------------------------------------------------------
// 적용 범위 밖 화면 — 식대 설정 화면(중복 방지), 근태 감사 화면(범위 밖)에는 배지를 추가하지 않는다.
// ---------------------------------------------------------------------------

test("scope discipline: the meal-allowance settings screen and attendance-audit screens were not touched by this badge extension", () => {
  assert.doesNotMatch(settingsPage, /mealAllowanceEligible/);
  assert.doesNotMatch(settingsPage, /mealAllowanceBadgeLabel/);
  assert.doesNotMatch(attendancePage, /mealAllowanceEligible/);
  assert.doesNotMatch(attendanceUserPage, /mealAllowanceEligible/);
});
