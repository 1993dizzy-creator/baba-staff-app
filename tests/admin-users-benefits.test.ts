import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pickAttendanceBonus, pickInsurance, pickMealAllowance, pickTax, resolveSettingsSummaryReference } from "../lib/payroll/settings-summary.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/users/page.tsx");
const panel = read("components/payroll/EmployeePayrollSettingsPanel.tsx");
const hook = read("components/payroll/useEmployeeBenefitStatus.ts");
const cards = ["EmployeeMealAllowanceSettings", "EmployeeAttendanceBonusSettings", "EmployeeInsuranceSettings", "EmployeeTaxSettings"].map((name) => [name, read(`components/payroll/${name}.tsx`)] as const);
const reference = resolveSettingsSummaryReference(null, "2026-11-12");

test("switch state = the version applied today (payroll selection rules); a later version is a separate schedule", () => {
  const insurance = pickInsurance([
    { id: 2, userId: 1, isEnrolled: false, insuranceBaseAmount: 0, effectiveMonth: "2026-12-01", revision: 2, createdBy: 1, createdAt: "", note: null },
    { id: 1, userId: 1, isEnrolled: true, insuranceBaseAmount: 5000000, effectiveMonth: "2026-01-01", revision: 1, createdBy: 1, createdAt: "", note: null },
  ], reference);
  assert.equal(insurance.applied?.isEnrolled, true, "still ON this month");
  assert.equal(insurance.scheduled?.isEnrolled, false, "해제 예정 2026-12");
  const bonus = pickAttendanceBonus([{ isEligible: false, effectiveMonth: "2026-12", revision: 2 }, { isEligible: true, effectiveMonth: "2026-01", revision: 1 }], reference);
  assert.deepEqual([bonus.applied?.isEligible, bonus.scheduled?.isEligible], [true, false]);
  const meal = pickMealAllowance([{ isEligible: true, effectiveFrom: "2026-11-20", revision: 1 }], reference);
  assert.deepEqual([meal.applied, meal.scheduled?.isEligible], [null, true], "future ON is 적용 예정, not ON");
  // TNCN: OFF only for not_applicable / no profile; ON is the progressive mode — never derived from a 0₫ result
  const base = { id: 1, userId: 1, dependentCount: 0, burdenMode: "employee_deducted", insuranceDeductionMode: "none", manualInsuranceDeductionAmount: 0, revision: 1, createdBy: 1, createdAt: "", note: null } as const;
  assert.equal(pickTax([{ ...base, effectiveMonth: "2026-01-01", taxMode: "not_applicable", accountingName: null }], reference).applied?.taxMode, "not_applicable");
  const noName = pickTax([{ ...base, effectiveMonth: "2026-01-01", taxMode: "resident_progressive", accountingName: null }], reference);
  assert.deepEqual([noName.applied?.taxMode, noName.requiresReview], ["resident_progressive", true]);
  assert.equal(pickTax([], reference).requiresReview, true, "no profile = 확인 필요");
  // the hook uses exactly these rules and the existing GETs (no new API)
  for (const fn of ["pickMealAllowance", "pickAttendanceBonus", "pickInsurance", "pickTax"]) assert.match(hook, new RegExp(`const pick = ${fn}\\(`));
  for (const endpoint of ["/api/admin/payroll/meal-allowance/eligibility?userId=", "/api/admin/payroll/attendance-bonus/eligibility?userId=", "/api/admin/payroll/insurance?userId=", "/api/admin/payroll/tax-settings?userId="]) assert.ok(hook.includes(endpoint), endpoint);
  assert.match(hook, /const on = pick\.applied\?\.taxMode === "resident_progressive";/);
});

