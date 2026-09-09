import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculatePartTimeExtraWork, isPartTimeExtraWorkEligible, partTimeExtraWorkDecisionEffect, partTimeExtraWorkSourceHash } from "../lib/payroll/part-time-extra-work.ts";

const at = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`).toISOString();
const base = (actualStart: string, actualEnd: string) => ({
  attendanceRecordId: 101, userId: 7, businessDate: "2026-08-01",
  checkInAt: at("2026-08-01", actualStart), checkOutAt: at(actualEnd < actualStart ? "2026-08-02" : "2026-08-01", actualEnd),
  contractId: 11, contractRevision: 3, hourlyRateAmount: 35_000,
  scheduleId: 21, scheduleRevision: 4, scheduleStartTime: "18:00", scheduleEndTime: "23:00",
  storeSettingId: 31, storeSettingRevision: 5, storeOpenTime: "16:00", storeCloseTime: "01:00",
});

test("part-time extra work clips actual work to store hours and excludes the personal schedule", () => {
  assert.equal(calculatePartTimeExtraWork(base("18:00", "23:00")), null);
  const until0030 = calculatePartTimeExtraWork(base("16:00", "00:30"))!;
  assert.deepEqual([until0030.beforeScheduleMinutes, until0030.afterScheduleMinutes, until0030.candidateMinutes], [120, 90, 210]);
  const outside = calculatePartTimeExtraWork(base("15:30", "01:30"))!;
  assert.deepEqual([outside.candidateMinutes, outside.excludedBeforeOpenMinutes, outside.excludedAfterCloseMinutes], [240, 30, 30]);
  const partial = calculatePartTimeExtraWork(base("17:45", "23:10"))!;
  assert.deepEqual([partial.beforeScheduleMinutes, partial.afterScheduleMinutes, partial.candidateMinutes], [15, 10, 25]);
});

test("only hourly employees are eligible for automatic part-time extra work", () => {
  assert.equal(isPartTimeExtraWorkEligible("hourly"), true);
  assert.equal(isPartTimeExtraWorkEligible("monthly"), false);
  assert.equal(isPartTimeExtraWorkEligible("daily"), false);
  assert.equal(isPartTimeExtraWorkEligible("fixed_monthly"), false);
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
