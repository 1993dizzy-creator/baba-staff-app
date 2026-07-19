import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error test runner imports the TypeScript source directly.
import { calculateStoreBusinessDate, CORE_DEFAULT_HOURS as DEFAULT_STORE_HOURS, getStoreOperationState, validateStoreHours } from "../lib/store-settings/business-time-core.ts";
// @ts-expect-error test runner imports the TypeScript source directly.
import { getBusinessDate as getLegacyBusinessDate } from "../lib/common/business-time.ts";

test("cutoff-only business date handles Vietnam boundaries", () => {
  assert.equal(calculateStoreBusinessDate("2026-07-19T19:59:00Z"), "2026-07-19"); // 02:59
  assert.equal(calculateStoreBusinessDate("2026-07-19T20:00:00Z"), "2026-07-20"); // 03:00
  assert.equal(calculateStoreBusinessDate("2026-07-20T15:59:00+07:00"), "2026-07-20");
  assert.equal(calculateStoreBusinessDate("2026-07-20T16:00:00+07:00"), "2026-07-20");
  assert.equal(calculateStoreBusinessDate("2026-07-20T23:59:00+07:00"), "2026-07-20");
});

test("business date crosses month, year and leap-day correctly", () => {
  assert.equal(calculateStoreBusinessDate("2026-03-01T02:59:00+07:00"), "2026-02-28");
  assert.equal(calculateStoreBusinessDate("2024-03-01T02:59:00+07:00"), "2024-02-29");
  assert.equal(calculateStoreBusinessDate("2027-01-01T02:59:00+07:00"), "2026-12-31");
});

test("new cutoff calculation matches the legacy calculation under current policy", () => {
  for (const timestamp of ["2026-07-20T02:59:00+07:00","2026-07-20T03:00:00+07:00","2026-07-20T16:00:00+07:00","2026-12-31T23:59:00+07:00","2024-03-01T00:15:00+07:00"]) {
    assert.equal(calculateStoreBusinessDate(timestamp), getLegacyBusinessDate(new Date(timestamp)));
  }
});

test("weekday hours distinguish open, close and post-close cutoff window", () => {
  assert.equal(getStoreOperationState("2026-07-20T16:00:00+07:00").isOpen, true); // Monday
  assert.equal(getStoreOperationState("2026-07-19T15:59:00+07:00").isOpen, false); // Sunday
  assert.equal(getStoreOperationState("2026-07-19T16:00:00+07:00").isOpen, true);
  assert.equal(getStoreOperationState("2026-07-21T00:30:00+07:00").isOpen, true);
  assert.deepEqual(getStoreOperationState("2026-07-21T01:00:00+07:00"), { isOpen: false, isAfterCloseBeforeCutoff: true });
  assert.equal(getStoreOperationState("2026-07-21T03:00:00+07:00").isAfterCloseBeforeCutoff, false);
});

test("default policy opens every weekday from 16:00 until 01:00", () => {
  assert.deepEqual(DEFAULT_STORE_HOURS.map(({ weekday, isClosed, openTime, closeTime }) => ({ weekday, isClosed, openTime, closeTime })),
    Array.from({ length: 7 }, (_, weekday) => ({ weekday, isClosed: false, openTime: "16:00", closeTime: "01:00" })));
});

test("closed weekday and seven-row validation", () => {
  const closedMonday = DEFAULT_STORE_HOURS.map((item) => item.weekday === 1 ? { weekday: 1, isClosed: true, openTime: null, closeTime: null } : item);
  assert.equal(validateStoreHours(closedMonday), true);
  assert.equal(getStoreOperationState("2026-07-20T20:00:00+07:00", closedMonday).isOpen, false);
  assert.equal(validateStoreHours(closedMonday.slice(1)), false);
});
