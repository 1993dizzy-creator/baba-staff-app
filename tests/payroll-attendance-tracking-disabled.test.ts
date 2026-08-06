import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { calculateFixedMonthlyPayroll } from "../lib/payroll/fixed-monthly.ts";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { isMissingAttendanceCandidateDate } from "../lib/payroll/missing-attendance.ts";
import type { PayrollContract } from "../lib/payroll/types";
import type { EmployeeLevelInfo } from "../lib/employee-level/types";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// monthly-run.ts는 "server-only"를 import하므로(Next.js 서버 전용) node --test로 직접
// 실행할 수 없다 — 이 저장소의 기존 관례(payroll-overview-policy.test.ts 등)와 동일하게
// 소스 검증으로 근태 미사용 fixed_monthly 분기가 근태/schedule 없이도 계산되고 어떤
// blocking review도 만들지 않는지 확인한다.
const monthlyRun = read("lib/payroll/monthly-run.ts");

function fixedMonthlyContract(): PayrollContract {
  return {
    id: 1,
    userId: 501,
    payType: "monthly",
    calculationBasis: "fixed_monthly",
    baseSalary: 8_000_000,
    fixedRaiseAmount: 0,
    standardWorkdays: 26,
    standardMinutesPerDay: 540,
    timeBlockMinutes: 60,
    roundingMode: "floor",
    lateAdjustmentMode: "separate",
    earlyLeaveAdjustmentMode: "separate",
    overtimeMode: "requires_approval",
    paidLeaveMode: "manual_review",
    effectiveFrom: "2026-08-01",
    effectiveTo: null,
    revision: 1,
  };
}

const disabledLevel: EmployeeLevelInfo = {
  eligible: false,
  reason: "PROGRAM_DISABLED",
  level: null,
  displayLabel: null,
  baseDate: null,
  baseDateSource: null,
  calculationDate: null,
  completedQuarterCount: 0,
  earnedRaiseCount: 0,
  raiseAmountPerStep: 0,
  cumulativeRaiseAmount: 0,
  nextLevelDate: null,
  negotiationEligibleAt: null,
  negotiationEligible: false,
};

test("calculateFixedMonthlyPayroll pays the full contract amount without any attendance or schedule input", () => {
  // 함수 시그니처 자체가 attendanceRecord/schedule을 받지 않는다 — 근태 기록이 0건이고
  // employee_work_schedule_versions가 아예 없어도 계산 가능함을 구조적으로 보장한다.
  const result = calculateFixedMonthlyPayroll(fixedMonthlyContract(), disabledLevel, "2026-08-31");
  assert.ok(result);
  assert.equal(result!.amount, 8_000_000);
});

test("calculateFixedMonthlyPayroll never prorates for mid-month coverage (no automatic day-based split)", () => {
  const early = calculateFixedMonthlyPayroll(fixedMonthlyContract(), disabledLevel, "2026-08-05");
  const late = calculateFixedMonthlyPayroll(fixedMonthlyContract(), disabledLevel, "2026-08-25");
  assert.equal(early!.amount, late!.amount);
  assert.equal(early!.amount, 8_000_000);
});

test("isMissingAttendanceCandidateDate never flags a date with no active schedule, regardless of other inputs", () => {
  // 근태 미사용 직원은 schedule을 만들지 않으므로 hasActiveSchedule=false 상태가 유지된다.
  assert.equal(
    isMissingAttendanceCandidateDate({
      date: "2026-08-05",
      hireDate: "2026-08-01",
      terminationDate: null,
      calculationEndDate: "2026-08-31",
      hasActiveSchedule: false,
      hasAttendanceRecord: false,
    }),
    false
  );
});

