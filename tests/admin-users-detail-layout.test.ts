import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const listPage = read("app/(protected)/admin/users/page.tsx");
const createPage = read("app/(protected)/admin/users/create/page.tsx");

// Matches "<div style={styles.fieldRow2}> ... <Field label={text.X}>...</Field> ...
// <Field label={text.Y}>...</Field> ... </div>" with nothing else in between, proving
// X and Y are the only two children of the same 2-column grid wrapper, in that order.
const twoColumnRow = (leftLabel: string, rightLabel: string) =>
  new RegExp(
    `<div style=\\{styles\\.fieldRow2\\}>\\s*<Field label=\\{text\\.${leftLabel}\\}>[\\s\\S]*?<\\/Field>\\s*<Field label=\\{text\\.${rightLabel}\\}>[\\s\\S]*?<\\/Field>\\s*<\\/div>`
  );

test("list page: basic fields wrap to one column when space is narrow", () => {
  assert.ok(listPage.includes('gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 155px), 1fr))"'));
});

test("create page: fieldRow2 matches the same grid principle as the list page", () => {
  assert.match(
    createPage,
    /fieldRow2: \{\s*\n\s*display: "grid",\s*\n\s*gridTemplateColumns: "minmax\(0, 1fr\) minmax\(0, 1fr\)",\s*\n\s*gap: 7,\s*\n\s*minWidth: 0,\s*\n\s*\},/
  );
});

test("list page: name | fullName share one fieldRow2 wrapper, left to right", () => {
  assert.match(listPage, twoColumnRow("name", "fullName"));
});

test("list page: role | part share one fieldRow2 wrapper, left to right", () => {
  assert.match(listPage, twoColumnRow("role", "part"));
});

test("list page: gender | birthDate share one fieldRow2 wrapper, left to right", () => {
  assert.match(listPage, twoColumnRow("gender", "birthDate"));
});

test("list page: hireDate | terminationDate share one fieldRow2 wrapper, left to right (unchanged from prior pass)", () => {
  assert.match(listPage, twoColumnRow("hireDate", "terminationDate"));
});

test("create page: username | password share one fieldRow2 wrapper, left to right", () => {
  assert.match(createPage, twoColumnRow("username", "password"));
});

test("create page: name | fullName share one fieldRow2 wrapper, left to right", () => {
  assert.match(createPage, twoColumnRow("name", "fullName"));
});

test("create page: role | part share one fieldRow2 wrapper, left to right, and roleFieldHelp moved below the row (not inside either Field)", () => {
  assert.match(createPage, twoColumnRow("role", "part"));
  const rowMatch = createPage.match(twoColumnRow("role", "part"));
  assert.ok(rowMatch);
  const rowEnd = (rowMatch!.index ?? 0) + rowMatch![0].length;
  const afterRow = createPage.slice(rowEnd, rowEnd + 200);
  assert.match(afterRow, /<span style=\{styles\.helpText\}>\{text\.roleFieldHelp\}<\/span>/);
  // roleFieldHelp must not be nested inside the role Field itself anymore.
  const roleFieldOnly = createPage.slice(
    createPage.indexOf("<Field label={text.role}>"),
    createPage.indexOf("</Field>", createPage.indexOf("<Field label={text.role}>"))
  );
  assert.doesNotMatch(roleFieldOnly, /roleFieldHelp/);
});

test("create page: gender | birthDate share one fieldRow2 wrapper, left to right (birthDate moved out of the work-info section)", () => {
  assert.match(createPage, twoColumnRow("gender", "birthDate"));
});

test("create page: birthDate lives in the basic-info Section with role/part/gender, before work·pay and app access", () => {
  // 2026-11 생성 화면 리뉴얼: ① 기본정보 ② 근무·급여 ③ 앱 접근(직원 상세와 같은 순서·톤).
  const basicSectionStart = createPage.indexOf('<Section tone="basic" emoji="🪪" title={text.basicInfo}>');
  const workSectionStart = createPage.indexOf('<Section tone="workPay" emoji="⏰" title={text.workPayInfo}>');
  const accessSectionStart = createPage.indexOf('<Section tone="appAccess" emoji="🔐" title={text.appAccess}>');
  const birthDateIndex = createPage.indexOf("text.birthDate");
  assert.ok(basicSectionStart > -1 && workSectionStart > basicSectionStart && accessSectionStart > workSectionStart);
  assert.ok(birthDateIndex > basicSectionStart && birthDateIndex < workSectionStart);
  const hireDateIndex = createPage.indexOf("<Field label={text.hireDate}>");
  assert.ok(hireDateIndex > workSectionStart && hireDateIndex < accessSectionStart, "hire date is a work·pay field");
  const usernameIndex = createPage.indexOf("<Field label={text.username}>");
  assert.ok(usernameIndex > accessSectionStart, "login ID / password live in app access");
});

