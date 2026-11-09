import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { calculateEmployeeLevel } from "../lib/employee-level/calculate.ts";
import { hireMonthBase, levelPromotionMonths } from "../lib/employee-level/month.ts";
import { validateEmployeeLevelBaseMonth } from "../lib/employee-level/validation.ts";
import { levelUserFieldsFromVersion, serializeEmployeeLevelProgramVersion } from "../lib/employee-level/version-selection.ts";
import { calculateCombinedSalary } from "../lib/payroll/compensation.ts";
import { stablePayrollSourceHash } from "../lib/payroll/source-export/stable-hash.ts";
import type { EmployeeLevelBaseMode } from "../lib/employee-level/types.ts";

// ---------------------------------------------------------------------------
// Previous implementation (HEAD 2b3d750b) loaded verbatim for byte-level comparison.
const BASE_COMMIT = "2b3d750bde5f2f9739f5b650cdf8727809e877a1";
const oldDir = ".local/level-head-snapshot";
rmSync(oldDir, { recursive: true, force: true });
mkdirSync(oldDir, { recursive: true });
for (const file of ["calculate.ts", "types.ts"]) {
  writeFileSync(`${oldDir}/${file}`, execFileSync("git", ["show", `${BASE_COMMIT}:lib/employee-level/${file}`], { encoding: "utf8" }));
}
writeFileSync(`${oldDir}/compensation.ts`, execFileSync("git", ["show", `${BASE_COMMIT}:lib/payroll/compensation.ts`], { encoding: "utf8" })
  .replace('from "./work-policy.ts"', `from "${pathToFileURL("lib/payroll/work-policy.ts").href}"`)
  .replace('from "../employee-level/types"', 'from "./types.ts"'));
writeFileSync(`${oldDir}/package.json`, '{"type":"module"}');
const oldCalc = await import(pathToFileURL(`${oldDir}/calculate.ts`).href);
const oldComp = await import(pathToFileURL(`${oldDir}/compensation.ts`).href);

const level = (input: { hireDate: string; mode?: EmployeeLevelBaseMode | null; override?: string | null; asOf: string; raise?: boolean; termination?: string | null }) =>
  calculateEmployeeLevel({ role: "staff", hireDate: input.hireDate, levelBaseDateOverride: input.override ?? null, levelBaseMode: input.mode ?? null,
    salaryRaiseEnabled: input.raise, terminationDate: input.termination ?? null, asOfDate: input.asOf });
/** Promotion dates observed by scanning every day (independent of the formula). */
function observedPromotions(input: { hireDate: string; mode: EmployeeLevelBaseMode; override?: string | null }, from: string, to: string) {
  const out: string[] = [];
  let prev: number | null = null;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const lv = level({ ...input, asOf: day }).level;
    if (prev !== null && lv !== null && lv > prev) out.push(day);
    prev = lv;
  }
  return out;
}

test("1–4: automatic base month — day 1–15 hire month, 16+ next month, year rollover", () => {
  assert.equal(hireMonthBase("2026-11-02"), "2026-11");
  assert.equal(hireMonthBase("2026-11-15"), "2026-11");
  assert.equal(hireMonthBase("2026-11-16"), "2026-12");
  assert.equal(hireMonthBase("2026-11-30"), "2026-12");
  assert.equal(hireMonthBase("2026-12-20"), "2027-01");
  assert.equal(hireMonthBase("2027-02-28"), "2027-03");
  assert.equal(level({ hireDate: "2026-11-02", mode: "hire_month", asOf: "2027-01-31" }).level, 0);
  assert.equal(level({ hireDate: "2026-11-02", mode: "hire_month", asOf: "2027-02-01" }).level, 1);
  assert.equal(level({ hireDate: "2026-11-02", mode: "hire_month", asOf: "2026-11-10" }).nextLevelDate, "2027-02-01");
  assert.equal(level({ hireDate: "2026-11-15", mode: "hire_month", asOf: "2026-11-20" }).baseMonth, "2026-11");
  const late = level({ hireDate: "2026-11-16", mode: "hire_month", asOf: "2026-11-20" });
  assert.deepEqual([late.eligible, late.level, late.baseMonth, late.nextLevelDate], [true, 0, "2026-12", "2027-03-01"]);
  assert.equal(level({ hireDate: "2026-11-16", mode: "hire_month", asOf: "2027-02-28" }).level, 0);
  assert.equal(level({ hireDate: "2026-11-16", mode: "hire_month", asOf: "2027-03-01" }).level, 1);
  assert.equal(level({ hireDate: "2026-12-20", mode: "hire_month", asOf: "2027-04-01" }).level, 1);
  assert.equal(level({ hireDate: "2026-12-20", mode: "hire_month", asOf: "2027-03-31" }).level, 0);
});