test("monthly-run resolves the fixed_monthly branch before the per-day attendance loop and returns early", () => {
  const fixedBranchIndex = monthlyRun.indexOf('calculationBasis==="fixed_monthly"');
  const dayLoopIndex = monthlyRun.indexOf("for(const date of eligibleDates)");
  assert.ok(fixedBranchIndex >= 0, "fixed_monthly branch must exist");
  assert.ok(dayLoopIndex >= 0, "per-day attendance loop must exist");
  assert.ok(
    fixedBranchIndex < dayLoopIndex,
    "fixed_monthly must be resolved and returned before the day-by-day attendance loop runs"
  );
});

test("the fixed_monthly branch never pushes MISSING_CHECK_IN/MISSING_CHECK_OUT reviews", () => {
  const fixedBranchStart = monthlyRun.indexOf('calculationBasis==="fixed_monthly"');
  const fixedBranchEnd = monthlyRun.indexOf("for(const date of eligibleDates)");
  const fixedBranchSource = monthlyRun.slice(fixedBranchStart, fixedBranchEnd);
  assert.doesNotMatch(fixedBranchSource, /MISSING_CHECK_IN/);
  assert.doesNotMatch(fixedBranchSource, /MISSING_CHECK_OUT/);
});

test("payroll candidate selection does not reference attendance_tracking_enabled (flag never excludes payroll)", () => {
  const selectFnStart = monthlyRun.indexOf("export function selectPayrollUsers");
  const selectFnEnd = monthlyRun.indexOf("export function calculatePayrollBatch");
  const selectFnSource = monthlyRun.slice(selectFnStart, selectFnEnd);
  assert.ok(selectFnStart >= 0 && selectFnEnd > selectFnStart);
  assert.doesNotMatch(selectFnSource, /attendance_tracking_enabled/);
});

test("eligibility.ts payroll-candidate functions (isPayrollEligible/isPayrollUserCandidate — 급여 대상자 포함 여부) are untouched by the attendance-tracking flag", () => {
  // "급여 대상자로 포함되는가"(isPayrollEligible/isPayrollUserCandidate)와 "그 사람 계약에
  // 근무시간이 필요한가"(requiresFixedMonthlyContract, 급여설정에서 근태 미사용 직원의 월
  // 고정급 계약을 지원하기 위해 신설)는 서로 다른 질문이다. requiresFixedMonthlyContract는
  // attendance_tracking_enabled를 의도적으로 참조하지만, 급여 대상자 포함 여부 판정
  // 함수 두 개는 이 플래그와 여전히 무관해야 한다 — 이 테스트는 그 두 함수만 정밀하게
  // 검사한다(파일 전체 텍스트가 아니라).
  const eligibility = read("lib/payroll/eligibility.ts");
  const isPayrollEligibleStart = eligibility.indexOf("export function isPayrollEligible(");
  const isPayrollUserCandidateStart = eligibility.indexOf("export function isPayrollUserCandidate(");
  assert.ok(isPayrollEligibleStart > -1 && isPayrollUserCandidateStart > isPayrollEligibleStart);
  const isPayrollEligibleBody = eligibility.slice(isPayrollEligibleStart, isPayrollUserCandidateStart);
  const isPayrollUserCandidateBody = eligibility.slice(isPayrollUserCandidateStart);
  assert.doesNotMatch(isPayrollEligibleBody, /attendance_tracking_enabled/);
  assert.doesNotMatch(isPayrollUserCandidateBody, /attendance_tracking_enabled/);
});

test("requiresFixedMonthlyContract (근태 미사용 직원의 월 고정급 계약 판정) is a separate, new function that legitimately references attendance tracking — it is not isPayrollEligible/isPayrollUserCandidate and does not change their behavior", () => {
  const eligibility = read("lib/payroll/eligibility.ts");
  assert.match(eligibility, /export function requiresFixedMonthlyContract\(/);
  assert.match(eligibility, /isPayrollOwnerRole\(role\) \|\| attendanceTrackingEnabled === false/);
  // 세 함수가 서로 다른 함수로 명확히 분리돼 있어야 한다(하나로 합쳐지지 않음).
  assert.match(eligibility, /export function isPayrollEligible\(/);
  assert.match(eligibility, /export function isPayrollUserCandidate\(/);
});
