import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculatePartTimeExtraWork, EXTRA_WORK_MINIMUM_CANDIDATE_MINUTES, isExtraWorkEligible, partTimeExtraWorkDecisionEffect, partTimeExtraWorkSourceHash } from "../lib/payroll/part-time-extra-work.ts";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculatePayrollRates } from "../lib/payroll/work-policy.ts";
import type { PayrollContract } from "../lib/payroll/types.ts";

const at = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`).toISOString();
const base = (actualStart: string, actualEnd: string) => ({
  attendanceRecordId: 101, userId: 7, businessDate: "2026-08-01",
  checkInAt: at("2026-08-01", actualStart), checkOutAt: at(actualEnd < actualStart ? "2026-08-02" : "2026-08-01", actualEnd),
  contractId: 11, contractRevision: 3, minuteRateAmount: 35_000 / 60, hourlyRateAmount: 35_000,
  scheduleId: 21, scheduleRevision: 4, scheduleStartTime: "18:00", scheduleEndTime: "23:00",
  storeSettingId: 31, storeSettingRevision: 5, storeOpenTime: "16:00", storeCloseTime: "01:00",
});

test("part-time extra work clips actual work to store hours and excludes the personal schedule", () => {
  assert.equal(calculatePartTimeExtraWork(base("18:00", "23:00")), null);
  const until0030 = calculatePartTimeExtraWork(base("16:00", "00:30"))!;
  assert.deepEqual([until0030.beforeScheduleMinutes, until0030.afterScheduleMinutes, until0030.candidateMinutes], [120, 90, 210]);
  const outside = calculatePartTimeExtraWork(base("15:30", "01:30"))!;
  assert.deepEqual([outside.candidateMinutes, outside.excludedBeforeOpenMinutes, outside.excludedAfterCloseMinutes], [240, 30, 30]);
  assert.equal(calculatePartTimeExtraWork(base("17:45", "23:10")), null);
});

test("hourly, daily, and monthly attendance-based contracts are eligible, but fixed monthly is excluded", () => {
  assert.equal(isExtraWorkEligible({ payType: "hourly", calculationBasis: "minute" }), true);
  assert.equal(isExtraWorkEligible({ payType: "daily", calculationBasis: "minute" }), true);
  assert.equal(isExtraWorkEligible({ payType: "monthly", calculationBasis: "minute" }), true);
  assert.equal(isExtraWorkEligible({ payType: "monthly", calculationBasis: "fixed_monthly" }), false);
});

test("only the full daily total at or above 30 minutes becomes a candidate", () => {
  assert.equal(EXTRA_WORK_MINIMUM_CANDIDATE_MINUTES, 30);
  for (const minutes of [0, 3, 29]) {
    const end = minutes === 0 ? "23:00" : `23:${String(minutes).padStart(2, "0")}`;
    assert.equal(calculatePartTimeExtraWork(base("18:00", end)), null, `${minutes} minutes must be ignored`);
  }
  for (const [minutes, end] of [[30, "23:30"], [31, "23:31"], [60, "00:00"], [118, "00:58"]] as const) {
    const candidate = calculatePartTimeExtraWork(base("18:00", end));
    assert.equal(candidate?.candidateMinutes, minutes);
    assert.equal(candidate?.candidateAmount, Math.round(minutes * 35_000 / 60));
  }
  assert.equal(calculatePartTimeExtraWork(base("17:40", "23:09")), null, "20 before + 9 after must be ignored");
  const split = calculatePartTimeExtraWork(base("17:45", "23:15"));
  assert.deepEqual([split?.beforeScheduleMinutes, split?.afterScheduleMinutes, split?.candidateMinutes], [15, 15, 30]);
});

test("30 and 31 minute candidates pay every candidate minute, not only the excess over 30", () => {
  const thirty = calculatePartTimeExtraWork(base("18:00", "23:30"));
  const thirtyOne = calculatePartTimeExtraWork(base("18:00", "23:31"));
  assert.equal(thirty?.candidateAmount, Math.round(30 * 35_000 / 60));
  assert.equal(thirtyOne?.candidateAmount, Math.round(31 * 35_000 / 60));
});

test("monthly and daily amounts reuse calculatePayrollRates minuteRate", () => {
  const contract = (payType: PayrollContract["payType"], baseSalary: number): PayrollContract => ({
    id: 11, userId: 7, payType, calculationBasis: "minute", baseSalary, fixedRaiseAmount: 0,
    standardWorkdays: payType === "monthly" ? 26 : null, standardMinutesPerDay: 600,
    timeBlockMinutes: 1, roundingMode: "none", lateAdjustmentMode: "separate",
    earlyLeaveAdjustmentMode: "separate", overtimeMode: "requires_approval", paidLeaveMode: "unpaid",
    effectiveFrom: "2026-08-01", effectiveTo: null, revision: 3,
  });
  const monthly = contract("monthly", 15_600_000);
  const daily = contract("daily", 360_000);
  for (const row of [monthly, daily]) {
    const rate = calculatePayrollRates(row, row.baseSalary);
    const candidate = calculatePartTimeExtraWork({ ...base("18:00", "23:31"), minuteRateAmount: rate.minuteRate, hourlyRateAmount: Math.round(rate.minuteRate * 60) });
    assert.equal(candidate?.candidateAmount, Math.round(31 * rate.minuteRate));
  }
  assert.equal(calculatePayrollRates(monthly, monthly.baseSalary).minuteRate, 1_000);
});

test("approved adds pay, rejected adds zero, pending blocks, and changed sources are stale", () => {
  const pending = calculatePartTimeExtraWork(base("16:00", "00:30"))!;
  assert.deepEqual(partTimeExtraWorkDecisionEffect(pending), { amount: 0, warningCode: "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED" });
  const decisionBase = { id: 1, attendanceRecordId: 101, decisionReason: null, decidedBy: 1, decidedAt: "2026-09-09T00:00:00Z" };
  const approved = calculatePartTimeExtraWork({ ...base("16:00", "00:30"), decision: { ...decisionBase, decision: "approved", sourceHash: pending.sourceHash } })!;
  assert.deepEqual(partTimeExtraWorkDecisionEffect(approved), { amount: 122_500, warningCode: null });
  const rejected = calculatePartTimeExtraWork({ ...base("16:00", "00:30"), decision: { ...decisionBase, decision: "rejected", sourceHash: pending.sourceHash } })!;
  assert.deepEqual(partTimeExtraWorkDecisionEffect(rejected), { amount: 0, warningCode: null });
  const stale = calculatePartTimeExtraWork({ ...base("16:00", "00:31"), decision: { ...decisionBase, decision: "approved", sourceHash: pending.sourceHash } })!;
  assert.deepEqual(partTimeExtraWorkDecisionEffect(stale), { amount: 0, warningCode: "PART_TIME_EXTRA_WORK_DECISION_STALE" });
});

test("Đức August regression totals 1,620 minutes, 945,000 VND, and excludes 19/0 minutes", () => {
  const rows = [
    base("15:41", "23:00"),
    ...Array.from({ length: 9 }, (_, index) => ({ ...base("16:00", "23:00"), attendanceRecordId: 102 + index })),
    { ...base("16:58", "23:00"), attendanceRecordId: 120 },
    ...Array.from({ length: 3 }, (_, index) => ({ ...base("18:00", "00:30"), attendanceRecordId: 121 + index })),
    { ...base("18:00", "00:28"), attendanceRecordId: 124 },
  ].map(row => calculatePartTimeExtraWork(row)!).filter(Boolean);
  assert.equal(rows.reduce((sum, row) => sum + row.beforeScheduleMinutes, 0), 1_262);
  assert.equal(rows.reduce((sum, row) => sum + row.afterScheduleMinutes, 0), 358);
  assert.equal(rows.reduce((sum, row) => sum + row.candidateMinutes, 0), 1_620);
  assert.equal(rows.reduce((sum, row) => sum + row.candidateAmount, 0), 945_000);
  assert.equal(rows.reduce((sum, row) => sum + row.excludedBeforeOpenMinutes, 0), 19);
  assert.equal(rows.reduce((sum, row) => sum + row.excludedAfterCloseMinutes, 0), 0);
});

test("payment snapshot contract includes extra-work decisions and therefore changes its hash", () => {
  const source = readFileSync(join(process.cwd(), "lib/payroll/payment-snapshot.ts"), "utf8");
  assert.match(source, /partTimeExtraWorkSnapshot:raw\.partTimeExtraWork/);
  assert.match(source, /automaticItemsSnapshot:raw\.items/);
  const before = partTimeExtraWorkSourceHash({ calculation: 1, partTimeExtraWorkDecision: "approved" });
  const after = partTimeExtraWorkSourceHash({ calculation: 1, partTimeExtraWorkDecision: "rejected" });
  assert.notEqual(before, after);
});
