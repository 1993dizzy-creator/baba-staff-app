import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { formatRecognizedWork, getPayrollHeaderAmount, sortPayrollEmployeesByHeaderAmount } from "../lib/payroll/payroll-page-display.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { formatPayrollHeaderAmount } from "../lib/payroll/payroll-page-money.ts";

test("recognized work uses source minutes and keeps the engine-provided day conversion", () => {
  const cases: Array<[number, number, string]> = [
    [0, 0, "0시간 (0일)"],
    [35, 0.07, "35분 (0.07일)"],
    [60, 0.125, "1시간 (0.13일)"],
    [90, 0.1875, "1시간 30분 (0.19일)"],
    [283, 0.589583, "4시간 43분 (0.59일)"],
    [466, 0.970833, "7시간 46분 (0.97일)"],
    [480, 1, "8시간 (1일)"],
    [1_080, 2.25, "18시간 (2.25일)"],
  ];

  for (const [minutes, days, expected] of cases) {
    assert.equal(formatRecognizedWork(minutes, days, "ko"), expected);
  }
  assert.equal(formatRecognizedWork(283, 0.589583, "vi"), "4 giờ 43 phút (0,59 ngày)");
  assert.equal(formatRecognizedWork(60, 0.125, "vi"), "1 giờ (0,13 ngày)");
});

test("header amount always presents the server-provided monthly scale", () => {
  assert.equal(formatPayrollHeaderAmount(10_000_000), "10tr ₫");
  assert.equal(formatPayrollHeaderAmount(6_240_000), "6tr240k ₫");
});

test("payroll header resolver and stable sorting share the same numeric source", () => {
  const employee = (name: string, amount: number | null) => ({
    name,
    contract: amount === null ? null : {},
    amounts: {
      combinedSalary: amount,
      contractMonthlyEquivalent: amount,
    },
  });
  const employees = [
    employee("unset-a", null),
    employee("9.9m", 9_900_000),
    employee("17.5m", 17_500_000),
    employee("equal-a", 10_000_000),
    employee("equal-b", 10_000_000),
    employee("hourly-month", 3_900_000),
    employee("unset-b", null),
  ];

  assert.equal(getPayrollHeaderAmount(employees[5]), 3_900_000);
  assert.equal(getPayrollHeaderAmount(employees[2], true), null);
  assert.deepEqual(
    sortPayrollEmployeesByHeaderAmount(employees).map(({ name }) => name),
    ["17.5m", "equal-a", "equal-b", "9.9m", "hourly-month", "unset-a", "unset-b"],
  );
});
