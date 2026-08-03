import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { formatEmployeeNameWithLevel } from "../lib/employee-level/display.ts";
import type { EmployeeLevelInfo } from "../lib/employee-level/types.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

const levelInfo = (overrides: Partial<EmployeeLevelInfo> = {}): EmployeeLevelInfo => ({
  eligible: true,
  reason: null,
  level: 3,
  displayLabel: "Lv.3",
  baseDate: "2026-01-01",
  baseDateSource: "hire_date",
  calculationDate: "2026-07-30",
  completedQuarterCount: 2,
  earnedRaiseCount: 2,
  raiseAmountPerStep: 500_000,
  cumulativeRaiseAmount: 1_000_000,
  nextLevelDate: "2026-10-01",
  negotiationEligibleAt: "2028-01-01",
  negotiationEligible: false,
  ...overrides,
});

test("native employee options use the shared level label", () => {
  assert.equal(formatEmployeeNameWithLevel("Uyen", levelInfo()), "Lv.3 · Uyen");
  assert.equal(
    formatEmployeeNameWithLevel("Vuong", levelInfo({ level: 7, negotiationEligible: true })),
    "Lv.7★ · Vuong"
  );
  assert.equal(formatEmployeeNameWithLevel("Owner", levelInfo({ eligible: false, level: null })), "Owner");
});

test("shared employee name component owns the badge eligibility guard", () => {
  const component = read("components/employee/EmployeeNameWithLevel.tsx");
  assert.match(component, /levelInfo\?\.eligible === true && levelInfo\.level !== null/);
  assert.match(component, /reason === "PROGRAM_DISABLED"/);
  assert.match(component, /showDisabledBadge = false/);
  assert.match(component, /EmployeeLevelBadge/);
  assert.match(component, /whiteSpace: "nowrap"/);
  assert.match(component, /textOverflow: "ellipsis"/);
});

test("disabled X badge is opt-in on employee, payroll, and attendance screens", () => {
  const attendanceStaff = read("app/(protected)/attendance/staff/page.tsx");
  const attendanceLeave = read("app/(protected)/attendance/leave/page.tsx");

  assert.match(read("app/(protected)/admin/users/page.tsx"), /showDisabledBadge/);
  assert.match(read("app/(protected)/admin/payroll/page.tsx"), /EmployeeLevelDisabledBadgeScope/);
  assert.equal(attendanceStaff.match(/showDisabledBadge/g)?.length, 2);
  assert.equal(attendanceLeave.match(/showDisabledBadge/g)?.length, 2);
  assert.doesNotMatch(read("components/bar/BarZoneDetail.tsx"), /showDisabledBadge/);
});

test("employee list APIs select only explicit level inputs and calculate levelInfo", () => {
  for (const file of [
    "app/api/attendance/users/route.ts",
    "app/api/admin/payroll/users/route.ts",
    "app/api/bar/staff/route.ts",
    "lib/bar/server-data.ts",
  ]) {
    const source = read(file);
    assert.match(source, /level_program_enabled/);
    assert.match(source, /level_base_date_override/);
    assert.match(source, /withEmployeeLevelInfo/);
    assert.doesNotMatch(source, /select\(["'`]\*["'`]\)/);
    assert.doesNotMatch(source, /password|private_token/);
  }
});

test("approved screens use shared display while excluded snapshots and logs stay untouched", () => {
  for (const file of [
    "app/(protected)/admin/users/page.tsx",
    "app/(protected)/attendance/staff/page.tsx",
    "app/(protected)/attendance/leave/page.tsx",
    "app/(protected)/admin/payroll/attendance/page.tsx",
    "app/(protected)/admin/payroll/attendance/[userId]/page.tsx",
    "app/(protected)/admin/payroll/settings/page.tsx",
    "components/bar/BarZoneDetail.tsx",
  ]) assert.match(read(file), /EmployeeNameWithLevel/);

  assert.doesNotMatch(read("app/(protected)/admin/payroll/[runId]/page.tsx"), /EmployeeNameWithLevel|EmployeeLevelBadge/);
  assert.doesNotMatch(read("components/bar/BarZoneRecentLogs.tsx"), /EmployeeNameWithLevel|EmployeeLevelBadge/);
  assert.doesNotMatch(read("app/(protected)/layout.tsx"), /EmployeeNameWithLevel|EmployeeLevelBadge/);
});
