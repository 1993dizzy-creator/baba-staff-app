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
import { validateEmployeeLevelConfiguration } from "../lib/employee-level/validation.ts";

const enabled = (asOfDate: string, overrides: Record<string, unknown> = {}) =>
  calculateEmployeeLevel({
    role: "staff",
    hireDate: "2026-01-15",
    levelBaseDateOverride: null,
    asOfDate,
    ...overrides,
  });

test("level boundaries start at Lv.0 and advance on exact calendar anniversaries", () => {
  const cases = [
    ["2026-01-15", 0, 0, "Lv.0"],
    ["2026-01-16", 0, 0, "Lv.0"],
    ["2026-04-14", 0, 0, "Lv.0"],
    ["2026-04-15", 1, 1, "Lv.1"],
    ["2026-07-15", 2, 2, "Lv.2"],
    ["2027-10-15", 7, 7, "Lv.7"],
  ] as const;
  for (const [date, level, raises, label] of cases) {
    const info = enabled(date);
    assert.equal(info.eligible, true);
    assert.equal(info.level, level);
    assert.equal(info.earnedRaiseCount, raises);
    assert.equal(info.displayLabel, label);
  }
});

test("24 months changes presentation to Lv.7 star without an eighth raise", () => {
  const before = enabled("2028-01-14");
  assert.equal(before.level, 7);
  assert.equal(before.negotiationEligible, false);
  assert.equal(before.displayLabel, "Lv.7");

  for (const date of ["2028-01-15", "2030-01-15"]) {
    const info = enabled(date);
    assert.equal(info.level, 7);
    assert.equal(info.negotiationEligible, true);
    assert.equal(info.displayLabel, "Lv.7★");
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
  assert.equal(monthEnd.level, 1);
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
  assert.equal(override.level, 0);
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
  assert.equal(before.level, 1);

  const after = enabled("2028-01-15", { terminationDate: "2026-07-15" });
  assert.equal(after.calculationDate, "2026-07-15");
  assert.equal(after.level, 2);
  assert.equal(after.earnedRaiseCount, 2);
  assert.equal(after.negotiationEligible, false);
});

test("automatic-role enablement is implicit while system accounts never calculate a level", () => {
  assert.equal(enabled("2026-04-15").level, 1);
  assert.equal(
    enabled("2026-04-15", { isSystemAccount: true }).reason,
    "SYSTEM_ACCOUNT"
  );
});

test("staff roles are automatic while owner and master require explicit inclusion", () => {
  for (const role of ["manager", "leader", "staff"]) {
    assert.equal(enabled("2026-04-15", { role }).eligible, true);
  }
  for (const role of ["owner", "master"]) {
    const info = enabled("2026-04-15", { role });
    assert.equal(info.eligible, false);
    assert.equal(info.reason, "ROLE_NOT_ELIGIBLE");
    assert.equal(enabled("2026-04-15", { role, levelProgramEnabled: true }).eligible, true);
    assert.equal(enabled("2026-04-15", { role, levelProgramEnabled: false }).eligible, false);
  }
  assert.equal(
    enabled("2026-04-15", {
      role: "owner",
      levelProgramEnabled: true,
      isSystemAccount: true,
    }).reason,
    "SYSTEM_ACCOUNT"
  );
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

test("all level themes are complete, unique, and negotiation-neutral", () => {
  const themes = Object.values(EMPLOYEE_LEVEL_THEME);
  assert.equal(themes.length, 8);
  assert.equal(new Set(themes.map((theme) => theme.backgroundColor)).size, 8);
  for (let level = 0; level <= 7; level += 1) {
    const theme = EMPLOYEE_LEVEL_THEME[level as keyof typeof EMPLOYEE_LEVEL_THEME];
    assert.equal(theme.shortLabel, String(level));
    assert.equal(theme.textColor, "#FFFFFF");
    assert.ok(theme.borderColor);
    assert.doesNotMatch(theme.label, /★/);
  }
  assert.deepEqual(
    Array.from({ length: 8 }, (_, level) => EMPLOYEE_LEVEL_THEME[level as keyof typeof EMPLOYEE_LEVEL_THEME].backgroundColor),
    ["#94A3B8", "#EF4444", "#F97316", "#FACC15", "#22C55E", "#3B82F6", "#4F46E5", "#A855F7"]
  );
});

test("zero-based audit constraints are added by a follow-up migration", () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260729160628_add_manual_owner_levels_and_zero_based_audit.sql"),
    "utf8"
  );
  assert.match(migration, /previous_level between 0 and 7/);
  assert.match(migration, /next_level between 0 and 7/);
  assert.match(migration, /when previous_level between 1 and 8 then previous_level - 1/);
  assert.match(migration, /when next_level between 1 and 8 then next_level - 1/);
  assert.match(migration, /where previous_level between 1 and 8 or next_level between 1 and 8/);
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