test("5: a direct base month ignores the automatic rule and cannot precede the hire month", () => {
  const direct = level({ hireDate: "2026-11-16", mode: "override_month", override: "2026-11-01", asOf: "2027-02-01" });
  assert.deepEqual([direct.level, direct.baseMonth, direct.baseDateSource], [1, "2026-11", "override_month"]);
  assert.deepEqual(validateEmployeeLevelBaseMonth({ mode: "override_month", baseMonth: "2026-11", hireDate: "2026-11-16" }).codes, []);
  assert.deepEqual(validateEmployeeLevelBaseMonth({ mode: "override_month", baseMonth: "2026-10", hireDate: "2026-11-16" }).codes, ["BASE_MONTH_BEFORE_HIRE_MONTH"]);
  assert.deepEqual(validateEmployeeLevelBaseMonth({ mode: "override_month", baseMonth: "2026-13", hireDate: "2026-11-16" }).codes, ["INVALID_BASE_MONTH"]);
  assert.deepEqual(validateEmployeeLevelBaseMonth({ mode: "override_month", baseMonth: "2027-01", hireDate: "2026-11-16", terminationDate: "2026-12-31" }).codes, ["BASE_MONTH_AFTER_TERMINATION"]);
  // A future direct month keeps Lv.0 until it starts.
  assert.equal(level({ hireDate: "2026-11-02", mode: "override_month", override: "2027-01-01", asOf: "2026-11-10" }).level, 0);
});

const SHEET = [
  // name, hire date, mode, override, expected promotion months in the window
  ["HAI LINH", "2025-12-03", "override_month", "2026-02-01", ["2026-05-01", "2026-08-01", "2026-11-01"]],
  ["DIEP", "2025-11-02", "hire_month", null, ["2026-02-01", "2026-05-01", "2026-08-01", "2026-11-01"]],
  ["KHOI", "2026-04-01", "hire_month", null, ["2026-07-01", "2026-10-01"]],
  ["TRIEM", "2026-03-06", "hire_month", null, ["2026-06-01", "2026-09-01", "2026-12-01"]],
  ["THÀNH", "2026-06-08", "hire_month", null, ["2026-09-01", "2026-12-01"]],
  ["NHUNG", "2026-06-04", "hire_month", null, ["2026-09-01", "2026-12-01"]],
] as const;

test("6–10: 2025–2026 attendance-sheet base months give the expected promotion months", () => {
  for (const [name, hireDate, mode, override, expected] of SHEET) {
    assert.deepEqual(observedPromotions({ hireDate, mode, override }, "2026-01-01", "2026-12-31"), expected, name);
  }
  assert.deepEqual(levelPromotionMonths("2026-02").slice(0, 3), ["2026-05", "2026-08", "2026-11"]);
  // HAI LINH under the new month (Lv.3 on 2026-11-10) vs the legacy 2026-01-03 date.
  assert.equal(level({ hireDate: "2025-12-03", mode: "override_month", override: "2026-02-01", asOf: "2026-11-10" }).level, 3);
  assert.equal(level({ hireDate: "2025-12-03", mode: "override", override: "2026-01-03", asOf: "2026-11-10" }).level, 3);
  assert.equal(level({ hireDate: "2025-12-03", mode: "override_month", override: "2026-02-01", asOf: "2026-07-15" }).level, 1);
  assert.equal(level({ hireDate: "2025-12-03", mode: "override", override: "2026-01-03", asOf: "2026-07-15" }).level, 2);
});

test("VUONG/QUYEN/QUAN/UYEN/NHON: base month 2025-10 equals their legacy 2025-10-01 override on every day", () => {
  for (const hireDate of ["2025-06-01", "2025-08-01", "2025-08-13"]) {
    for (let t = Date.parse("2025-10-01T00:00:00Z"); t <= Date.parse("2028-01-31T00:00:00Z"); t += 86400000) {
      const asOf = new Date(t).toISOString().slice(0, 10);
      const legacy = level({ hireDate, mode: "override", override: "2025-10-01", asOf });
      const month = level({ hireDate, mode: "override_month", override: "2025-10-01", asOf });
      assert.deepEqual([month.level, month.earnedRaiseCount, month.cumulativeRaiseAmount, month.nextLevelDate, month.displayLabel],
        [legacy.level, legacy.earnedRaiseCount, legacy.cumulativeRaiseAmount, legacy.nextLevelDate, legacy.displayLabel], `${hireDate} ${asOf}`);
    }
  }
});

