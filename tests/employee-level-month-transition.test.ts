import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { employeeLevelMonthCandidate } from "../lib/employee-level/month-transition.ts";
import { calculateEmployeeLevel } from "../lib/employee-level/calculate.ts";
import { isEmployedOn } from "../lib/employment/eligibility.ts";

for (const [hireDate, month, firstPromotion] of [
  ["2025-11-02", "2025-11", "2026-02-01"],
  ["2025-11-03", "2025-11", "2026-02-01"],
  ["2025-11-16", "2025-12", "2026-03-01"],
] as const) {
  test(`legacy ${hireDate}: month candidate promotes on ${firstPromotion} without changing employment`, () => {
    const input = Object.freeze({ mode: "hire_date" as const, baseDate: hireDate, hireDate });
    const candidate = employeeLevelMonthCandidate(input);
    assert.deepEqual(candidate, { mode: "hire_month", baseMonth: month });
    const common = { role: "staff", hireDate, levelBaseMode: candidate.mode, levelBaseDateOverride: `${candidate.baseMonth}-01` };
    assert.equal(calculateEmployeeLevel({ ...common, asOfDate: firstPromotion }).level, 1);
    const prior = new Date(`${firstPromotion}T00:00:00Z`);
    prior.setUTCDate(prior.getUTCDate() - 1);
    assert.equal(calculateEmployeeLevel({ ...common, asOfDate: prior.toISOString().slice(0, 10) }).level, 0);
    assert.equal(isEmployedOn({ hire_date: hireDate, termination_date: null }, "2025-11-01"), false);
    assert.equal(input.hireDate, hireDate);
  });
}

test("legacy Lv.4 stays Lv.4 while next promotion moves from Feb 2 to Feb 1", () => {
  const common = { role: "staff", hireDate: "2025-11-02", asOfDate: "2026-12-01" };
  const old = calculateEmployeeLevel({ ...common, levelBaseDateOverride: null, levelHireDateBase: "2025-11-02" });
  const candidate = employeeLevelMonthCandidate({ mode: "hire_date", baseDate: old.baseDate, hireDate: common.hireDate });
  const next = calculateEmployeeLevel({ ...common, levelBaseMode: candidate.mode, levelBaseDateOverride: `${candidate.baseMonth}-01` });
  assert.deepEqual([old.level, next.level, old.nextLevelDate, next.nextLevelDate], [4, 4, "2027-02-02", "2027-02-01"]);
});

test("legacy override preserves its month; missing bases remain invalid rather than guessed", () => {
  assert.deepEqual(employeeLevelMonthCandidate({ mode: "override", baseDate: "2026-01-03", hireDate: "2025-12-03" }), { mode: "override_month", baseMonth: "2026-01" });
  assert.deepEqual(employeeLevelMonthCandidate({ mode: "override", baseDate: null, hireDate: "2025-12-03" }), { mode: "override_month", baseMonth: "" });
  assert.deepEqual(employeeLevelMonthCandidate({ mode: "hire_date", baseDate: "2025-11-02", hireDate: "2025-12-16" }), { mode: "hire_month", baseMonth: "2026-01" });
});

test("API forbids legacy mutations and same-month legacy overwrites before calling v10", () => {
  const source = readFileSync("app/api/admin/users/route.ts", "utf8");
  const rpc = source.indexOf('"employee_update_profile_and_level_v10"');
  for (const code of ["LEVEL_MONTH_BASE_REQUIRED", "LEVEL_MONTH_TRANSITION_CONFLICT"]) {
    assert.ok(source.indexOf(code) > 0 && source.indexOf(code) < rpc);
  }
  assert.match(source, /comparisonVersion\?\.effectiveFrom === requestedEffectiveFrom/);
  assert.match(source, /levelPolicyChanged && !isEmployeeLevelMonthBaseMode\(requestedBaseDateMode\)/);
});
