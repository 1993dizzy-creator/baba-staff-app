import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { addCalendarMonthsClamped, calculateEmployeeLevel } from "../lib/employee-level/calculate.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { EMPLOYEE_LEVEL_THEME } from "../lib/employee-level/presentation.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { EMPLOYEE_LEVEL_MAX_RAISE_COUNT, EMPLOYEE_LEVEL_RAISE_AMOUNT } from "../lib/employee-level/types.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { validateEmployeeLevelConfiguration, validateIncludedRaiseCount } from "../lib/employee-level/validation.ts";

const enabled = (asOfDate: string, overrides: Record<string, unknown> = {}) =>
  calculateEmployeeLevel({
    role: "staff",
    hireDate: "2026-01-15",
    levelBaseDateOverride: null,
    asOfDate,
    ...overrides,
  });

test("level boundaries start at Lv.1 and advance on exact calendar anniversaries", () => {
  const cases = [
    ["2026-01-15", 1, 0, "Lv.1"],
    ["2026-01-16", 1, 0, "Lv.1"],
    ["2026-04-14", 1, 0, "Lv.1"],
    ["2026-04-15", 2, 1, "Lv.2"],
    ["2026-07-15", 3, 2, "Lv.3"],
    ["2027-10-15", 8, 7, "Lv.8"],
  ] as const;
  for (const [date, level, raises, label] of cases) {
    const info = enabled(date);
    assert.equal(info.eligible, true);
    assert.equal(info.level, level);
    assert.equal(info.earnedRaiseCount, raises);
    assert.equal(info.displayLabel, label);
  }
});

test("24 months changes presentation to Lv.8 star without an eighth raise", () => {
  const before = enabled("2028-01-14");
  assert.equal(before.level, 8);
  assert.equal(before.negotiationEligible, false);
  assert.equal(before.displayLabel, "Lv.8");

  for (const date of ["2028-01-15", "2030-01-15"]) {
    const info = enabled(date);
    assert.equal(info.level, 8);
    assert.equal(info.negotiationEligible, true);
    assert.equal(info.displayLabel, "Lv.8★");
    assert.equal(info.earnedRaiseCount, EMPLOYEE_LEVEL_MAX_RAISE_COUNT);
    assert.equal(
      info.cumulativeRaiseAmount,
      EMPLOYEE_LEVEL_MAX_RAISE_COUNT * EMPLOYEE_LEVEL_RAISE_AMOUNT
    );
  }
});

test("calendar month addition clamps month-end, leap-year, and year boundaries", () => {
  assert.equal(addCalendarMonthsClamped("2026-01-31", 3), "2026-04-30");
  assert.equal(addCalendarMonthsClamped("2025-11-30", 3), "2026-02-28");
  assert.equal(addCalendarMonthsClamped("2024-02-29", 12), "2025-02-28");
  assert.equal(addCalendarMonthsClamped("2023-02-28", 12), "2024-02-28");
  assert.equal(addCalendarMonthsClamped("2026-11-30", 3), "2027-02-28");

  const monthEnd = enabled("2026-04-30", { hireDate: "2026-01-31" });
  assert.equal(monthEnd.level, 2);
  assert.equal(monthEnd.nextLevelDate, "2026-07-31");
});

test("override takes priority while hire date is the fallback", () => {
  const fallback = enabled("2026-04-15");
  assert.equal(fallback.baseDate, "2026-01-15");
  assert.equal(fallback.baseDateSource, "hire_date");

  const override = enabled("2026-07-14", {
    levelBaseDateOverride: "2026-04-15",
  });
  assert.equal(override.baseDate, "2026-04-15");
  assert.equal(override.baseDateSource, "override");
  assert.equal(override.level, 1);
});

test("missing, invalid, and future base dates are ineligible", () => {
  const missing = enabled("2026-01-15", { hireDate: null });
  assert.equal(missing.reason, "MISSING_BASE_DATE");

  const invalid = enabled("2026-01-15", { hireDate: "2026-02-30" });
  assert.equal(invalid.reason, "INVALID_DATE");

  const before = enabled("2026-01-14");
  assert.equal(before.reason, "BEFORE_BASE_DATE");
});

test("termination date freezes level and raises after departure", () => {
  const before = enabled("2026-07-14", { terminationDate: "2026-07-15" });
  assert.equal(before.calculationDate, "2026-07-14");
  assert.equal(before.level, 2);

  const after = enabled("2028-01-15", { terminationDate: "2026-07-15" });
  assert.equal(after.calculationDate, "2026-07-15");
  assert.equal(after.level, 3);
  assert.equal(after.earnedRaiseCount, 2);
  assert.equal(after.negotiationEligible, false);
});

