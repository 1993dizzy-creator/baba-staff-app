import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addCalendarMonthsClamped, calculateEmployeeLevel } from "../lib/employee-level/calculate.ts";

const page = readFileSync("app/(protected)/admin/users/page.tsx", "utf8");
const view = page.slice(page.indexOf("function LevelHistoryView("), page.indexOf("/** Current policy stays compact"));

test("level timeline uses the base the current policy counts from, without cutting a legacy day to the month start", () => {
  assert.match(view, /const base = currentInfo\.baseDate \?\? null;/);
  assert.doesNotMatch(view, /baseDate\.slice\(0, 7\) \+ "-01"/);
  // Milestones are still base + 3-month steps; phases still come from the calculated current level.
  assert.match(view, /addCalendarMonthsClamped\(base, index \* 3\)/);
  assert.match(view, /if \(active && currentInfo\.level !== null\)/);
});

test("legacy exact-day base: timeline milestones equal the engine's level dates; month bases are unchanged", () => {
  const milestones = (base: string) => Array.from({ length: 3 }, (_, i) => addCalendarMonthsClamped(base, i * 3));
  // Thiết's current OFF legacy version (hire_date base 2026-08-16): the engine counts from the 16th.
  const legacy = calculateEmployeeLevel({ role: "staff", hireDate: "2026-08-16", terminationDate: null, isSystemAccount: false,
    levelProgramEnabled: true, levelBaseDateOverride: null, levelBaseMode: null, levelHireDateBase: "2026-08-16", asOfDate: "2026-09-01" });
  assert.equal(legacy.baseDate, "2026-08-16");
  assert.equal(legacy.nextLevelDate, "2026-11-16");
  assert.deepEqual(milestones(legacy.baseDate!), ["2026-08-16", "2026-11-16", "2027-02-16"]);
  // Month mode (the corrected ON versions): base is already the 1st, so the schedule is the same as before.
  const month = calculateEmployeeLevel({ role: "staff", hireDate: "2026-08-16", terminationDate: null, isSystemAccount: false,
    levelProgramEnabled: true, levelBaseDateOverride: "2026-09-01", levelBaseMode: "hire_month", asOfDate: "2026-11-15" });
  assert.equal(month.baseDate, "2026-09-01");
  assert.deepEqual(milestones(month.baseDate!), ["2026-09-01", "2026-12-01", "2027-03-01"]);
  assert.equal(month.nextLevelDate, "2026-12-01");
});
