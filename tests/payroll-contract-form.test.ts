import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { currencyAmount, formatIntegerInput, hoursInputToMinutes, integerInputDigits, minutesToHoursInput, resolveFixedRaiseReason, signedAmount } from "../lib/payroll/contract-form.ts";

test("contract hours convert to integer stored minutes", () => {
  assert.equal(hoursInputToMinutes("9"), 540);
  assert.equal(hoursInputToMinutes("8.5"), 510);
  assert.equal(hoursInputToMinutes("7.75"), 465);
  assert.equal(minutesToHoursInput(540), "9");
});

test("invalid or fractional-minute contract hours are rejected", () => {
  for (const value of ["0", "-1", "24.1", "8.333", "not-a-number"])
    assert.equal(hoursInputToMinutes(value), null);
});

test("integer inputs keep digit state while displaying thousands separators", () => {
  assert.equal(formatIntegerInput("1"), "1");
  assert.equal(formatIntegerInput("1000"), "1,000");
  assert.equal(formatIntegerInput("1000000"), "1,000,000");
  assert.equal(formatIntegerInput("1,000,000"), "1,000,000");
  assert.equal(formatIntegerInput(""), "");
  assert.equal(formatIntegerInput("abc1,2x3"), "123");
  assert.equal(integerInputDigits("1,000,000"), "1000000");
});

test("fixed raise changes are formatted as signed cumulative deltas", () => {
  assert.equal(signedAmount(1_500_000 - 1_000_000, false), "+500,000동");
  assert.equal(signedAmount(500_000 - 1_000_000, false), "-500,000동");
  assert.equal(signedAmount(500_000, true), "+500,000₫");
  assert.equal(currencyAmount(1_000_000, false), "1,000,000동");
});

test("fixed raise reasons are required only when the cumulative total changes", () => {
  assert.deepEqual(resolveFixedRaiseReason(0, 0, ""), { changed: false, valid: true, note: null });
  assert.deepEqual(resolveFixedRaiseReason(0, 500_000, " 신규 "), { changed: true, valid: true, note: "신규" });
  assert.equal(resolveFixedRaiseReason(1_000_000, 1_500_000, "   ").valid, false);
  assert.equal(resolveFixedRaiseReason(1_000_000, 500_000, null).valid, false);
  assert.deepEqual(resolveFixedRaiseReason(1_000_000, 1_000_000, "old"), { changed: false, valid: true, note: null });
});