test("legacy enablement is irrelevant while system accounts never calculate a level", () => {
  assert.equal(enabled("2026-04-15").level, 2);
  assert.equal(
    enabled("2026-04-15", { isSystemAccount: true }).reason,
    "SYSTEM_ACCOUNT"
  );
});

test("only manager, leader, and staff roles calculate employee levels", () => {
  for (const role of ["manager", "leader", "staff"]) {
    assert.equal(enabled("2026-04-15", { role }).eligible, true);
  }
  for (const role of ["owner", "master"]) {
    const info = enabled("2026-04-15", { role });
    assert.equal(info.eligible, false);
    assert.equal(info.reason, "ROLE_NOT_ELIGIBLE");
  }
});

test("configuration validation returns stable error codes", () => {
  const base = {
    hireDate: "2026-01-15",
    levelBaseDateOverride: null,
    terminationDate: null,
    today: "2026-07-29",
  };
  assert.equal(validateEmployeeLevelConfiguration(base).valid, true);
  assert.deepEqual(
    validateEmployeeLevelConfiguration({ ...base, hireDate: null }).codes,
    ["MISSING_HIRE_DATE"]
  );
  assert.deepEqual(
    validateEmployeeLevelConfiguration({ ...base, levelBaseDateOverride: "2026-01-14" }).codes,
    ["BASE_DATE_BEFORE_HIRE_DATE"]
  );
  assert.deepEqual(
    validateEmployeeLevelConfiguration({ ...base, terminationDate: "2026-06-30", levelBaseDateOverride: "2026-07-01" }).codes,
    ["BASE_DATE_AFTER_TERMINATION_DATE"]
  );
  assert.deepEqual(
    validateEmployeeLevelConfiguration({ ...base, levelBaseDateOverride: "2026-07-30" }).codes,
    ["BASE_DATE_IN_FUTURE"]
  );
  assert.deepEqual(
    validateEmployeeLevelConfiguration({ ...base, isSystemAccount: true }).codes,
    ["SYSTEM_ACCOUNT_NOT_ELIGIBLE"]
  );
  assert.deepEqual(
    validateEmployeeLevelConfiguration({ ...base, levelBaseDateOverride: "2026-02-30" }).codes,
    ["INVALID_DATE"]
  );
});

test("included raise count accepts zero through seven and detects over-inclusion", () => {
  assert.equal(validateIncludedRaiseCount(0, 0).valid, true);
  assert.equal(validateIncludedRaiseCount(7, 7).valid, true);
  assert.deepEqual(validateIncludedRaiseCount(-1, 7).codes, ["INVALID_INCLUDED_RAISE_COUNT"]);
  assert.deepEqual(validateIncludedRaiseCount(8, 8).codes, ["INVALID_INCLUDED_RAISE_COUNT"]);
  assert.deepEqual(
    validateIncludedRaiseCount(3, 2).codes,
    ["INCLUDED_RAISE_COUNT_EXCEEDS_EARNED"]
  );
});

test("all level themes are complete, unique, and negotiation-neutral", () => {
  const themes = Object.values(EMPLOYEE_LEVEL_THEME);
  assert.equal(themes.length, 8);
  assert.equal(new Set(themes.map((theme) => theme.backgroundColor)).size, 8);
  for (let level = 1; level <= 8; level += 1) {
    const theme = EMPLOYEE_LEVEL_THEME[level as keyof typeof EMPLOYEE_LEVEL_THEME];
    assert.equal(theme.shortLabel, String(level));
    assert.equal(theme.textColor, "#FFFFFF");
    assert.ok(theme.borderColor);
    assert.doesNotMatch(theme.label, /★/);
  }
});

test("migration adds nullable foundations without data backfill or client writes", () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260728182601_create_employee_level_foundation.sql"),
    "utf8"
  );
  assert.match(migration, /level_program_enabled boolean null/);
  assert.match(migration, /level_base_date_override date null/);
  assert.match(migration, /level_raise_included_count smallint null/);
  assert.match(migration, /between 0 and 7/);
  assert.match(migration, /users_level_enabled_requires_hire_date_check/);
  assert.match(migration, /users_system_account_level_settings_check/);
  assert.match(migration, /create table public\.employee_level_audit_logs/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.employee_level_audit_logs\s+from public, anon, authenticated, service_role/);
  assert.match(migration, /grant select, insert on table public\.employee_level_audit_logs to service_role/);
  assert.doesNotMatch(migration, /update\s+public\.users/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.employee_level_audit_logs/i);
});