test("status reads are lazy, per employee, abortable, and a failure is never shown as OFF", () => {
  assert.match(page, /const benefits = useEmployeeBenefitStatus\(isEditing && workVisited && canManagePayroll \? Number\(user\.id\) : null\);/);
  assert.match(hook, /const stale = \(\) => signal\?\.aborted \|\| userIdRef\.current !== id;/);
  assert.match(hook, /return \(\) => controller\.abort\(\);/);
  // tile: a failure replaces the switch with 조회 실패 + retry; loading disables the switch (never a false OFF)
  assert.match(page, /\{failed \? \(\n\s+<button type="button" style=\{styles\.benefitRetry\} onClick=\{onRetry\}>\{text\.retry\}<\/button>\n\s+\) : labelOnly \? null : \(/);
  assert.match(page, /disabled=\{disabled \|\| !ready \|\| switchDisabled\}/);
  assert.match(page, /aria-busy=\{loading \|\| undefined\}/);
});

test("a switch never saves: it opens that setting's modal at the current state; saving uses the card's existing API, then re-reads", () => {
  // 3차: switch and icon/name open the same modal; neither pre-selects the opposite state
  assert.match(page, /onSwitch=\{\(\) => openSheet\(row\.key\)\}/);
  assert.doesNotMatch(page, /enable: !on/);
  assert.match(page, /onDetail=\{\(\) => openSheet\(row\.key\)\}/);
  assert.doesNotMatch(page, /fetch\([^)]*(meal-allowance|attendance-bonus|insurance|tax-settings)[^)]*method/, "no setting writes from the employee page");
  assert.match(page, /benefits\.reload\(view\);\n\s+if \(view === "meal"\) payroll\.onMealChanged\(\);/);
  // the tile is a plain container with sibling buttons (name, switch or retry); the switch is a real switch
  // with ON/OFF text (not colour only), a sliding track/knob and a 44px target
  const tile = page.slice(page.indexOf("function BenefitTile("), page.indexOf("/** 둥근 트랙과 원형 손잡이"));
  assert.match(tile, /return <div style=\{\{ \.\.\.styles\.benefitTile/);
  assert.match(tile, /role="switch"\n\s+aria-checked=\{on\}\n\s+aria-label=\{title\}/);
  assert.match(tile, /<span style=\{\{ \.\.\.styles\.switchText, \.\.\.styles\.switchTextCompact \}\}>\{loading \? "…" : on \? "ON" : "OFF"\}<\/span>\n\s+<SwitchTrack on=\{on\} compact \/>/);
  assert.match(page, /switchButton: \{ flexShrink: 0, minWidth: 44, minHeight: 44,/);
  assert.match(page, /benefitTileInfo: \{ minWidth: 0, minHeight: 44,/);
  assert.match(page, /switchKnobOn: \{ transform: "translateX\(20px\)" \}/);
  // compact tiles: visually smaller track, one-line short names (full name kept as the accessible name)
  assert.match(page, /switchKnobOnCompact: \{ transform: "translateX\(16px\)" \}/);
  assert.match(page, /benefitTileName: \{ minWidth: 0, whiteSpace: "nowrap" \}/);
  assert.match(tile, /aria-label=\{title\} aria-describedby=\{stateId\}/);
  assert.match(tile, /\{shortTitle \?\? title\}/);
});

test("setting cards: modal mode opens the form once after load at the server's current state (its unsaved baseline); cancel/save report back", () => {
  for (const [name, source] of cards) {
    assert.match(source, /formRequest\?: PayrollSettingFormRequest \| null;/, name);
    assert.match(source, /const formRequestRef = useRef\(formRequest \?\? null\);\n\s+const autoOpenedRef = useRef\(false\);/, name);
    assert.match(source, /if \(request && !autoOpenedRef\.current\) \{\n\s+autoOpenedRef\.current = true;/, name);
    // unsaved / save-enable baseline = the current server state (no switch intent)
    assert.match(source, /FormBaseline\((state\?\.current \?\? null|current|current, employeeName)\)\)\), onDirtyChange\);/, `${name}: unsaved = differs from the current-state baseline`);
    assert.doesNotMatch(source, /formIntent|request\.enable/, `${name}: no switch intent prefill`);
    assert.match(source, /onFormFinish\?\.\("saved"\);/, name);
    assert.match(source, /onFormFinish\?\.\("cancelled"\);/, name);
    assert.match(source, /defaultOpen=\{Boolean\(formRequest\)\}/, name);
  }
  // attendance-OFF employees still cannot choose 대상 in the modal (same as the existing server rule)
  for (const [name, source] of cards.filter(([name]) => /Meal|AttendanceBonus/.test(name))) {
    assert.match(source, /onDisabled=\{disabledByAttendanceTracking\}/, name);
  }
});

test("the shared panel cuts to one view on /admin/users and stays whole on the payroll settings page", () => {
  assert.match(panel, /export type EmployeePayrollPanelOnly = "contract" \| "insurance" \| "tax" \| "meal" \| "bonus";/);
  assert.match(panel, /\{!only \? <section style=\{showIdentity \? s\.employeeSummary : s\.employeeSummaryPlain\}>/);
  assert.match(panel, /\{showsContract \? <section id=\{anchor\("contract"\)\}/);
  for (const key of ["insurance", "tax", "meal", "bonus"]) assert.match(panel, new RegExp(`\\{!only \\|\\| only === "${key}" \\? <div id=\\{anchor\\("${key}"\\)\\}`), key);
  assert.doesNotMatch(read("app/(protected)/admin/payroll/settings/page.tsx"), /only=|formRequest=/, "settings page unchanged (full panel)");
  // contract sheet: no level settings (read-only level raise stays in the contract summary/modal)
  assert.match(page, /formRequest=\{view === "contract" \? undefined : request \?\? \{ enable: null \}\}/);
  assert.doesNotMatch(page.slice(page.indexOf("function PayrollSettingSheet("), page.indexOf("function Toggle(")), /levelAction/);
});

test("기본정보·근무·급여 start collapsed in a newly opened detail; collapsing never touches the draft or an open modal", () => {
  assert.match(page, /const \[basicOpen, setBasicOpen\] = useState\(false\);/);
  assert.match(page, /setBasicOpen\(false\);\n\s+setWorkOpen\(false\);/);
  // modals render at the card level, outside the collapsible body
  const body = page.slice(page.indexOf('<CollapsibleSection tone="workPay"'), page.indexOf('{!isMasterUser ? <section style={sectionStyle("appAccess")}>'));
  assert.doesNotMatch(body, /<PayrollSettingSheet/);
  assert.match(page, /\{sheetView && typeof document !== "undefined" \? \(\n\s+<PayrollSettingSheet/);
});