test("13: legacy employees keep byte-identical level info, compensation and hashes (no past paid month can change)", () => {
  const cases: { hireDate: string | null; override: string | null; role: string; enabled: boolean | null; termination: string | null }[] = [
    { hireDate: "2025-11-02", override: null, role: "staff", enabled: true, termination: null },
    { hireDate: "2025-12-03", override: "2026-01-03", role: "leader", enabled: true, termination: null },
    { hireDate: "2025-06-01", override: "2025-10-01", role: "owner", enabled: true, termination: null },
    { hireDate: "2026-08-16", override: null, role: "staff", enabled: false, termination: null },
    { hireDate: "2026-03-16", override: null, role: "staff", enabled: true, termination: "2026-06-29" },
    { hireDate: null, override: null, role: "staff", enabled: true, termination: null },
    { hireDate: "2025-09-06", override: null, role: "master", enabled: false, termination: null },
  ];
  const contracts = [
    { id: 1, payType: "monthly", calculationBasis: "minute", baseSalary: 7_500_000, fixedRaiseAmount: 500_000, standardWorkdays: 26, standardMinutesPerDay: 540 },
    { id: 2, payType: "hourly", calculationBasis: "minute", baseSalary: 35_000, fixedRaiseAmount: 0, standardWorkdays: 26, standardMinutesPerDay: 540 },
    { id: 3, payType: "monthly", calculationBasis: "fixed_monthly", baseSalary: 20_000_000, fixedRaiseAmount: 2_000_000, standardWorkdays: 26, standardMinutesPerDay: 540 },
  ];
  let compared = 0;
  for (const c of cases) {
    for (const asOf of ["2026-07-01", "2026-08-15", "2026-09-30", "2026-10-31", "2026-11-10", "2027-03-01"]) {
      const input = { role: c.role, levelProgramEnabled: c.enabled, hireDate: c.hireDate, levelBaseDateOverride: c.override, terminationDate: c.termination, asOfDate: asOf };
      const before = oldCalc.calculateEmployeeLevel(input);
      // Callers now pass the mode/raise fields from legacy versions as null/true.
      const after = calculateEmployeeLevel({ ...input, levelBaseMode: null, salaryRaiseEnabled: true });
      assert.deepStrictEqual(after, before);
      assert.equal(stablePayrollSourceHash(after), stablePayrollSourceHash(before));
      for (const contract of contracts) {
        assert.deepStrictEqual(calculateCombinedSalary(contract as never, after), oldComp.calculateCombinedSalary(contract, before));
      }
      compared++;
    }
  }
  assert.equal(compared, 42);
  // A legacy version row serializes without any new key (sourceSnapshot hash unchanged).
  const row = { id: 1, user_id: 6, enabled: true, effective_from: "2026-08-01", effective_to: null, base_date: "2026-01-03", base_date_mode: "override", salary_raise_enabled: true, revision: 2 };
  assert.deepStrictEqual(serializeEmployeeLevelProgramVersion(row),
    { id: 1, enabled: true, effectiveFrom: "2026-08-01", effectiveTo: null, baseDate: "2026-01-03", baseDateMode: "override", revision: 2 });
  assert.deepStrictEqual(levelUserFieldsFromVersion(serializeEmployeeLevelProgramVersion(row)),
    { level_program_enabled: true, level_base_date_override: "2026-01-03", level_base_mode: null, level_salary_raise_enabled: true });
  assert.equal(levelUserFieldsFromVersion(serializeEmployeeLevelProgramVersion({ ...row, base_date_mode: "hire_date", base_date: "2025-11-02" })).level_base_date_override, null);
});

