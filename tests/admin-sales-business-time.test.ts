import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error test runner imports the TypeScript source directly.
import { calculateStoreBusinessDate } from "../lib/store-settings/business-time-core.ts";

// /admin/sales* pages and APIs must land on the same businessDate as the
// rest of the store-settings-integrated system for these boundaries, since
// they all ultimately resolve through the same store settings time module.
test("required /admin/sales time boundaries resolve to the expected business date", () => {
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
