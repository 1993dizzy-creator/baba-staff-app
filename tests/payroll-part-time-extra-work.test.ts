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
  assert.deepEqual([until0030.beforeScheduleMinutes, until0030.afterScheduleMinutes, until0030.candidateMinutes], [120, 90, 90]);
  const outside = calculatePartTimeExtraWork(base("15:30", "01:30"))!;
  assert.deepEqual([outside.candidateMinutes, outside.excludedBeforeOpenMinutes, outside.excludedAfterCloseMinutes], [120, 30, 30]);
  assert.equal(calculatePartTimeExtraWork(base("17:45", "23:10")), null);
});

test("hourly, daily, and monthly attendance-based contracts are eligible, but fixed monthly is excluded", () => {
  assert.equal(isExtraWorkEligible({ payType: "hourly", calculationBasis: "minute" }), true);
  assert.equal(isExtraWorkEligible({ payType: "daily", calculationBasis: "minute" }), true);
  assert.equal(isExtraWorkEligible({ payType: "monthly", calculationBasis: "minute" }), true);
  assert.equal(isExtraWorkEligible({ payType: "monthly", calculationBasis: "fixed_monthly" }), false);
});

test("only after-schedule work at or above 30 minutes becomes a candidate", () => {
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
  assert.equal(split, null);
  assert.equal(calculatePartTimeExtraWork(base("17:00", "23:20")), null, "60 before + 20 after is not eligible");
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
  assert.deepEqual(partTimeExtraWorkDecisionEffect(approved), { amount: 52_500, warningCode: null });
  const rejected = calculatePartTimeExtraWork({ ...base("16:00", "00:30"), decision: { ...decisionBase, decision: "rejected", sourceHash: pending.sourceHash } })!;
  assert.deepEqual(partTimeExtraWorkDecisionEffect(rejected), { amount: 0, warningCode: null });
  const stale = calculatePartTimeExtraWork({ ...base("16:00", "00:31"), decision: { ...decisionBase, decision: "approved", sourceHash: pending.sourceHash } })!;
  assert.deepEqual(partTimeExtraWorkDecisionEffect(stale), { amount: 0, warningCode: "PART_TIME_EXTRA_WORK_DECISION_STALE" });
});

