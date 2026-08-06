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

test("list page: fieldRow2 is defined once as the shared 2-column grid (minmax(0,1fr) x2)", () => {
  assert.match(
    listPage,
    /fieldRow2: \{\s*\n\s*display: "grid",\s*\n\s*gridTemplateColumns: "minmax\(0, 1fr\) minmax\(0, 1fr\)",\s*\n\s*gap: 7,\s*\n\s*minWidth: 0,\s*\n\s*\},/
  );
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

test("create page: birthDate now lives in the same Section as role/part/gender, not workInfo", () => {
  const accessSectionStart = createPage.indexOf('Section title={text.accessInfo}');
  const workSectionStart = createPage.indexOf('Section title={text.workInfo}');
  const birthDateIndex = createPage.indexOf("text.birthDate");
  assert.ok(accessSectionStart > -1 && workSectionStart > accessSectionStart);
  assert.ok(birthDateIndex > accessSectionStart && birthDateIndex < workSectionStart);
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

test("list page: the level calculation basis section only renders when levelDraft.included is true", () => {
  assert.match(
    listPage,
    /\{levelDraft\.included \? \(\s*\n\s*<>\s*\n\s*<strong style=\{styles\.levelEditorTitle\}>\{text\.levelCalculationBasis\}<\/strong>/
  );
  // the hire_date/override toggle and the base-date field/notice must be inside that
  // same conditional block, and the block must close before levelStateChanged.
  const includedBranchStart = listPage.indexOf("{levelDraft.included ? (");
  const levelStateChangedIndex = listPage.indexOf("{levelStateChanged ? <>", includedBranchStart);
  const includedBranch = listPage.slice(includedBranchStart, levelStateChangedIndex);
  assert.match(includedBranch, /text\.levelHireDateMode/);
  assert.match(includedBranch, /text\.levelOverrideMode/);
  assert.match(includedBranch, /text\.levelCalculationStartDate/);
});

test("list page: the 적용/미적용 toggle itself and the month-effective selector stay outside the included-only block (always available)", () => {
  const sectionStart = listPage.indexOf("<strong style={styles.levelEditorTitle}>{text.longTermLevel}</strong>");
  const includedBranchStart = listPage.indexOf("{levelDraft.included ? (", sectionStart);
  const beforeConditional = listPage.slice(sectionStart, includedBranchStart);
  assert.match(beforeConditional, /text\.levelEnabled/);
  assert.match(beforeConditional, /text\.levelDisabled/);
  assert.match(listPage, /\{levelStateChanged \? <>\s*\n\s*<Field label=\{text\.levelEffectiveMonth\}>/);
});

test("list page: toggling included back to true does not reset baseDateMode/baseDateOverride draft state (no reset side effect on the included radio)", () => {
  assert.match(
    listPage,
    /onChange=\{\(\) => setLevelDraft\(\(current\) => \(\{ \.\.\.current, included: enabled \}\)\)\}/
  );
});

test("create page: there is no calculation-basis (hire_date/override) selector to begin with, so nothing needs conditional hiding", () => {
  // Documented finding: unlike the list/edit page, the create page never had a
  // levelCalculationBasis / hire-date-vs-override selector or a base-date display.
  // New employees are always base-dated off hire_date server-side. There is nothing
  // for this task's "hide calculation basis when disabled" requirement to hide here.
  assert.doesNotMatch(createPage, /levelCalculationBasis/);
  assert.doesNotMatch(createPage, /levelHireDateMode/);
  assert.doesNotMatch(createPage, /levelOverrideMode/);
  assert.doesNotMatch(createPage, /levelCalculationStartDate/);
  // The only level UI is the enabled/disabled toggle plus its help text.
  assert.match(createPage, /text\.levelEnabled/);
  assert.match(createPage, /text\.levelDisabled/);
  assert.match(createPage, /text\.levelPolicyHelp/);
});
