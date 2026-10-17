import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";


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
function batch(start, end, decision, fixed = false, options = {}) {
  const date = options.date ?? "2026-09-04";
  const nextDate = new Date(`${date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const userId = options.userId ?? 7;
  const attendanceRecordId = options.attendanceRecordId ?? 101;
  const input = {
    month: date.slice(0, 7), dates: [date],
    users: [{ id: userId, name: "Thiết", username: "local", role: "staff", is_active: true,
      is_system_account: false, hire_date: "2026-01-01", termination_date: null,
      payroll_eligible_override: true, level_program_enabled: false, level_base_date_override: null }],
    attendance: [{ id: attendanceRecordId, user_id: userId, status: "done", work_date: date,
      check_in_at: `${date}T${start}:00+07:00`, check_out_at: `${end < start ? nextDate.toISOString().slice(0, 10) : date}T${end}:00+07:00`,
      approval_status: "approved", late_minutes: 0, early_leave_minutes: 0, work_minutes: 300, updated_at: null }],
    contracts: [{ id: 11, userId, payType: options.payType ?? (fixed ? "monthly" : "hourly"), calculationBasis: fixed ? "fixed_monthly" : "minute",
      baseSalary: options.baseSalary ?? (fixed ? 9_100_000 : 35_000), fixedRaiseAmount: 0, standardWorkdays: 26, standardMinutesPerDay: options.standardMinutesPerDay ?? 300,
      timeBlockMinutes: 1, roundingMode: "none", lateAdjustmentMode: "separate", earlyLeaveAdjustmentMode: "separate",
      overtimeMode: "requires_approval", paidLeaveMode: "unpaid", effectiveFrom: "2026-01-01", effectiveTo: null, revision: 3 }],
    schedules: [{ id: 21, userId, startTime: options.scheduleStartTime ?? "18:00", endTime: options.scheduleEndTime ?? "23:00", unpaidBreakMinutes: 0,
      effectiveFrom: "2026-01-01", effectiveTo: null, revision: 4 }],
    lateNormalizedRecordIds: new Set(), settingsByDate: new Map(),
    extraWorkSettingsByDate: new Map([[date, { id: 31, revision: 5, openTime: "16:00", closeTime: "01:00" }]]),
    holidayPremiumByDate: new Map(), decisionsByAttendanceId: new Map(decision ? [[attendanceRecordId, decision]] : []),
    insuranceVersionsByUser: new Map(), insuranceGlobal: { employeeRateBp: 0, employerRateBp: 0, directorEnabled: false },
    penaltySettings: { lateMajorThresholdMinutes: 20, lateMinorPenaltyMinutes: 60, lateMajorPenaltyRateBp: 5000, unauthorizedAbsencePenaltyDays: 3 },
  };
  options.configure?.(input);
  const [employee] = calculatePayrollBatch(input);
  assert.ok(employee);
  assert.ok(!employee.reviews.some(row => row.warningCode === "CALCULATION_FAILED"), JSON.stringify(employee.reviews));
  return employee;
}
const decision = sourceHash => ({ id: 1, attendanceRecordId: 101, decision: "approved", sourceHash, decidedBy: 1, decidedAt: "2026-09-09T00:00:00Z", decisionReason: null });
const additions = row => row.items.filter(item => item.category === "part_time_extra_work");

const { calculatePartTimeExtraWork, partTimeExtraWorkDecisionEffect } = load(resolve("lib/payroll/part-time-extra-work.ts"));
const october = (start, end, date = "2026-10-01") => ({
  payType: "hourly", attendanceRecordId: 101, userId: 7, businessDate: date,
  checkInAt: `${date}T${start}:00+07:00`,
  checkOutAt: `${end < start ? new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : date}T${end}:00+07:00`,
  contractId: 11, contractRevision: 3, minuteRateAmount: 35_000 / 60, hourlyRateAmount: 35_000,
  scheduleId: 21, scheduleRevision: 4, scheduleStartTime: "18:00", scheduleEndTime: "23:00",
  storeSettingId: 31, storeSettingRevision: 5, storeOpenTime: "16:00", storeCloseTime: "01:00",
});

test("October hourly/daily combine early and late minutes before the daily threshold", () => {
  for (const payType of ["hourly", "daily"]) {
    for (const [start, end, minutes] of [["17:40", "23:09", 0], ["17:45", "23:15", 30],
      ["17:30", "23:00", 30], ["17:00", "23:20", 80], ["15:30", "01:30", 240]]) {
      const candidate = calculatePartTimeExtraWork({ ...october(start, end), payType });
      if (!minutes) { assert.equal(candidate, null); continue; }
      assert.equal(candidate.candidateMinutes, minutes);
      assert.equal(candidate.candidateAmount, Math.round(minutes * 35_000 / 60));
      assert.equal(candidate.sourceSnapshot.extraWorkPolicy, "part-time-open-early-v1");
      assert.equal(candidate.sourceSnapshot.payType, payType);
      assert.equal(partTimeExtraWorkDecisionEffect(candidate).amount, 0);
    }
  }
});

test("early work begins at opening, excludes unworked time, and late work stops at close", () => {
  const opening = calculatePartTimeExtraWork(october("15:30", "23:00"));
  assert.equal(opening.beforeScheduleMinutes, 120);
  assert.equal(opening.excludedBeforeOpenMinutes, 30);
  const leftBeforeShift = calculatePartTimeExtraWork(october("16:00", "17:00"));
  assert.equal(leftBeforeShift.candidateMinutes, 60);
  assert.equal(calculatePartTimeExtraWork(october("15:00", "15:59")), null);
  assert.equal(calculatePartTimeExtraWork({ ...october("16:00", "23:15"), storeOpenTime: "17:45" }).candidateMinutes, 30);
  assert.equal(calculatePartTimeExtraWork({ ...october("16:00", "23:15"), storeOpenTime: "18:00" }), null);
  const capped = calculatePartTimeExtraWork({ ...october("15:30", "02:30"), scheduleEndTime: "01:00" });
  assert.equal(capped.candidateMinutes, 120);
  assert.equal(capped.afterScheduleMinutes, 0);
  assert.equal(capped.excludedAfterCloseMinutes, 90);
});

test("monthly keeps after-only work and next-day 03:00 cutoff in October", () => {
  const input = { ...october("15:30", "02:30"), payType: "monthly", scheduleEndTime: "01:00" };
  assert.equal(calculatePartTimeExtraWork(input).candidateMinutes, 90);
  assert.equal(calculatePartTimeExtraWork(input).sourceSnapshot.extraWorkPolicy, undefined);
  const capped = calculatePartTimeExtraWork({ ...input, checkOutAt: "2026-10-02T03:30:00+07:00" });
  assert.equal(capped.candidateMinutes, 120);
  assert.equal(capped.excludedAfterCloseMinutes, 30);
});

test("approval becomes stale after rates, hours, schedules or attendance change", () => {
  const input = october("17:00", "23:40");
  const candidate = calculatePartTimeExtraWork(input);
  const approval = decision(candidate.sourceHash);
  assert.equal(calculatePartTimeExtraWork({ ...input, decision: approval }).status, "approved");
  for (const change of [
    { minuteRateAmount: 40_000 / 60, hourlyRateAmount: 40_000, contractRevision: 4 },
    { scheduleStartTime: "17:40", scheduleRevision: 5 },
    { storeOpenTime: "17:40", storeSettingRevision: 6 },
    { checkInAt: "2026-10-01T17:01:00+07:00" },
  ]) {
    const changed = calculatePartTimeExtraWork({ ...input, ...change, decision: approval });
    assert.equal(changed.status, "stale");
    assert.equal(partTimeExtraWorkDecisionEffect(changed).amount, 0);
  }
  const { extraWorkPolicy, payType, ...oldSnapshot } = candidate.sourceSnapshot;
  assert.ok(extraWorkPolicy && payType);
  assert.notEqual(candidate.sourceHash, partTimeExtraWorkSourceHash(oldSnapshot));
});

test("October engine adds exactly one approved item; rejection and cancellation add none", () => {
  const options = { date: "2026-10-01" };
  const pending = batch("17:45", "23:15", null, false, options);
  assert.equal(pending.partTimeExtraWork[0].candidateMinutes, 30);
  assert.deepEqual(additions(pending), []);
  const approval = decision(pending.partTimeExtraWork[0].sourceHash);
  for (let i = 0; i < 2; i++) {
    const approved = batch("17:45", "23:15", approval, false, options);
    assert.equal(additions(approved).length, 1);
    assert.equal(additions(approved)[0].amount, 17_500);
    assert.equal(additions(approved)[0].sourceSnapshot.extraWorkPolicy, "part-time-open-early-v1");
    assert.deepEqual(approved.items.filter(i => i.category !== "part_time_extra_work"), pending.items);
  }
  assert.deepEqual(additions(batch("17:45", "23:15", null, false, options)), []);
  assert.deepEqual(additions(batch("17:45", "23:15", { ...approval, decision: "rejected" }, false, options)), []);
});

test("early and late extra-work approval preserve early-leave and late penalties", () => {
  for (const [start, end, category] of [["17:00", "22:40", "early_leave_deduction"], ["18:10", "23:40", "late_deduction"]]) {
    const options = { date: "2026-10-01" };
    const pending = batch(start, end, null, false, options);
    const approved = batch(start, end, decision(pending.partTimeExtraWork[0].sourceHash), false, options);
    const penalties = pending.items.filter(i => i.category === category);
    assert.equal(penalties.length, 1);
    assert.ok(penalties[0].amount > 0);
    assert.deepEqual(approved.items.filter(i => i.category === category), penalties);
    assert.deepEqual(approved.items.filter(i => i.category === "base_work"), pending.items.filter(i => i.category === "base_work"));
  }
});

test("closed days, leave, absence, incomplete attendance and fixed monthly produce no candidates", () => {
  for (const configure of [
    input => { input.extraWorkSettingsByDate.clear(); },
    input => { input.attendance[0].status = "leave"; },
    input => { input.attendance[0].status = "unauthorized_absence"; },
    input => { input.attendance[0].check_out_at = null; },
    input => { input.attendance = []; },
  ]) {
    const employee = batch("16:00", "23:40", null, false, { date: "2026-10-01", configure });
    assert.deepEqual(employee.partTimeExtraWork, []);
    assert.deepEqual(additions(employee), []);
  }
  assert.deepEqual(batch("16:00", "23:40", null, true, { date: "2026-10-01" }).partTimeExtraWork, []);
});

test("engine uses dated rates and changed opening time on each business day", () => {
  const configure = input => {
    const secondDate = "2026-10-02";
    input.dates.push(secondDate);
    input.attendance.push({ ...input.attendance[0], id: 102, work_date: secondDate,
      check_in_at: `${secondDate}T17:00:00+07:00`, check_out_at: `${secondDate}T23:00:00+07:00` });
    input.contracts[0].effectiveTo = secondDate;
    input.contracts.push({ ...input.contracts[0], id: 12, revision: 4, baseSalary: 42_000, effectiveFrom: secondDate, effectiveTo: null });
    input.extraWorkSettingsByDate.set(secondDate, { id: 32, revision: 6, openTime: "17:30", closeTime: "01:00" });
  };
  const employee = batch("17:00", "23:00", null, false, { date: "2026-10-01", configure });
  assert.deepEqual(employee.partTimeExtraWork.map(row => [row.businessDate, row.candidateMinutes, row.candidateAmount, row.contractRevision, row.storeSettingRevision]),
    [["2026-10-01", 60, 35_000, 3, 5], ["2026-10-02", 30, 21_000, 4, 6]]);
});

test("historical and monthly candidate JSON and hashes match the previous calculator byte for byte", () => {
  const currentSource = readFileSync("lib/payroll/part-time-extra-work.ts", "utf8");
  const previousSource = currentSource.replace(
    "const candidateMinutes = afterScheduleMinutes + (includeEarlyWork ? beforeScheduleMinutes : 0);",
    "const candidateMinutes = afterScheduleMinutes;").replace(
    "...(includeEarlyWork ? { extraWorkPolicy: PART_TIME_EARLY_EXTRA_WORK_POLICY, payType } : {}),", "");
  const oldModule = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(previousSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(nativeRequire, oldModule, oldModule.exports);
  for (const date of ["2026-08-01", "2026-09-04", "2026-09-30", "2026-10-01"]) {
    for (const payType of ["hourly", "daily", "monthly"]) {
      if (date >= "2026-10-01" && payType !== "monthly") continue;
      for (const [start, end] of [["16:00", "23:04"], ["17:55", "00:00"], ["15:30", "02:30"]]) {
        const input = { ...october(start, end, date), payType };
        const before = oldModule.exports.calculatePartTimeExtraWork(input);
        const after = calculatePartTimeExtraWork(input);
        assert.equal(JSON.stringify(after), JSON.stringify(before));
        if (before) {
          const approval = decision(before.sourceHash);
          assert.equal(calculatePartTimeExtraWork({ ...input, decision: approval }).status, "approved");
        }
      }
    }
  }
});


test("October approval propagates through payment snapshot and accounting source export hashes", () => {
  const { buildEmployeePaymentSnapshot, payrollPaymentSnapshotHash } = load(resolve("lib/payroll/payment-snapshot.ts"));
  const { buildPayrollSourceExport } = load(resolve("lib/payroll/source-export/build-export.ts"));
  const options = { date: "2026-10-01" };
  const pending = batch("17:45", "23:15", null, false, options);
  const approval = decision(pending.partTimeExtraWork[0].sourceHash);
  const approved = batch("17:45", "23:15", approval, false, options);
  const rejected = batch("17:45", "23:15", { ...approval, decision: "rejected" }, false, options);
  const employee = raw => ({ userId: 7, name: "Local fixture", contract: raw.contractSnapshot[0],
    levelInfo: { level: 0 }, amounts: { levelRaiseAmount: 0, partTimeExtraWorkAmount: additions(raw).reduce((sum,i)=>sum+i.amount,0) },
    tax: { status: "calculated" }, adjustments: [], automaticPenalties: [], partTimeExtraWork: raw.partTimeExtraWork });
  const snapshots = [pending, approved, rejected].map(raw => buildEmployeePaymentSnapshot(employee(raw), raw, { engineVersion: "monthly-payroll-v12" }));
  assert.equal(snapshots[1].partTimeExtraWorkSnapshot[0].candidateMinutes, 30);
  assert.equal(snapshots[1].automaticItemsSnapshot.find(i=>i.category==="part_time_extra_work").amount, 17_500);
  assert.equal(new Set(snapshots.map(payrollPaymentSnapshotHash)).size, 3);
  const exports = [pending, approved, rejected].map(raw => buildPayrollSourceExport({ month: "2026-10",
    overview: { period: { asOfDate: "2026-10-01" }, employees: [employee(raw)], rawByUser: new Map([[7,raw]]),
      adjustmentLedgerByUser: new Map(), snapshot: { context: { attendance: [] }, sourceSnapshot: {} } },
    mealAllowance: { currentByUser: [] }, generatedAt: "2026-10-17T00:00:00Z" }));
  assert.equal(exports[0].employees[0].extraWork.pendingCount, 1);
  assert.deepEqual(exports[0].employees[0].extraWork.approvedPartTime, []);
  assert.deepEqual(exports[2].employees[0].extraWork.approvedPartTime, []);
  const exported = exports[1].employees[0].extraWork.approvedPartTime;
  assert.equal(exported.length, 1);
  assert.equal(exported[0].approvedMinutes, 30);
  assert.equal(exported[0].referenceAmount, 17_500);
  assert.equal(exported[0].sourceHash, approved.partTimeExtraWork[0].sourceHash);
  assert.equal(new Set(exports.map(row => row.employees[0].sourceHash)).size, 3);
  assert.equal(new Set(exports.map(row => row.sourceHash)).size, 3);
});


test("03:00 business cutoff keeps after-midnight early work on the assigned business day", () => {
  const { calculateStoreBusinessDate } = load(resolve("lib/store-settings/business-time-core.ts"));
  assert.equal(calculateStoreBusinessDate("2026-10-01T02:59:59+07:00"), "2026-09-30");
  assert.equal(calculateStoreBusinessDate("2026-10-01T03:00:00+07:00"), "2026-10-01");
  const candidate = calculatePartTimeExtraWork({ ...october("23:45", "01:00"),
    scheduleStartTime: "00:30", scheduleEndTime: "01:00" });
  assert.equal(candidate.businessDate, "2026-10-01");
  assert.equal(candidate.beforeScheduleMinutes, 45);
  assert.equal(candidate.afterScheduleMinutes, 0);
  assert.equal(candidate.candidateMinutes, 45);
  assert.equal(candidate.candidateAmount, 26_250);
});

