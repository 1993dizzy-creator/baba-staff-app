import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { selectAttendanceBonusEligibilityAt } from "../lib/payroll/attendance-bonus.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const card = read("components/payroll/EmployeeSettingCard.tsx");
const settingsPage = read("app/(protected)/admin/payroll/settings/page.tsx");
const insurance = read("components/payroll/EmployeeInsuranceSettings.tsx");
const tax = read("components/payroll/EmployeeTaxSettings.tsx");
const meal = read("components/payroll/EmployeeMealAllowanceSettings.tsx");
const attendanceBonus = read("components/payroll/EmployeeAttendanceBonusSettings.tsx");

test("four employee setting cards default collapsed and expose compact localized status headers", () => {
  assert.match(card, /useState\(false\)/);
  assert.match(card, /aria-expanded=\{open\}/);
  assert.match(card, /onClick=\{\(\) => setOpen/);
  assert.match(card, /open \? <div style=\{s\.body\}>\{children\}<\/div> : null/);
  assert.match(card, /"적용"[\s\S]*"미적용"/);
  assert.match(card, /"Áp dụng"[\s\S]*"Không áp dụng"/);
  for (const source of [insurance, tax, meal, attendanceBonus]) assert.match(source, /EmployeeSettingCard/);
});

test("employee change remounts all four cards so each returns to collapsed", () => {
  for (const key of ["insurance-", "tax-", "meal-allowance-", "attendance-bonus-"]) {
    assert.match(settingsPage, new RegExp(`key=\\{\\\`${key}\\$\\{selected\\.id\\}\\\`\\}`));
  }
});

test("insurance, TNCN, meal and attendance bonus badges use their current applied state and hide while loading", () => {
  assert.match(insurance, /applied=\{loaded \? current\?\.isEnrolled === true : null\}/);
  assert.match(tax, /applied=\{loaded \? current !== null && current\.taxMode !== "not_applicable" : null\}/);
  assert.match(meal, /applied=\{state\.current\?\.isEligible === true\}/);
  assert.match(attendanceBonus, /const eligible = state\.current\?\.isEligible === true/);
  assert.match(attendanceBonus, /applied=\{eligible\}/);
  for (const source of [meal, attendanceBonus]) assert.match(source, /applied=\{null\}/);
});

test("future attendance-bonus reservation is not treated as currently applied", () => {
  const versions = [
    { id: 1, userId: 7, isEligible: false, effectiveMonth: "2026-09", revision: 1 },
    { id: 2, userId: 7, isEligible: true, effectiveMonth: "2026-10", revision: 1 },
  ];
  assert.equal(selectAttendanceBonusEligibilityAt(versions, "2026-09")?.isEligible, false);
  assert.equal(selectAttendanceBonusEligibilityAt(versions, "2026-10")?.isEligible, true);
});

test("expanded cards preserve existing change forms and setting histories", () => {
  for (const source of [insurance, tax, meal, attendanceBonus]) {
    assert.match(source, /formOpen/);
    assert.match(source, /<form/);
    assert.match(source, /<details/);
    assert.match(source, /history\.map/);
  }
});
