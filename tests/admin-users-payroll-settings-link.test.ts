import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/users/page.tsx");
const text = read("lib/text/admin-users.ts");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");

test("employee detail: attendance lives in work·pay, app login in app access, is_active and payroll exception in collapsed advanced", () => {
  const work = page.indexOf("<strong>{text.workPayInfo}</strong>");
  const access = page.indexOf("<strong>{text.appAccess}</strong>");
  const advanced = page.indexOf("{text.advancedSettings}</summary>");
  assert.ok(work > 0 && access > work && advanced > access);
  assert.ok(page.indexOf('label={text.attendanceTracking}') > work && page.indexOf('label={text.attendanceTracking}') < access);
  assert.ok(page.indexOf('label={text.appLoginAllowed}') > access && page.indexOf('label={text.appLoginAllowed}') < advanced);
  assert.ok(page.lastIndexOf('label={text.payrollEligibleOverride}') > advanced);
  assert.doesNotMatch(page, /<details[^>]*\bopen\b[^>]*style=\{styles\.advancedSection\}/, "advanced is collapsed by default");
  assert.doesNotMatch(page, /text\.usageSettings|text\.activeStatus/, "ambiguous 계정 사용 가능 label removed from the detail UI");
});

test("is_active editing is preserved and not merged with termination", () => {
  // Advanced toggle edits is_active only; termination date is never filled in automatically.
  assert.match(page, /label=\{text\.employeeActiveToggle\} checked=\{!draft\.termination_date && draft\.is_active !== false\} disabled=\{Boolean\(draft\.termination_date\)\} onChange=\{value => update\("is_active", value\)\}/);
  // Clearing a terminated employee's date surfaces the toggle for the existing cancel_termination flow.
  assert.match(page, /const cancellingTermination = !isMasterUser && Boolean\(user\.termination_date\) && !draft\.termination_date;/);
  assert.match(page, /original\.termination_date[\s\S]*draft\.termination_date === null[\s\S]*draft\.is_active !== false[\s\S]*"cancel_termination"/);
  assert.match(page, /is_active: draft\.is_active !== false,\s*attendance_tracking_enabled: draft\.attendance_tracking_enabled !== false,\s*app_login_enabled: draft\.app_login_enabled !== false,/);
});

test("current payroll contract is read per employee only when the detail is open, and re-read on return", () => {
  assert.equal((page.match(/\/api\/admin\/payroll\/contracts\?userId=/g) ?? []).length, 1);
  assert.match(page, /function PayrollContractStatus[\s\S]*useCurrentPayrollContract\(user\.id\)/);
  // Rendered only inside the edit fieldset, never in the list rows.
  assert.ok(page.indexOf("<PayrollContractStatus") > page.indexOf("{isEditing ? ("));
  assert.match(page, /document\.addEventListener\("visibilitychange", refresh\)/);
  assert.match(page, /window\.addEventListener\("pageshow", restored\)/);
  // Read failure and "no contract" are different states.
  assert.match(page, /state\.status === "error" \?[\s\S]*text\.payrollContractLoadFailed/);
  assert.match(page, /current \? payrollContractLabel\(current, text\) : text\.payrollContractNone/);
});

test("contract/attendance mismatch reuses the payroll policy and only warns", () => {
  assert.match(page, /requiresFixedMonthlyContract\(draft\.role, draft\.attendance_tracking_enabled !== false\) !== \(current\.calculationBasis === "fixed_monthly"\)/);
  assert.match(page, /\{mismatch \? <span role="status" style=\{styles\.fieldNotice\}>\{text\.payrollContractMismatch\}<\/span> : null\}/);
  assert.doesNotMatch(page, /fetch\([^)]*\/api\/admin\/payroll\/contracts[^)]*method/, "no contract writes from the employee page");
});

test("payroll settings shortcut opens the existing employee tab with the same eligibility as its employee list", () => {
  assert.match(page, /router\.push\(`\/admin\/payroll\/settings\?tab=employee&userId=\$\{encodeURIComponent\(String\(user\.id\)\)\}`\)/);
  assert.match(page, /user\.is_active === true && !user\.termination_date && isPayrollEligible\(user\)/);
  assert.match(page, /hasUnsavedChanges\(\) && !window\.confirm\(text\.unsavedLeaveConfirm\)/);
  assert.match(settings, /const requestedUserIdParam = params\.get\("userId"\)/);
  assert.match(settings, /users\.some\(\(user\) => user\.id === requested\)/);
});

test("new labels exist in KO and VI", () => {
  for (const key of ["workPayInfo", "employmentStatus", "appAccess", "appLoginAllowed", "advancedSettings", "employeeActiveToggle", "payrollException", "payrollContractCurrent", "payrollContractNone", "payrollContractLoadFailed", "payrollContractMismatch", "managePayrollSettings", "unsavedLeaveConfirm"]) {
    assert.equal((text.match(new RegExp(`\\b${key}:`, "g")) ?? []).length, 2, key);
  }
  assert.match(text, /근태 설정과 현재 급여계약이 다릅니다\. 급여설정에서 계약을 확인해야 합니다\./);
});
