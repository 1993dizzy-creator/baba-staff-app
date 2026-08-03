import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { formatCompactVnd, formatContractRate, formatSignedVnd, formatVnd } from "../lib/payroll/payroll-page-money.ts";

test("payroll list amounts use Vietnamese tr and k notation without decimal units", () => {
  const cases = new Map([
    [0, "0 ₫"],
    [500, "500 ₫"],
    [1_000, "1k ₫"],
    [1_500, "1k500 ₫"],
    [30_000, "30k ₫"],
    [1_000_000, "1tr ₫"],
    [1_005_000, "1tr5k ₫"],
    [1_250_000, "1tr250k ₫"],
    [10_000_000, "10tr ₫"],
    [17_500_000, "17tr500k ₫"],
    [23_000_000, "23tr ₫"],
  ]);

  for (const [value, expected] of cases) assert.equal(formatCompactVnd(value), expected);
});

test("payroll detail amounts use dong and omit meaningless zero signs", () => {
  assert.equal(formatVnd(23_000_000), "23,000,000 ₫");
  assert.equal(formatSignedVnd(1_500_000, "+"), "+1,500,000 ₫");
  assert.equal(formatSignedVnd(300_000, "-"), "-300,000 ₫");
  assert.equal(formatSignedVnd(0, "+"), "0 ₫");
  assert.equal(formatSignedVnd(0, "-"), "0 ₫");
});

test("hourly contract rates show their unit while monthly results stay unitless", () => {
  assert.equal(formatContractRate(30_000, "hourly", "ko"), "30,000 ₫/시간");
  assert.equal(formatContractRate(30_000, "hourly", "vi"), "30,000 ₫/giờ");
  assert.equal(formatContractRate(0, "hourly", "ko", "+"), "0 ₫/시간");
  assert.equal(formatContractRate(10_000_000, "monthly", "ko"), "10,000,000 ₫");
});