test("hire_month history is fixed by the stored version month: hire-date edits and rehires never rewrite past levels", () => {
  const stored = (baseDate: string) => levelUserFieldsFromVersion(serializeEmployeeLevelProgramVersion({
    id: 1, user_id: 1, enabled: true, effective_from: "2026-11-01", effective_to: null, base_date: baseDate, base_date_mode: "hire_month", revision: 1,
  }));
  const at = (fields: ReturnType<typeof stored>, hireDate: string, asOf: string) => calculateEmployeeLevel({
    role: "staff", hireDate, levelBaseDateOverride: fields.level_base_date_override, levelBaseMode: fields.level_base_mode, asOfDate: asOf,
  });
  // Saved with hire date 2026-11-15 -> base 2026-11. Editing the hire date to 11-16 (or a
  // rehire moving it to 2027-05-20) leaves the version's levels unchanged.
  const v = stored("2026-11-01");
  for (const hireDate of ["2026-11-15", "2026-11-16", "2027-05-20"]) {
    assert.equal(at(v, hireDate, "2027-02-01").level, 1, hireDate);
    assert.equal(at(v, hireDate, "2027-02-01").baseMonth, "2026-11", hireDate);
  }
  // Before the fix the month was re-derived from the current hire date (11-16 -> Lv.0).
  assert.equal(calculateEmployeeLevel({ role: "staff", hireDate: "2026-11-16", levelBaseDateOverride: null, levelBaseMode: "hire_month", asOfDate: "2027-02-01" }).level, 0);
  // A new version saved after the edit carries 2026-12 and applies only from its month.
  assert.equal(at(stored("2026-12-01"), "2026-11-16", "2027-03-01").level, 1);
  assert.equal(at(stored("2026-12-01"), "2026-11-16", "2027-02-28").level, 0);
});

test("11: level OFF and hourly part-timers keep their pay; a monthly part-timer can keep the level without the raise", () => {
  const hourly = { payType: "hourly", calculationBasis: "minute", baseSalary: 35_000, fixedRaiseAmount: 0 } as never;
  for (const raise of [true, false]) {
    const on = level({ hireDate: "2026-08-16", mode: "hire_month", asOf: "2027-06-01", raise });
    assert.ok(on.eligible && (on.earnedRaiseCount ?? 0) > 0);
    assert.deepEqual(calculateCombinedSalary(hourly, on), { contractSalary: 35_000, fixedRaiseAmount: 0, levelRaiseAmount: 0, combinedSalary: 35_000, additionalRaiseCount: 0 });
  }
  const off = calculateEmployeeLevel({ role: "staff", levelProgramEnabled: false, hireDate: "2026-09-17", levelBaseDateOverride: null, asOfDate: "2027-06-01" });
  assert.equal(calculateCombinedSalary(hourly, off).combinedSalary, 35_000);
  // Monthly part-timer on the level program without the raise: 0₫ applied, level still shown.
  const monthly = { payType: "monthly", calculationBasis: "fixed_monthly", baseSalary: 2_000_000, fixedRaiseAmount: 0 } as never;
  const noRaise = level({ hireDate: "2025-12-01", mode: "hire_month", asOf: "2026-11-10", raise: false });
  assert.equal(noRaise.level, 3);
  assert.equal(noRaise.salaryRaiseEnabled, false);
  assert.deepEqual(calculateCombinedSalary(monthly, noRaise), { contractSalary: 2_000_000, fixedRaiseAmount: 0, levelRaiseAmount: 0, combinedSalary: 2_000_000, additionalRaiseCount: 0, levelRaiseExcluded: "salary_raise_disabled" });
});

test("12: special raise and level raise are counted once each", () => {
  const khoi = { payType: "monthly", calculationBasis: "minute", baseSalary: 7_500_000, fixedRaiseAmount: 500_000 } as never;
  const lv1 = level({ hireDate: "2026-04-01", mode: "hire_month", asOf: "2026-07-01" });
  assert.deepEqual(calculateCombinedSalary(khoi, lv1), { contractSalary: 7_500_000, fixedRaiseAmount: 500_000, levelRaiseAmount: 500_000, combinedSalary: 8_500_000, additionalRaiseCount: 1 });
  const lv2 = level({ hireDate: "2026-04-01", mode: "hire_month", asOf: "2026-10-01" });
  assert.equal(calculateCombinedSalary(khoi, lv2).combinedSalary, 9_000_000);
  // Raise disabled: only the special raise remains.
  assert.equal(calculateCombinedSalary(khoi, level({ hireDate: "2026-04-01", mode: "hire_month", asOf: "2026-10-01", raise: false })).combinedSalary, 8_000_000);
});

test("payment data is never written by this change", () => {
  const changed = execFileSync("git", ["diff", "--name-only", BASE_COMMIT, "--", "lib", "app", "components"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of changed) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /from\("payroll_employee_payments"\)\.(update|insert|upsert|delete)/, file);
  }
  const draft = readFileSync("docs/sql/employee-level-month-base-v1-draft.sql", "utf8").replace(/--.*$/gm, "");
  assert.doesNotMatch(draft, /payroll_employee_payments|payroll_payment_batches|calculation_snapshot|calculation_hash/);
  assert.doesNotMatch(draft, /update public\.employee_level_program_versions\s+set base_date = date_trunc/);
});
