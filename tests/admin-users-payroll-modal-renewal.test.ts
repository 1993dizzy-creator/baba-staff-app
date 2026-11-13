import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 급여 모달 1차 UI 리뉴얼(/admin/users): 계약 모달 요약·관리 버튼, 복리후생 4종 모달 정리, 계약 입력 이탈 보호.
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const panel = read("components/payroll/EmployeePayrollSettingsPanel.tsx");
const card = read("components/payroll/EmployeeSettingCard.tsx");
const meal = read("components/payroll/EmployeeMealAllowanceSettings.tsx");
const bonus = read("components/payroll/EmployeeAttendanceBonusSettings.tsx");
const insurance = read("components/payroll/EmployeeInsuranceSettings.tsx");
const tax = read("components/payroll/EmployeeTaxSettings.tsx");

test("contract modal: no inner title, combined salary first, register as the main action, history folded", () => {
  const section = panel.slice(panel.indexOf("{showsContract ? <section id={anchor(\"contract\")}"), panel.indexOf("{!only || only === \"insurance\""));
  const modal = section.slice(section.indexOf("{only ? <>"), section.indexOf("</> : <>"));
  assert.doesNotMatch(modal, /cardTitle|현재 적용 중인 계약 조건/);
  assert.match(modal, /<ContractOverview contract=\{current\} levelRaise=\{levelRaise\} combined=\{combined \?\? 0\} lang=\{l\} \/>/);
  // 계약 변경 등록 (primary) before 최신 계약 정정 (secondary); both keep their existing handlers
  assert.match(modal, /style=\{s\.contractPrimary\} onClick=\{openForm\}>[\s\S]*?계약 변경 등록[\s\S]*?style=\{s\.contractSecondary\} onClick=\{openCorrectionForm\}>[\s\S]*?최신 계약 정정/);
  assert.match(modal, /\{contracts\[0\]\?\.auditVersion \? <button/);
  // the payroll settings page keeps its existing card (title, help, ContractSummary)
  const page = section.slice(section.indexOf("</> : <>"));
  assert.match(page, /<h2 style=\{s\.cardTitle\}>/);
  assert.match(page, /<ContractSummary contract=\{current\}/);
  // history stays a closed <details> with the audit records, shared by both screens
  assert.match(section, /<details style=\{s\.details\}>\n\s+<summary>\{vi \? `Lịch sử hợp đồng/);
  assert.match(section, /<ContractCard key=\{contract\.id\} contract=\{contract\} previous=\{contracts\[index \+ 1\] \?\? null\} vi=\{vi\} \/>/);
});

test("contract overview: combined, type · start date, then base / fixed / level raise with the same numbers as before", () => {
  const overview = panel.slice(panel.indexOf("function ContractOverview("), panel.indexOf("function Field("));
  assert.match(overview, /<b style=\{s\.overviewAmount\}>\{rateAmount\(combined, contract\.payType, vi\)\}<\/b>/);
  assert.match(overview, /payrollLabel\(lang, contract\.payType\)\} · \{vi \? `áp dụng từ \$\{contract\.effectiveFrom\}` : `\$\{contract\.effectiveFrom\} 적용`\}/);
  assert.match(overview, /value: rateAmount\(contract\.baseSalary, contract\.payType, vi\)/);
  assert.match(overview, /value: `\+\$\{money\(contract\.fixedRaiseAmount\)\}`/);
  assert.match(overview, /value: `\+\$\{money\(levelRaise\)\}`/);
  // combined/levelRaise still come from the panel's existing calculation
  assert.match(panel, /const combined = current\n\s+\? current\.baseSalary \+ current\.fixedRaiseAmount \+ levelRaise\n\s+: null;/);
});

test("contract form: closing with changed input asks with the shared leave message; unchanged closes directly", () => {
  const close = panel.slice(panel.indexOf("function closeForm() {"), panel.indexOf("async function submit("));
  assert.match(close, /if \(saving\) return;/);
  assert.match(close, /if \(contractInputDirty\) \{\n\s+const message = payrollLeaveMessage\(\{ input: true, pendingVerification: false \}, vi\);\n\s+if \(message && !window\.confirm\(message\)\) return;\n\s+\}/);
  assert.ok(close.indexOf("window.confirm") < close.indexOf("setOpen(false)"));
  // save path and pending-verification blocking are unchanged
  assert.match(panel, /if \(pendingContractSave\) return;\n\s+const correcting = formMode === "correct" \? correctionTarget : null;/);
});

const parts = read("components/payroll/BenefitModalParts.tsx");
const page = read("app/(protected)/admin/users/page.tsx");
const cards = [["meal", meal], ["bonus", bonus], ["insurance", insurance], ["tax", tax]] as const;
const modalBranch = (source: string) => source.slice(source.indexOf("  if (modal) {"), source.indexOf("\n  return", source.indexOf("  if (modal) {") + 20));

test("2차 benefit modals: own modal branch — bare card, status line, 2-way choice, one footer 취소·저장 set", () => {
  assert.match(card, /bare = false,/);
  assert.match(card, /if \(bare\) return <section style=\{s\.bare\}>\{children\}<\/section>;/);
  for (const [name, source] of cards) {
    const branch = modalBranch(source);
    assert.match(source, /const modal = Boolean\(formRequest\);\n\s+const formId = useId\(\);/, name);
    assert.match(branch, /defaultOpen=\{Boolean\(formRequest\)\} bare>/, name);
    assert.match(branch, /<BenefitStatusLine/, name);
    assert.match(branch, /<BenefitChoice/, name);
    assert.match(branch, /<form id=\{formId\} style=\{m\.form\} onSubmit=\{submit\}>/, name);
    assert.match(branch, /<BenefitModalActions[\s\S]*?onCancel=\{cancelForm\}/, name);
    // no second cancel/save set, no select/checkbox for the main choice, no 설정 변경 button inside the modal
    assert.doesNotMatch(branch, /s\.actions|설정 변경|type="checkbox"|<EmployeeSettingCard[^>]*bare=\{modal\}/, name);
    // the payroll settings page keeps its card (header, 설정 변경, inline actions)
    const settings = source.slice(source.indexOf("\n  return", source.indexOf("  if (modal) {") + 20));
    assert.match(settings, /defaultOpen=\{Boolean\(formRequest\)\}>/, name);
    assert.match(settings, /<div style=\{s\.head\}>/, name);
    assert.match(settings, /style=\{s\.actions\}/, name);
    assert.match(source, /설정 변경/, name);
  }
  // footer actions are portaled into the sheet footer and submit the card's form (browser + card validation apply)
  assert.match(parts, /return createPortal\(/);
  assert.match(parts, /<button type="submit" form=\{formId\} style=\{\{ \.\.\.m\.save, \.\.\.\(!canSave \|\| saving \? m\.saveDisabled : null\) \}\} disabled=\{!canSave \|\| saving\}>/);
  assert.match(parts, /<button type="button" style=\{m\.cancel\} disabled=\{saving\} onClick=\{onCancel\}>/);
  assert.match(parts, /role="radiogroup"/);
  assert.match(parts, /role="radio"\n\s+aria-checked=\{value === optionValue\}/);
  assert.match(page, /actionsTarget=\{cardActions \? actionsSlot : undefined\}/);
});

test("2차 benefit modals: save only with a real change; duplicate submit blocked; loading/failure keep cancel", () => {
  for (const [name, source] of cards) {
    assert.match(source, /async function saveForm\(event: FormEvent\) \{\n\s+event\.preventDefault\(\);\n\s+if \(saving\) return;/, name);
    assert.match(source, /if \(modal && !formValuesChanged\(/, name);
    // "changed" compares against the current values (not the switch intent), so a switch-opened modal can save its intent
    assert.match(modalBranch(source), /const changed = formValuesChanged\(\{[^}]+\}, \w+FormBaseline\(\w+(\.current)?(, employeeName)?\)\);/, name);
  }
  // meal/bonus: loading or load failure still offer 취소 (save disabled), never shown as 미적용
  for (const source of [meal, bonus]) assert.match(source, /\{modal \? <BenefitModalActions target=\{actionsTarget\} formId=\{formId\} vi=\{vi\} saving=\{false\} canSave=\{false\} hint=\{null\} onCancel=\{cancelForm\} \/> : null\}/);
  // insurance/tax: the status line only appears after a successful load (the form opens only then)
  for (const source of [insurance, tax]) assert.match(modalBranch(source), /\{formOpen \? <BenefitStatusLine|\{formOpen \? \(\n\s+<BenefitStatusLine/);
});

test("2차 insurance: cancel always reachable; not enrolled → not enrolled cannot be saved and says why", () => {
  const branch = modalBranch(insurance);
  assert.match(branch, /const savable = enrolled \|\| current\?\.isEnrolled === true;/);
  assert.match(branch, /canSave=\{formOpen && savable && changed\}/);
  assert.match(branch, /미가입 상태는 저장할 내용이 없습니다/);
  // existing submit policy kept
  assert.match(insurance, /if \(!enrolled && current\?\.isEnrolled !== true\) return;/);
  // choosing 가입 keeps the old default base amount
  assert.match(branch, /if \(next && Number\(base\) < 1\) setBase\("5000000"\);/);
});

test("2차 status line: current state and schedule come from the same pick rules as the switches", () => {
  assert.match(meal, /pickMealAllowance\(state\.history, resolveSettingsSummaryReference\(null, vietnamToday\(\)\)\)/);
  assert.match(bonus, /pickAttendanceBonus\(state\.history, resolveSettingsSummaryReference\(null, `\$\{currentMonth\(\)\}-01`\)\)/);
  assert.match(insurance, /pickInsurance\(history, resolveSettingsSummaryReference\(null, `\$\{currentMonth\(\)\}-01`\)\)/);
  assert.match(tax, /pickTax\(history, resolveSettingsSummaryReference\(null, `\$\{currentMonth\(\)\}-01`\)\)/);
  assert.match(parts, /`예약: \$\{scheduled\.from\}부터 \$\{scheduled\.on \? onLabel : offLabel\}`/);
  for (const [name, source] of cards) {
    assert.match(modalBranch(source), /<summary style=\{m\.summary\}>\{vi \? "Thông tin tham khảo" : "참고 정보"\}<\/summary>/, name);
    assert.match(modalBranch(source), /\{historyLabel\}/, name);
  }
});

test("2차: every benefit card blocks a second save request synchronously (double click / repeated Enter)", () => {
  const guard = read("components/payroll/useGuardedSubmit.ts");
  assert.match(guard, /event\.preventDefault\(\);\n\s+if \(busyRef\.current\) return;\n\s+busyRef\.current = true;\n\s+void saveRef\.current\(event\)\.finally\(\(\) => \{ busyRef\.current = false; \}\);/);
  for (const [name, source] of cards) {
    assert.match(source, /const submit = useGuardedSubmit\(saveForm\);/, name);
    assert.doesNotMatch(source, /async function submit\(/, name);
  }
});