test("Đức August regression excludes early-only rows and pays 358 after-schedule minutes", () => {
  const rows = [
    base("15:41", "23:00"),
    ...Array.from({ length: 9 }, (_, index) => ({ ...base("16:00", "23:00"), attendanceRecordId: 102 + index })),
    { ...base("16:58", "23:00"), attendanceRecordId: 120 },
    ...Array.from({ length: 3 }, (_, index) => ({ ...base("18:00", "00:30"), attendanceRecordId: 121 + index })),
    { ...base("18:00", "00:28"), attendanceRecordId: 124 },
  ].map(row => calculatePartTimeExtraWork(row)!).filter(Boolean);
  assert.equal(rows.length, 4);
  assert.equal(rows.reduce((sum, row) => sum + row.beforeScheduleMinutes, 0), 0);
  assert.equal(rows.reduce((sum, row) => sum + row.afterScheduleMinutes, 0), 358);
  assert.equal(rows.reduce((sum, row) => sum + row.candidateMinutes, 0), 358);
  assert.equal(rows.reduce((sum, row) => sum + row.candidateAmount, 0), 208_833);
  assert.equal(rows.reduce((sum, row) => sum + row.excludedBeforeOpenMinutes, 0), 0);
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

const approvedDecision = (sourceHash: string) => ({
  id: 1, attendanceRecordId: 101, decision: "approved" as const, sourceHash,
  decisionReason: null, decidedBy: 1, decidedAt: "2026-09-09T00:00:00Z",
});

test("Cô Thêm September 5: early arrival and checkout before the overnight schedule end produce no candidate", () => {
  const input = {
    ...base("16:28", "00:31"), businessDate: "2026-09-05",
    checkInAt: "2026-09-05T16:28:30+07:00", checkOutAt: "2026-09-06T00:31:00+07:00",
    scheduleStartTime: "17:00", scheduleEndTime: "01:00",
    decision: approvedDecision("legacy-31-minute-approval"),
  };
  assert.equal(calculatePartTimeExtraWork(input), null);
});

test("Thiết September 4: legacy 65-minute approval is stale against the new 60-minute source", () => {
  const input = { ...base("17:55", "00:00"), businessDate: "2026-09-04",
    checkInAt: at("2026-09-04", "17:55"), checkOutAt: at("2026-09-05", "00:00") };
  const fresh = calculatePartTimeExtraWork(input)!;
  assert.deepEqual([fresh.beforeScheduleMinutes, fresh.afterScheduleMinutes, fresh.candidateMinutes, fresh.candidateAmount], [5, 60, 60, 35_000]);
  assert.equal(fresh.sourceSnapshot.beforeScheduleMinutes, 5);
  const legacySnapshot = { ...fresh.sourceSnapshot, candidateMinutes: 65, candidateAmount: 37_917 };
  const legacyDecision = approvedDecision(partTimeExtraWorkSourceHash(legacySnapshot));
  const stale = calculatePartTimeExtraWork({ ...input, decision: legacyDecision })!;
  assert.notEqual(stale.sourceHash, legacyDecision.sourceHash);
  assert.equal(stale.status, "stale");
  assert.deepEqual(partTimeExtraWorkDecisionEffect(stale), { amount: 0, warningCode: "PART_TIME_EXTRA_WORK_DECISION_STALE" });
  const reapproved = calculatePartTimeExtraWork({ ...input, decision: approvedDecision(fresh.sourceHash) })!;
  assert.deepEqual(partTimeExtraWorkDecisionEffect(reapproved), { amount: 35_000, warningCode: null });
});

test("before-schedule audit metadata changes the source but never candidate minutes or pay", () => {
  const onTime = calculatePartTimeExtraWork(base("18:00", "00:00"))!;
  for (const start of ["17:55", "17:00", "16:00"]) {
    const early = calculatePartTimeExtraWork(base(start, "00:00"))!;
    assert.ok(early.beforeScheduleMinutes > 0);
    assert.equal(early.sourceSnapshot.beforeScheduleMinutes, early.beforeScheduleMinutes);
    assert.equal(early.candidateMinutes, onTime.candidateMinutes);
    assert.equal(early.candidateAmount, onTime.candidateAmount);
    assert.notEqual(early.sourceHash, onTime.sourceHash);
  }
});

test("legacy approvals without early-arrival pay retain an unchanged source and remain matched", () => {
  const input = base("18:00", "23:31");
  const fresh = calculatePartTimeExtraWork(input)!;
  const legacySnapshot = {
    ...fresh.sourceSnapshot,
    candidateMinutes: fresh.beforeScheduleMinutes + fresh.afterScheduleMinutes,
    candidateAmount: Math.round((fresh.beforeScheduleMinutes + fresh.afterScheduleMinutes) * input.minuteRateAmount),
  };
  const matched = calculatePartTimeExtraWork({ ...input, decision: approvedDecision(partTimeExtraWorkSourceHash(legacySnapshot)) })!;
  assert.equal(matched.status, "approved");
  assert.equal(matched.candidateMinutes, 31);
  assert.deepEqual(partTimeExtraWorkDecisionEffect(matched), { amount: 18_083, warningCode: null });
});

test("store-close clipping is applied before the after-only minimum threshold", () => {
  assert.equal(calculatePartTimeExtraWork({ ...base("16:00", "00:30"), storeCloseTime: "23:20" }), null);
  const clipped = calculatePartTimeExtraWork({ ...base("17:55", "00:30"), storeCloseTime: "23:30" })!;
  assert.deepEqual([clipped.beforeScheduleMinutes, clipped.afterScheduleMinutes, clipped.candidateMinutes, clipped.excludedAfterCloseMinutes], [5, 30, 30, 60]);
});

test("Đức legacy approvals with after-schedule work under 30 minutes disappear", () => {
  // September 6/9/11 use representative values: only the under-30 condition
  // was supplied, not exact production timestamps.
  for (const [date, start, end] of [
    ["2026-09-02", "16:06", "23:04"],
    ["2026-09-05", "16:03", "23:03"],
    ["2026-09-06", "16:00", "23:29"],
    ["2026-09-09", "16:00", "23:20"],
    ["2026-09-11", "16:00", "23:03"],
  ]) {
    const input = { ...base(start, end), businessDate: date, checkInAt: at(date, start), checkOutAt: at(date, end), decision: approvedDecision("legacy-source") };
    assert.equal(calculatePartTimeExtraWork(input), null, date);
  }
});
