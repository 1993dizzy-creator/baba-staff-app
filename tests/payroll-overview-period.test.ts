import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test runner strips TypeScript directly.
import { getPayrollOverviewPeriod } from "../lib/payroll/overview-period.ts";

test("current month stops at Vietnam today without future attendance", () => {
  assert.deepEqual(getPayrollOverviewPeriod("2026-07", "2026-07-30"), {
    month: "2026-07", asOfDate: "2026-07-30", calculationEndDate: "2026-07-30", future: false, levelAsOfDate: "2026-07-30",
  });
});

test("past month calculates through its actual month end including February", () => {
  assert.equal(getPayrollOverviewPeriod("2026-06", "2026-07-30").calculationEndDate, "2026-06-30");
  assert.equal(getPayrollOverviewPeriod("2024-02", "2026-07-30").calculationEndDate, "2024-02-29");
});

test("future month has no calculation end and does not project future level state", () => {
  assert.deepEqual(getPayrollOverviewPeriod("2026-08", "2026-07-30"), {
    month: "2026-08", asOfDate: "2026-08-01", calculationEndDate: null, future: true, levelAsOfDate: "2026-07-30",
  });
});
