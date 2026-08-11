import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(join(process.cwd(), "components/payroll/EmployeeAttendanceBonusSettings.tsx"), "utf8");

test("employee attendance bonus matches the meal card header and edit flow", () => {
  assert.match(source, /<div style=\{s\.head\}>/);
  assert.match(source, /월말 근태 판정 조건을 충족하면 자동 인센티브가 계산됩니다/);
  assert.match(source, /setFormOpen\(true\)/);
  assert.match(source, /설정 변경/);
  assert.match(source, /취소/);
});

test("employee attendance bonus summary exposes status, month, policy, criteria and monthly standing", () => {
  for (const label of ["현재 상태", "적용월", "보너스 금액", "판정 기준", "이번 달 상태"]) {
    assert.match(source, new RegExp(`"${label}"`));
  }
  assert.match(source, /공통 정책 미설정/);
  assert.match(source, /minimumActualWorkdays/);
  assert.match(source, /allowedLateCount/);
  assert.match(source, /allowedEarlyLeaveCount/);
  assert.doesNotMatch(source, /예상 보너스|Thưởng dự kiến/);
  assert.doesNotMatch(source, /미대상[^\n]*·[^\n]*-/);
});

test("employee attendance bonus loads eligibility, common policy and the batch monthly summary together without changing the save API", () => {
  assert.match(source, /const \[eligibilityResponse, policyResponse, summaryResponse\] = await Promise\.all\(\[/);
  assert.match(source, /fetch\(`\/api\/admin\/payroll\/attendance-bonus\/eligibility\?userId=\$\{userId\}`/);
  assert.match(source, /fetch\("\/api\/admin\/payroll\/attendance-bonus\/policy"/);
  assert.match(source, /fetch\(`\/api\/attendance\/monthly-summary\?month=\$\{payrollMonth\}`/);
  assert.match(source, /fetch\("\/api\/admin\/payroll\/attendance-bonus\/eligibility", \{/);
  assert.match(source, /body: JSON\.stringify\(\{ userId, isEligible, effectiveMonth, note \}\)/);
});

test("employee attendance bonus form and history reuse responsive meal-card patterns", () => {
  assert.match(source, /gridTemplateColumns: "repeat\(auto-fit, minmax\(130px, 1fr\)\)"/);
  assert.match(source, /gridTemplateColumns: "repeat\(auto-fit, minmax\(180px, 1fr\)\)"/);
  assert.match(source, /<textarea style=\{s\.textarea\}/);
  assert.match(source, /<details style=\{s\.details\}>/);
  assert.match(source, /설정 이력 \$\{state\.history\.length\}건/);
});

test("attendance-tracking protection and eligibility version fields remain intact", () => {
  assert.match(source, /ATTENDANCE_BONUS_REQUIRES_ATTENDANCE_TRACKING/);
  assert.match(source, /disabled=\{disabledByAttendanceTracking/);
  assert.match(source, /item\.effectiveMonth/);
  assert.match(source, /item\.revision/);
  assert.match(source, /item\.note/);
});
