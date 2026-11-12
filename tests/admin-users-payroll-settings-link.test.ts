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

test("employee detail: attendance and the payroll exception live in work·pay, app login in app access; no advanced card", () => {
  // 2026-11 restructure: three top cards (기본정보 · 근무·급여 · 앱 접근); the 고급 관리 card is gone.
  const work = page.indexOf('<CollapsibleSection tone="workPay" emoji="⏰" title={text.workPayInfo} open={workOpen} onToggle={toggleWork}>');
  const access = page.indexOf('<SectionTitle emoji="🔐">{text.appAccess}</SectionTitle>');
  assert.ok(work > 0 && access > work);
  assert.ok(page.indexOf('label={text.attendanceTracking}') > work && page.indexOf('label={text.attendanceTracking}') < access);
  assert.ok(page.indexOf('label={text.appLoginAllowed}') > access);
  const exception = page.lastIndexOf('label={text.payrollEligibleOverride}');
  assert.ok(exception > work && exception < access, "payroll exception is a small subsection of work·pay");
  assert.match(page, /\{isAdminGroupUser && !user\.is_system_account \? <div style=\{styles\.subsection\}>\n\s+<SubsectionTitle emoji="⚙️">\{text\.payrollException\}<\/SubsectionTitle>/);
  assert.doesNotMatch(page, /advancedSettings|advancedSection|advancedSummary/, "no advanced card");
  assert.doesNotMatch(page, /text\.usageSettings|text\.activeStatus/, "ambiguous 계정 사용 가능 label removed from the detail UI");
});

test("is_active has no general toggle; it changes only on an explicit cancel-termination or reactivation", () => {
  // The general 직원 활성 상태 toggle is removed; the termination date is never filled in automatically.
  assert.doesNotMatch(page, /employeeActiveToggle/);
  // Clearing a terminated employee's date shows an explicit confirmation for the existing cancel_termination flow.
  assert.match(page, /const cancellingTermination = !isMasterUser && Boolean\(user\.termination_date\) && !draft\.termination_date;/);
  assert.match(page, /<input type="checkbox" checked=\{draft\.is_active === true\} onChange=\{\(event\) => update\("is_active", event\.target\.checked\)\} \/>\n\s+<span>\{text\.cancelTerminationConfirm\}<\/span>/);
  // Inactive without a termination date: a conditional 비활성 해제 action only.
  assert.match(page, /const inactiveWithoutTermination = !isMasterUser && user\.is_active === false && !user\.termination_date;/);
  assert.match(page, /\{inactiveWithoutTermination \? <button type="button"[^>]*onClick=\{\(\) => update\("is_active", reactivating \? false : true\)\}>/);
  // General saves (incl. app login changes) do not send is_active, so the server keeps the current value.
  assert.match(page, /work_end_time: draft\.work_end_time,\n\s+attendance_tracking_enabled: draft\.attendance_tracking_enabled !== false,\n\s+app_login_enabled: draft\.app_login_enabled !== false,/);
  assert.match(page, /if \(confirmsCancelTermination \|\| reactivatesInactive\) updates\.is_active = true;/);
  assert.match(page, /const confirmsCancelTermination = original\.role !== "master" && Boolean\(original\.termination_date\) && draft\.termination_date === null && draft\.is_active === true;/);
  assert.match(page, /const reactivatesInactive = original\.role !== "master" && original\.is_active === false && !original\.termination_date && !draft\.termination_date && draft\.is_active === true;/);
  assert.match(page, /action: confirmsCancelTermination \? "cancel_termination" : undefined,/);
});

test("current payroll contract is read per employee only when the detail is open, and re-read on return", () => {
  // 2차: the employee page no longer fetches contracts itself; the card owns one shared hook instance.
  assert.equal((page.match(/\/api\/admin\/payroll\/contracts\?userId=/g) ?? []).length, 0);
  assert.equal((hook.match(/fetch\(`\/api\/admin\/payroll\/contracts\?userId=/g) ?? []).length, 1);
  // 2026-11 4차: read once 근무·급여 has been expanded (collapsed detail reads nothing)
  assert.match(page, /const contracts = usePayrollContracts\(isEditing && workVisited \? Number\(user\.id\) : null, \{ refreshOnReturn: true \}\);/);
  assert.match(hook, /if \(!refreshOnReturn \|\| !userId\) return;/);
  assert.match(hook, /document\.addEventListener\("visibilitychange", refresh\)/);
  assert.match(hook, /window\.addEventListener\("pageshow", restored\)/);
  // Read failure and "no contract" are different states.
  assert.match(page, /contracts\.loadFailed \? <span style=\{styles\.contractError\}>\{text\.payrollContractLoadFailed\}/);
  // 4차: 1~2 lines (label, base salary · start month) or 미설정
  assert.match(page, /: current \? <>\n\s+<strong style=\{styles\.contractPrimary\}>\{payrollContractLabel\(current, text\)\}<\/strong>[\s\S]*?<\/> : <strong style=\{styles\.contractPrimary\}>\{text\.payrollContractNone\}<\/strong>\}/);
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

test("2차/4차: the employee page mounts at most one payroll sheet (contract only or one setting), only for payroll-manageable employees", () => {
  assert.match(page, /const sheetView = isEditing && payroll\.openUserId === String\(user\.id\) \? payroll\.openView : null;/);
  // The shared panel mounts only inside the open sheet, cut to that view (contract or one setting card).
  assert.match(page, /\{sheetView && typeof document !== "undefined" \? \(\s*<PayrollSettingSheet/);
  assert.match(page, /<PayrollSheet[\s\S]*?<EmployeePayrollSettingsPanel[\s\S]*?only=\{view\}/);
  assert.match(page, /onManage=\{\(\) => openSheet\("contract"\)\}/);
  assert.match(page, /\{canManagePayroll \? BENEFIT_ROWS\.map/);
  assert.match(page, /showIdentity=\{false\}/);
  assert.match(page, /anchorPrefix=\{`user-\$\{user\.id\}-`\}/);
  // One contract read is shared by the 💰 summary and the contract sheet's panel (no shortcut button in work·pay).
  assert.match(page, /<PayrollContractStatus user=\{user\} draft=\{draft\} text=\{text\} contracts=\{contracts\} canManage=\{canManagePayroll\}/);
  assert.match(page, /contracts=\{contracts\}[\s\S]*contracts=\{contracts\}/);
});

test("2차: two-way navigation keeps the selected employee and confirms before discarding unsaved edits", () => {
  assert.match(settings, /router\.push\(`\/admin\/users\?userId=\$\{id\}&section=payroll`\)/);
  // P0: both exits go through confirmLeave(), which asks only when the panel has unsaved input or a pending save.
  assert.match(settings, /function openEmployeeManagement\(id: number\) \{\n    if \(!confirmLeave\(\)\) return;/);
  // 즉시성: 이탈 확인은 패널이 알린 최신 값(ref)으로 만든 문구를 쓴다.
  assert.match(settings, /const latestLeaveMessage = \(\) => payrollLeaveMessage\(panelUnsavedRef\.current, vi\);/);
  assert.match(settings, /const confirmLeave = \(\) => \{\n    const message = latestLeaveMessage\(\);\n    return message === null \|\| window\.confirm\(message\);\n  \};/);
  // return point: the detail with 근무·급여 open, and the sheet that was open (?sheet=)
  assert.match(page, /router\.replace\(`\/admin\/users\?userId=\$\{encodeURIComponent\(String\(user\.id\)\)\}&section=payroll\$\{sheetView \? `&sheet=\$\{sheetView\}` : ""\}`, \{ scroll: false \}\);/);
  assert.match(page, /const \[workOpen, setWorkOpen\] = useState\(initialFocus === "payroll"\);/);
  assert.match(page, /const \[isEditing, setIsEditing\] = useState\(initialFocus !== null\);/);
  assert.match(page, /search\.get\("section"\) === "payroll" \? "payroll" : "detail"/);
  // P0: an open-but-unchanged form is no longer "unsaved"; pending verification is reported separately.
  // 4차: a one-setting modal (no contract shown) does not report the contract pending state as its own leave reason
  assert.match(panel, /const showsContract = !only \|\| only === "contract";\n\s+const pendingVerification = showsContract && pendingContractSave !== null;/);
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
  for (const key of ["workPayInfo", "employmentStatus", "appAccess", "appLoginAllowed", "cancelTerminationConfirm", "reactivate", "reactivateUndo", "reactivateHelp", "reactivatePending", "appLoginBlockedInactive", "appLoginBlockedTerminated", "payrollException", "payrollContractCurrent", "payrollContractNone", "payrollContractLoadFailed", "payrollContractMismatch", "managePayrollSettings", "unsavedLeaveConfirm"]) {
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
