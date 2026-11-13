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

test("benefit modals: bare card (no inner title), no help text or 설정 변경 button, form opens directly", () => {
  assert.match(card, /bare = false,/);
  assert.match(card, /if \(bare\) return <section style=\{s\.bare\}>\{children\}<\/section>;/);
  for (const [name, source] of [["meal", meal], ["bonus", bonus], ["insurance", insurance], ["tax", tax]] as const) {
    assert.match(source, /const modal = Boolean\(formRequest\);/, name);
    assert.match(source, /defaultOpen=\{Boolean\(formRequest\)\} bare=\{modal\}>/, name);
    assert.match(source, /\{modal \? null : <div style=\{s\.head\}>/, name);
    // the payroll settings page keeps the 설정 변경 button (non-modal branch)
    assert.match(source, /설정 변경/, name);
  }
});

test("benefit modals: priority info first, common-setting reference folded, history kept", () => {
  // meal: 상태·적용일 first; 기준 근무일수·예상 식대 folded
  assert.match(meal, /\{modal \? null : reference\}/);
  assert.match(meal, /\{modal \? <details style=\{s\.details\}>\n\s+<summary>\{vi \? "Thông tin tham khảo" : "참고 정보"\}<\/summary>/);
  // bonus: 대상·적용월 first; 금액·판정 기준·이번 달 상태 folded (read-only common policy)
  assert.match(bonus, /\{modal \? null : reference\}/);
  assert.match(bonus, /const reference = <>\n\s+<Summary label=\{vi \? "Mức thưởng" : "보너스 금액"\}/);
  // insurance: 가입·기준급여·적용월; revision only on the settings page
  assert.match(insurance, /\{modal \? null : <Summary label="revision"/);
  // tax: 적용 방식·세금 부담·부양가족·회계 명의·적용월
  const taxModal = tax.slice(tax.indexOf("{current && modal ? <div style={s.current}>"), tax.indexOf("</div> : current ? <div style={s.current}>"));
  for (const label of ["적용 방식", "세금 부담", "부양가족", "회계/TNCN 명의", "적용 월"]) assert.ok(taxModal.includes(`"${label}"`), label);
  assert.doesNotMatch(taxModal, /revision|employeeName/);
  for (const source of [meal, bonus, insurance, tax]) assert.match(source, /설정 이력|Lịch sử/);
});