for (const [name, page] of [
  ["list page", listPage],
  ["create page", createPage],
] as const) {
  test(`${name}: gender select is sourced from the shared lib/common/genders module, not a local duplicate`, () => {
    assert.match(page, /from "@\/lib\/common\/genders"/);
    assert.match(page, /GENDER_VALUES/);
    assert.match(page, /getGenderLabel\(gender, lang\)/);
    assert.doesNotMatch(page, /const GENDER_LABELS/);
    assert.doesNotMatch(page, /function getGenderLabel/);
  });

  test(`${name}: the gender select still submits the raw English value, not the translated label`, () => {
    const selectStart = page.indexOf("{genders.map((gender) => (");
    const selectEnd = page.indexOf("))}", selectStart);
    const optionBlock = page.slice(selectStart, selectEnd);
    assert.match(optionBlock, /value=\{gender\}/);
    assert.match(optionBlock, /\{getGenderLabel\(gender, lang\)\}/);
  });
}

test("level modal initializes legacy employees with a month candidate and offers month bases only", () => {
  const modal = listPage.slice(listPage.indexOf("function LevelSettingsModal("), listPage.indexOf("function LevelHistoryView("));
  assert.match(modal, /const baseModeOptions = \["hire_month", "override_month"\] as const/);
  assert.match(modal, /employeeLevelMonthCandidate/);
  assert.doesNotMatch(modal, /text\.levelLegacyReadOnly/);
  assert.doesNotMatch(modal, /text\.levelLegacyDateMode|type="date"/);
  assert.match(modal, /text\.levelAutoShort/);
  assert.match(modal, /text\.levelDirectShort/);
  assert.doesNotMatch(modal, /text\.levelRaiseShort/);
  assert.match(modal, /text\.levelHistory/);
  assert.match(modal, /effectiveMonth: isLegacy \? "next"/);
  assert.doesNotMatch(modal, /text\.levelEffectiveMonth/);
});

test("modal state is local until apply; detail cancel and saving preserve the boundary", () => {
  assert.match(listPage, /const \[levelDraft, setLevelDraft\] = useState<LevelPolicyDraft>\(\(\) => \{/);
  assert.match(listPage, /if \(valid\) onApply\(\{ \.\.\.levelDraft, effectiveMonth: hasChanges \? "next" : "current", applied: hasChanges/);
  assert.match(listPage, /onApply=\{value => \{ setLevelDraft\(value\)/);
  assert.match(listPage, /if \(isSaving \|\| savePending\.current\) return/);
  assert.match(listPage, /<fieldset disabled=\{isSaving\}/);
  assert.match(listPage, /role="switch" aria-checked=\{checked\}/);
  assert.match(listPage, /<header style=\{styles\.modalHeader\}>/);
  assert.match(listPage, /<div style=\{styles\.modalBody\}>/);
  assert.match(listPage, /<footer style=\{styles\.modalFooter\}>/);
  assert.match(listPage, /const showComparison = hasChanges && \(levelChanged \|\| \(raiseDelta !== null && raiseDelta !== 0\)\)/);
});

test("list page: toggling included back to true does not reset baseDateMode/baseDateOverride draft state (no reset side effect on the included radio)", () => {
  assert.match(
    listPage,
    /onChange=\{\(enabled\) => setLevelDraft\(\(current\) => \(\{ \.\.\.current, included: enabled, salaryRaiseEnabled: enabled \? true : current\.salaryRaiseEnabled \}\)\)\}/
  );
});

test("create page: new employees get month bases only (auto hire month / direct base month), shown only while the level is enabled", () => {
  // Month-based policy: new employees default to the automatic hire-month base; a direct
  // base month is optional. Legacy date bases (hire date / base date) are never offered.
  assert.doesNotMatch(createPage, /levelHireDateMode/);
  assert.doesNotMatch(createPage, /levelOverrideMode\b/);
  assert.doesNotMatch(createPage, /levelCalculationStartDate/);
  // 2026-11 5차: 신규 생성은 적용/미적용만 고르고 기준월은 항상 입사월 자동(1~15일 입사월, 16일~ 다음 달).
  // 직접 기준월 지정은 기존 직원 상세 레벨 설정에만 있다.
  const levelBlock = createPage.slice(createPage.indexOf('<SubsectionTitle emoji="🎁">'), createPage.indexOf('{/* ③ 앱 접근 */}'));
  assert.match(levelBlock, /monthlyPay && form\.level_program_enabled \? <span style=\{styles\.helpText\}>\{text\.levelBaseMonth\} \{autoBaseMonth \?\? "-"\}/);
  assert.doesNotMatch(levelBlock, /type="month"|text\.levelDirectShort|text\.levelOverrideMonthMode|override_month/);
  assert.doesNotMatch(levelBlock, /text\.levelSalaryRaise/);
  assert.match(createPage, /const autoBaseMonth = hireMonthBase\(form\.hire_date\);/);
  assert.match(createPage, /text\.levelHelpBase/);
  assert.match(createPage, /level_base_mode: "hire_month" as const,/);
  assert.doesNotMatch(createPage, /level_base_month/);
  assert.match(levelBlock, /<Toggle label=\{text\.longTermLevel\}/);
});
