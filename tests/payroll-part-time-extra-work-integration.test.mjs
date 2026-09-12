import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

// Execute the real payroll engine and its local dependencies. Any attempted
// Supabase access fails immediately, keeping these regression tests offline.
const nativeRequire = createRequire(import.meta.url);
const modules = new Map();
function load(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const loadedModule = { exports: {} };
  modules.set(path, loadedModule);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => {
    if (name === "server-only") return {};
    if (name === "@/lib/supabase/server") return {
      supabaseServer: new Proxy({}, { get() { throw new Error("DB access forbidden in local payroll tests"); } }),
    };
    if (name.startsWith("@/")) return load(resolve(name.slice(2) + ".ts"));
    if (name.startsWith(".")) return load(resolve(dirname(path), name.endsWith(".ts") ? name : name + ".ts"));
    return nativeRequire(name);
  };
  new Function("require", "module", "exports", code)(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const { calculatePayrollBatch } = load(resolve("lib/payroll/monthly-run.ts"));
const { partTimeExtraWorkSourceHash } = load(resolve("lib/payroll/part-time-extra-work.ts"));
function batch(start, end, decision, fixed = false) {
  const date = "2026-09-04";
  const input = {
    month: "2026-09", dates: [date],
    users: [{ id: 7, name: "Thiết", username: "local", role: "staff", is_active: true,
      is_system_account: false, hire_date: "2026-01-01", termination_date: null,
      payroll_eligible_override: true, level_program_enabled: false, level_base_date_override: null }],
    attendance: [{ id: 101, user_id: 7, status: "done", work_date: date,
      check_in_at: `${date}T${start}:00+07:00`, check_out_at: `2026-09-${end < start ? "05" : "04"}T${end}:00+07:00`,
      approval_status: "approved", late_minutes: 0, early_leave_minutes: 0, work_minutes: 300, updated_at: null }],
    contracts: [{ id: 11, userId: 7, payType: fixed ? "monthly" : "hourly", calculationBasis: fixed ? "fixed_monthly" : "minute",
      baseSalary: fixed ? 9_100_000 : 35_000, fixedRaiseAmount: 0, standardWorkdays: 26, standardMinutesPerDay: 300,
      timeBlockMinutes: 1, roundingMode: "none", lateAdjustmentMode: "separate", earlyLeaveAdjustmentMode: "separate",
      overtimeMode: "requires_approval", paidLeaveMode: "unpaid", effectiveFrom: "2026-01-01", effectiveTo: null, revision: 3 }],
    schedules: [{ id: 21, userId: 7, startTime: "18:00", endTime: "23:00", unpaidBreakMinutes: 0,
      effectiveFrom: "2026-01-01", effectiveTo: null, revision: 4 }],
    lateNormalizedRecordIds: new Set(), settingsByDate: new Map(),
    extraWorkSettingsByDate: new Map([[date, { id: 31, revision: 5, openTime: "16:00", closeTime: "01:00" }]]),
    holidayPremiumByDate: new Map(), decisionsByAttendanceId: new Map(decision ? [[101, decision]] : []),
    insuranceVersionsByUser: new Map(), insuranceGlobal: { employeeRateBp: 0, employerRateBp: 0, directorEnabled: false },
    penaltySettings: { lateMajorThresholdMinutes: 20, lateMinorPenaltyMinutes: 60, lateMajorPenaltyRateBp: 5000, unauthorizedAbsencePenaltyDays: 3 },
  };
  const [employee] = calculatePayrollBatch(input);
  assert.ok(employee);
  assert.ok(!employee.reviews.some(row => row.warningCode === "CALCULATION_FAILED"), JSON.stringify(employee.reviews));
  return employee;
}
const decision = sourceHash => ({ id: 1, attendanceRecordId: 101, decision: "approved", sourceHash, decidedBy: 1, decidedAt: "2026-09-09T00:00:00Z", decisionReason: null });
const additions = row => row.items.filter(item => item.category === "part_time_extra_work");

test("monthly engine omits disappeared legacy approved candidates and extra-work reviews", () => {
  for (const [start, end] of [["16:06", "23:04"], ["16:03", "23:03"], ["17:00", "23:20"], ["16:00", "23:00"]]) {
    const employee = batch(start, end, decision("legacy-source"));
    assert.deepEqual(employee.partTimeExtraWork, []);
    assert.deepEqual(additions(employee), []);
    assert.ok(!employee.reviews.some(row => row.warningCode.startsWith("PART_TIME_EXTRA_WORK")));
  }
});

test("monthly engine blocks the legacy 65-minute approval and pays only a newly matched 60-minute decision", () => {
  const pending = batch("17:55", "00:00").partTimeExtraWork[0];
  const legacy = decision(partTimeExtraWorkSourceHash({ ...pending.sourceSnapshot, candidateMinutes: 65, candidateAmount: 37_917 }));
  const stale = batch("17:55", "00:00", legacy);
  assert.equal(stale.partTimeExtraWork[0].status, "stale");
  assert.deepEqual(additions(stale), []);
  assert.ok(stale.reviews.some(row => row.warningCode === "PART_TIME_EXTRA_WORK_DECISION_STALE" && row.reviewLevel === "blocking"));
  const approved = batch("17:55", "00:00", decision(pending.sourceHash));
  assert.equal(additions(approved).length, 1);
  assert.equal(additions(approved)[0].amount, 35_000);
  assert.equal(additions(approved)[0].sourceSnapshot.beforeScheduleMinutes, 5);
  assert.equal(additions(approved)[0].sourceSnapshot.candidateMinutes, 60);
});

test("fixed-monthly payroll excludes extra work even with an approval", () => {
  const employee = batch("16:00", "00:00", decision("legacy-source"), true);
  assert.deepEqual(employee.partTimeExtraWork, []);
  assert.deepEqual(additions(employee), []);
});

test("local DB compatibility migration preserves legacy rows and accepts after-only audit snapshots", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table payroll_part_time_extra_work_decisions (
      candidate_minutes integer, before_schedule_minutes integer, after_schedule_minutes integer,
      cancelled_at timestamptz,
      constraint payroll_part_time_extra_work_minutes_check check (candidate_minutes = before_schedule_minutes + after_schedule_minutes)
    ); insert into payroll_part_time_extra_work_decisions values (65, 5, 60, null), (118, 114, 4, null);`);
    await db.exec(readFileSync(resolve("supabase/migrations/20260912070744_fix_extra_work_after_schedule_compatibility.sql"), "utf8"));
    assert.equal((await db.query("select count(*)::int as count from payroll_part_time_extra_work_decisions")).rows[0].count, 2);
    await db.exec("insert into payroll_part_time_extra_work_decisions values (60, 5, 60, null); update payroll_part_time_extra_work_decisions set cancelled_at = now() where candidate_minutes = 65;");
    await assert.rejects(db.exec("insert into payroll_part_time_extra_work_decisions values (64, 5, 60, null)"), /payroll_part_time_extra_work_minutes_check/);
    assert.deepEqual((await db.query("select candidate_minutes from payroll_part_time_extra_work_decisions order by candidate_minutes")).rows.map(row => row.candidate_minutes), [60, 65, 118]);
  } finally { await db.close(); }
});
