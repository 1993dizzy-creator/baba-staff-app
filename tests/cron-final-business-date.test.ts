import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error test runner imports the TypeScript source directly.
import { addStoreDays, calculateStoreBusinessDate } from "../lib/store-settings/business-time-core.ts";

// The final crons (sales-sync-final, sales-deductions-final) must target the
// business date that JUST closed, not "now"'s business date. That target is
// always addStoreDays(currentBusinessDate, -1) — plain calendar-day
// subtraction on the already-resolved business date string, independent of
// cutoff/timezone policy.
function finalCronTarget(nowIso: string) {
  const current = calculateStoreBusinessDate(nowIso);
  return { current, target: addStoreDays(current, -1) };
}

test("cutoff second-level boundary: 02:59:59 vs 03:00:00 vs 03:00:01", () => {
  assert.deepEqual(finalCronTarget("2026-07-21T02:59:59+07:00"), {
    current: "2026-07-20",
    target: "2026-07-19",
  });
  assert.deepEqual(finalCronTarget("2026-07-21T03:00:00+07:00"), {
    current: "2026-07-21",
    target: "2026-07-20",
  });
  assert.deepEqual(finalCronTarget("2026-07-21T03:00:01+07:00"), {
    current: "2026-07-21",
    target: "2026-07-20",
  });
});

test("final target crosses month, year and leap-day correctly", () => {
  assert.deepEqual(finalCronTarget("2026-03-01T03:00:00+07:00"), {
    current: "2026-03-01",
    target: "2026-02-28",
  });
  assert.deepEqual(finalCronTarget("2024-03-01T03:00:00+07:00"), {
    current: "2024-03-01",
    target: "2024-02-29",
  });
  assert.deepEqual(finalCronTarget("2027-01-01T03:00:00+07:00"), {
    current: "2027-01-01",
    target: "2026-12-31",
  });
});

test("final target handles the Sunday/Monday business-day boundary", () => {
  // 2026-07-20 is a Monday; cutoff just after midnight Monday closes Sunday.
  assert.deepEqual(finalCronTarget("2026-07-20T03:00:00+07:00"), {
    current: "2026-07-20",
    target: "2026-07-19",
  });
});

test("final target does not special-case the settings effective-date boundary", () => {
  // Revision 3 became effective on 2026-07-20; the day before it (2026-07-19)
  // has no active settings row and resolves through the fallback snapshot.
  // addStoreDays is pure calendar-day math and must not need to know about
  // that at all.
  assert.equal(addStoreDays("2026-07-20", -1), "2026-07-19");
});
