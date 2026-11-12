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
  // Section headers carry an emoji via SectionTitle (2026-11 UI cleanup).
  const work = page.indexOf('<SectionTitle emoji="⏰">{text.workPayInfo}</SectionTitle>');
  const access = page.indexOf('<SectionTitle emoji="🔐">{text.appAccess}</SectionTitle>');
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

test("2차: the employee page mounts at most one payroll·benefits panel (now in a dedicated sheet), only for payroll-manageable employees", () => {
  assert.match(page, /const payrollOpen = isEditing && payroll\.openUserId === String\(user\.id\);/);
  // The card keeps a short summary + "관리"; the shared panel mounts only inside the open sheet.
  assert.match(page, /\{open && typeof document !== "undefined" \? \(\s*<PayrollSheet[\s\S]*?<EmployeePayrollSettingsPanel/);
  assert.match(page, /\{canManageUserPayroll\(user\) \? \(\s*<PayrollBenefitsSection/);
  assert.match(page, /showIdentity=\{false\}/);
  assert.match(page, /anchorPrefix=\{`user-\$\{user\.id\}-`\}/);
  // One contract read is shared by the work·pay summary line and the sheet's panel (C: no shortcut button there).
  assert.match(page, /<PayrollContractStatus user=\{user\} draft=\{draft\} text=\{text\} contracts=\{contracts\} \/>/);
  assert.match(page, /contracts=\{contracts\}[\s\S]*contracts=\{contracts\}/);
});

test("2차: two-way navigation keeps the selected employee and confirms before discarding unsaved edits", () => {
  assert.match(settings, /router\.push\(`\/admin\/users\?userId=\$\{id\}&section=payroll`\)/);
  // P0: both exits go through confirmLeave(), which asks only when the panel has unsaved input or a pending save.
  assert.match(settings, /function openEmployeeManagement\(id: number\) \{\n    if \(!confirmLeave\(\)\) return;/);
  // 즉시성: 이탈 확인은 패널이 알린 최신 값(ref)으로 만든 문구를 쓴다.
  assert.match(settings, /const latestLeaveMessage = \(\) => payrollLeaveMessage\(panelUnsavedRef\.current, vi\);/);
  assert.match(settings, /const confirmLeave = \(\) => \{\n    const message = latestLeaveMessage\(\);\n    return message === null \|\| window\.confirm\(message\);\n  \};/);
  assert.match(page, /router\.replace\(`\/admin\/users\?userId=\$\{encodeURIComponent\(String\(user\.id\)\)\}&section=\$\{payrollOpen \? "payroll" : "detail"\}`, \{ scroll: false \}\);/);
  assert.match(page, /const \[isEditing, setIsEditing\] = useState\(initialFocus !== null\);/);
  assert.match(page, /search\.get\("section"\) === "payroll" \? "payroll" : "detail"/);
  // P0: an open-but-unchanged form is no longer "unsaved"; pending verification is reported separately.
  assert.match(panel, /const pendingVerification = pendingContractSave !== null;/);
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
  // Unsaved employee edits (and, since P0, payroll input/pending saves) are confirmed before leaving.
  assert.match(page, /const message = leaveMessage\(\);\n    if \(message && !window\.confirm\(message\)\) return;/);
  assert.match(page, /return payrollMessage \?\? \(draftChanged \? text\.unsavedLeaveConfirm : null\);/);
  assert.match(settings, /const requestedUserIdParam = params\.get\("userId"\)/);
  assert.match(settings, /users\.some\(\(user\) => user\.id === requested\)/);
});

test("new labels exist in KO and VI", () => {
  for (const key of ["workPayInfo", "employmentStatus", "appAccess", "appLoginAllowed", "advancedSettings", "employeeActiveToggle", "payrollException", "payrollContractCurrent", "payrollContractNone", "payrollContractLoadFailed", "payrollContractMismatch", "managePayrollSettings", "unsavedLeaveConfirm"]) {
    assert.equal((text.match(new RegExp(`\\b${key}:`, "g")) ?? []).length, 2, key);
  }
  assert.match(text, /근태 설정과 현재 급여계약이 다릅니다\. 급여설정에서 계약을 확인해야 합니다\./);
});

test("P0: each payroll setting card reports real unsaved input against the same baseline its form resets to", () => {
  for (const [file, baseline] of [
    ["EmployeeMealAllowanceSettings", "mealFormBaseline"],
    ["EmployeeAttendanceBonusSettings", "bonusFormBaseline"],
    ["EmployeeInsuranceSettings", "insuranceFormBaseline"],
    ["EmployeeTaxSettings", "taxFormBaseline"],
  ] as const) {
    const source = read(`components/payroll/${file}.tsx`);
    assert.ok(source.includes(`const baseline = ${baseline}(`), `${file}: resetForm uses the baseline`);
    assert.match(source, new RegExp(`useReportDirty\\(formOpen && \\(saving \\|\\| formValuesChanged\\(\\{[^}]+\\}, ${baseline}\\(`), `${file}: dirty = open && (saving || changed)`);
    assert.match(source, /onDirtyChange\?: \(dirty: boolean\) => void/, file);
  }
  const report = read("components/payroll/useReportDirty.ts");
  assert.match(report, /useLayoutEffect\(\(\) => \(\) => \{ reportRef\.current\?\.\(false\); \}, \[\]\);/, "unmount clears the flag");
  // 즉시성: 입력 이벤트로 생긴 렌더의 커밋 단계에서 바로 알린다(passive effect를 기다리지 않음).
  assert.match(report, /useLayoutEffect\(\(\) => \{ reportRef\.current\?\.\(dirty\); \}, \[dirty\]\);/);
  assert.doesNotMatch(report, /useEffect/);
});

test("P0: the shared panel separates unsaved input from an unconfirmed contract save and keeps the latter per employee", () => {
  assert.match(panel, /const contractInputDirty = open && \(saving \|\| JSON\.stringify\(form\) !== formBaseline \|\| correctionReason\.trim\(\) !== ""\);/);
  for (const key of ["insurance", "tax", "meal", "bonus"]) assert.match(panel, new RegExp(`onDirtyChange=\\{cardDirtyReporters\\.${key}\\}`), key);
  // 즉시성: 카드 보고와 계약 상태를 ref로 모아 바뀌는 즉시 상위에 알리고, 언마운트 후의 늦은 보고는 끊는다.
  assert.match(panel, /input: contractUnsavedRef\.current\.input \|\| Object\.values\(cardDirtyRef\.current\)\.some\(Boolean\),\n\s+pendingVerification: contractUnsavedRef\.current\.pendingVerification,/);
  assert.match(panel, /cardDirtyRef\.current\[key\] = dirty;\n\s+reportUnsaved\(\);/);
  assert.match(panel, /useLayoutEffect\(\(\) => \{\n\s+contractUnsavedRef\.current = \{ input: contractInputDirty, pendingVerification \};\n\s+reportUnsaved\(\);/);
  assert.match(panel, /onUnsavedChangeRef\.current = undefined;\n\s+onUnsavedChange\?\.\(NO_PAYROLL_UNSAVED\);/);
  assert.match(panel, /useState<SubmittedContractSave \| null>\(\(\) => \(typeof window === "undefined" \? null : readPendingContractSave\(user\.id\)\)\)/);
  assert.match(panel, /writePendingContractSave\(user\.id, submitted\);/);
  // Existing duplicate-save protection is unchanged.
  assert.match(panel, /if \(pendingContractSave\) return;\n    const correcting/);
  assert.match(panel, /function openForm\(\) \{\n    if \(pendingContractSave\) return;/);
});

test("P0: both pages confirm before discarding payroll input, and guard reload/close and menu links without touching history", () => {
  const unsaved = read("components/payroll/payrollUnsaved.ts");
  assert.match(unsaved, /window\.addEventListener\("beforeunload", beforeUnload\)/);
  assert.match(unsaved, /document\.addEventListener\("click", linkClick, true\)/);
  assert.doesNotMatch(unsaved, /history\.(pushState|replaceState|go|back)/);
  for (const source of [page, settings]) assert.match(source, /useLeaveGuard\(/);
  assert.match(settings, /if \(tab !== activeTab && !confirmLeave\(\)\) return;/);
  assert.match(settings, /if \(id !== userId && !confirmLeave\(\)\) return;/);
  assert.match(page, /const message = closesOpenPanel \? latestPayrollLeave\(\) : null;\n\s+if \(message && !window\.confirm\(message\)\) return false;/);
  // 즉시성: 두 화면 모두 최신 값(ref)을 읽고, 새로고침·메뉴 링크 가드도 이벤트 시점의 최신 문구를 쓴다.
  assert.match(page, /payrollUnsavedRef\.current = state;\n\s+setPayrollUnsavedState\(state\);/);
  assert.match(settings, /panelUnsavedRef\.current = state;\n\s+setPanelUnsavedState\(state\);/);
  assert.match(page, /useLeaveGuard\(payrollLeave, latestPayrollLeave\);/);
  assert.match(settings, /useLeaveGuard\(leaveMessage, latestLeaveMessage\);/);
  assert.match(unsaved, /const currentMessage = \(\) => \(latestRef\.current \? latestRef\.current\(\) : messageRef\.current\);/);
  assert.match(unsaved, /const beforeUnload = \(event: BeforeUnloadEvent\) => \{\n\s+if \(!currentMessage\(\)\) return;/);
  assert.match(page, /if \(payrollOpen && !payroll\.setOpen\(user\.id, false\)\) return;/);
  assert.match(page, /if \(payrollOpen && hasPayrollUnsaved\(payroll\.unsaved\(\)\)\) return;/);
});
