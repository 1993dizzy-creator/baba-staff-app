import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error test runner imports the TypeScript source directly.
import { calculateStoreBusinessDate, addStoreDays } from "../lib/store-settings/business-time-core.ts";

test("required inventory time boundaries resolve to the expected business date", () => {
  const cases: [string, string][] = [
    ["2026-07-21T15:59:00+07:00", "2026-07-21"],
    ["2026-07-21T16:00:00+07:00", "2026-07-21"],
    ["2026-07-22T00:59:00+07:00", "2026-07-21"],
    ["2026-07-22T01:00:00+07:00", "2026-07-21"],
    ["2026-07-22T02:59:59+07:00", "2026-07-21"],
    ["2026-07-22T03:00:00+07:00", "2026-07-22"],
    ["2026-07-22T03:00:01+07:00", "2026-07-22"],
  ];

  for (const [timestamp, expected] of cases) {
    assert.equal(calculateStoreBusinessDate(timestamp), expected, timestamp);
  }
});

test("month-end and year-end near cutoff resolve to the correct business date", () => {
  assert.equal(calculateStoreBusinessDate("2026-08-01T01:30:00+07:00"), "2026-07-31");
  assert.equal(calculateStoreBusinessDate("2027-01-01T02:00:00+07:00"), "2026-12-31");
});

test("the snapshot cron's previous-business-day target is a plain addStoreDays(current, -1)", () => {
  // Mirrors resolveInventoryPreviousBusinessDate: resolve "now", then step
  // back one business day — the same pattern used by the sales-sync-final
  // and sales-deductions-final crons.
  const current = calculateStoreBusinessDate("2026-07-22T03:00:00+07:00");
  assert.equal(current, "2026-07-22");
  assert.equal(addStoreDays(current, -1), "2026-07-21");
});
