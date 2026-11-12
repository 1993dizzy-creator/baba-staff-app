import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/users/page.tsx");
const text = read("lib/text/admin-users.ts");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
const panel = read("components/payroll/EmployeePayrollSettingsPanel.tsx");
const hook = read("components/payroll/usePayrollContracts.ts");

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
  // 2차: the employee page no longer fetches contracts itself; the card owns one shared hook instance.
  assert.equal((page.match(/\/api\/admin\/payroll\/contracts\?userId=/g) ?? []).length, 0);
  assert.equal((hook.match(/fetch\(`\/api\/admin\/payroll\/contracts\?userId=/g) ?? []).length, 1);
  assert.match(page, /const contracts = usePayrollContracts\(isEditing \? Number\(user\.id\) : null, \{ refreshOnReturn: true \}\);/);
  assert.match(hook, /if \(!refreshOnReturn \|\| !userId\) return;/);
  assert.match(hook, /document\.addEventListener\("visibilitychange", refresh\)/);
  assert.match(hook, /window\.addEventListener\("pageshow", restored\)/);
  // Read failure and "no contract" are different states.
  assert.match(page, /contracts\.loadFailed \? <span style=\{styles\.contractError\}>\{text\.payrollContractLoadFailed\}/);
  assert.match(page, /current \? payrollContractLabel\(current, text\) : text\.payrollContractNone/);
});

test("2차: both screens mount the same EmployeePayrollSettingsPanel; the contract editor exists only in the shared panel", () => {
  for (const source of [page, settings]) {
    assert.match(source, /import EmployeePayrollSettingsPanel/);
    assert.match(source, /<EmployeePayrollSettingsPanel/);
    assert.doesNotMatch(source, /\/api\/admin\/payroll\/contracts\/correct|function verifyContractSave|contractSaveApplied|<EmployeeInsuranceSettings|<EmployeeTaxSettings|<EmployeeMealAllowanceSettings|<EmployeeAttendanceBonusSettings/);
  }
  assert.match(panel, /fetch\(correcting \? "\/api\/admin\/payroll\/contracts\/correct" : "\/api\/admin\/payroll\/contracts"/);
  assert.match(panel, /if \(contractSaveApplied\(history, submitted\)\)/);
  assert.match(panel, /setPendingContractSave\(submitted\)/);
  assert.match(panel, /if \(pendingContractSave\) return;\n    const correcting/);
  for (const component of ["EmployeeInsuranceSettings", "EmployeeTaxSettings", "EmployeeMealAllowanceSettings", "EmployeeAttendanceBonusSettings"]) {
    assert.match(panel, new RegExp(`<${component}\\s+key=\\{\`[a-z-]+-\\$\\{selected\\.id\\}\`\\}`), component);
  }
  // The settings page keys the panel per employee so inputs/errors/pending saves never carry over.
  assert.match(settings, /<EmployeePayrollSettingsPanel\s+key=\{selected\.id\}/);
  assert.match(settings, /const contractsSource = usePayrollContracts\(activeTab === "employee" \? userId : null\);/);
});

test("2차: the employee page mounts at most one collapsed payroll·benefits panel, only for payroll-manageable employees", () => {
  assert.match(page, /const payrollOpen = isEditing && payroll\.openUserId === String\(user\.id\);/);
  assert.match(page, /\{open \? <div id=\{panelId\} style=\{styles\.payrollPanel\}>\s*<EmployeePayrollSettingsPanel/);
  assert.match(page, /\{canManageUserPayroll\(user\) \? \(\s*<PayrollBenefitsSection/);
  assert.match(page, /showIdentity=\{false\}/);
  assert.match(page, /anchorPrefix=\{`user-\$\{user\.id\}-`\}/);
  // One contract read is shared: the one-line summary hides while the panel shows the same contract.
  assert.match(page, /showSummary=\{!\(payrollOpen && canManageUserPayroll\(user\)\)\}/);
  assert.match(page, /contracts=\{contracts\}[\s\S]*contracts=\{contracts\}/);
});

test("2차: two-way navigation keeps the selected employee and confirms before discarding unsaved edits", () => {
  assert.match(settings, /router\.push\(`\/admin\/users\?userId=\$\{id\}&section=payroll`\)/);
  assert.match(settings, /if \(panelUnsaved && !window\.confirm\(leaveConfirmMessage\)\) return;/);
  assert.match(settings, /if \(id !== userId && panelUnsaved && !window\.confirm\(leaveConfirmMessage\)\) return;/);
  assert.match(page, /router\.replace\(`\/admin\/users\?userId=\$\{encodeURIComponent\(String\(user\.id\)\)\}&section=\$\{payrollOpen \? "payroll" : "detail"\}`, \{ scroll: false \}\);/);
  assert.match(page, /const \[isEditing, setIsEditing\] = useState\(initialFocus !== null\);/);
  assert.match(page, /search\.get\("section"\) === "payroll" \? "payroll" : "detail"/);
  assert.match(panel, /const unsaved = open \|\| pendingContractSave !== null;/);
  // Existing settings URLs keep working (no redirect away from the employee tab).
  assert.doesNotMatch(settings, /redirect\(|router\.replace\(`\/admin\/users/);
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
