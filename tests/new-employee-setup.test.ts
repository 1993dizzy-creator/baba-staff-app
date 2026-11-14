import assert from "node:assert/strict";
import test from "node:test";
import {
  attendanceTrackingForPayKind,
  contractMatchesRequest,
  fixedMonthlyFirstMonthProration,
  isNewEmployeeHireDate,
  newEmployeeBonusEffectiveMonth,
  newEmployeeContractRequest,
  newEmployeeMealEffectiveFrom,
} from "../lib/payroll/new-employee-setup.ts";

test("pay kind → existing DB contract values (no new pay type): fixed = monthly+fixed_monthly, monthly = monthly|hourly + minute", () => {
  assert.deepEqual(newEmployeeContractRequest({ kind: "fixed", unit: "monthly", amount: 8_000_000, hireDate: "2026-11-16" }),
    { firstMonthProration: true, payType: "monthly", calculationBasis: "fixed_monthly", baseSalary: 8_000_000, fixedRaiseAmount: 0, standardWorkdays: 26, effectiveFrom: "2026-11-01" });
  // the unit choice is ignored for the fixed kind (fixed is always a monthly amount)
  assert.equal(newEmployeeContractRequest({ kind: "fixed", unit: "hourly", amount: 1, hireDate: "2026-11-16" }).payType, "monthly");
  assert.deepEqual(newEmployeeContractRequest({ kind: "monthly", unit: "monthly", amount: 7_000_000, hireDate: "2026-11-16" }),
    { payType: "monthly", calculationBasis: "minute", baseSalary: 7_000_000, fixedRaiseAmount: 0, standardWorkdays: 26, effectiveFrom: "2026-11-16" });
  assert.deepEqual(newEmployeeContractRequest({ kind: "monthly", unit: "hourly", amount: 30_000, hireDate: "2026-11-16" }),
    { payType: "hourly", calculationBasis: "minute", baseSalary: 30_000, fixedRaiseAmount: 0, standardWorkdays: null, effectiveFrom: "2026-11-16" });
});

test("attendance follows the pay kind: fixed OFF, monthly (monthly or hourly amount) ON", () => {
  assert.equal(attendanceTrackingForPayKind("fixed"), false);
  assert.equal(attendanceTrackingForPayKind("monthly"), true);
});

test("contract effective dates: fixed starts on the 1st of the hire month (RPC rule), minute contracts on the hire date; never before 2026-08-01", () => {
  assert.equal(newEmployeeContractRequest({ kind: "fixed", unit: "monthly", amount: 1, hireDate: "2026-11-01" }).effectiveFrom, "2026-11-01");
  assert.equal(newEmployeeContractRequest({ kind: "fixed", unit: "monthly", amount: 1, hireDate: "2026-11-30" }).effectiveFrom, "2026-11-01");
  assert.equal(newEmployeeContractRequest({ kind: "fixed", unit: "monthly", amount: 1, hireDate: "2026-07-20" }).effectiveFrom, "2026-08-01");
  assert.equal(newEmployeeContractRequest({ kind: "monthly", unit: "hourly", amount: 1, hireDate: "2026-07-20" }).effectiveFrom, "2026-08-01");
  assert.equal(newEmployeeContractRequest({ kind: "monthly", unit: "monthly", amount: 1, hireDate: "2027-01-31" }).effectiveFrom, "2027-01-31");
});

test("benefit dates: meal from the hire date; attendance bonus from the hire month but never a past month", () => {
  assert.equal(newEmployeeMealEffectiveFrom("2026-11-16"), "2026-11-16");
  assert.equal(newEmployeeBonusEffectiveMonth("2026-11-16", "2026-11"), "2026-11");
  assert.equal(newEmployeeBonusEffectiveMonth("2026-09-03", "2026-11"), "2026-11", "past hire month → current month (no retroactive bonus)");
  assert.equal(newEmployeeBonusEffectiveMonth("2027-02-10", "2026-11"), "2027-02", "future hire month kept");
});

test("an existing contract is recognized as the same request only when type, basis, amount and date all match", () => {
  const request = newEmployeeContractRequest({ kind: "monthly", unit: "hourly", amount: 30_000, hireDate: "2026-11-16" });
  assert.equal(contractMatchesRequest({ payType: "hourly", calculationBasis: "minute", baseSalary: 30_000, effectiveFrom: "2026-11-16" }, request), true);
  assert.equal(contractMatchesRequest({ payType: "hourly", calculationBasis: "minute", baseSalary: 31_000, effectiveFrom: "2026-11-16" }, request), false);
  assert.equal(contractMatchesRequest({ payType: "monthly", calculationBasis: "minute", baseSalary: 30_000, effectiveFrom: "2026-11-16" }, request), false);
  assert.equal(contractMatchesRequest({ payType: "hourly", calculationBasis: "minute", baseSalary: 30_000, effectiveFrom: "2026-11-17" }, request), false);
});

test("fixed first-month proration figure (notice only): calendar days incl. the hire date / days in month, VND rounding", () => {
  assert.deepEqual(fixedMonthlyFirstMonthProration(8_000_000, "2026-11-16"), { employedDays: 15, totalDays: 30, amount: 4_000_000 });
  assert.equal(fixedMonthlyFirstMonthProration(8_000_000, "2026-11-01"), null, "1st of month: no proration");
  assert.deepEqual(fixedMonthlyFirstMonthProration(8_000_000, "2026-11-15"), { employedDays: 16, totalDays: 30, amount: 4_266_667 });
  assert.deepEqual(fixedMonthlyFirstMonthProration(8_000_000, "2026-11-30"), { employedDays: 1, totalDays: 30, amount: 266_667 });
  assert.deepEqual(fixedMonthlyFirstMonthProration(9_300_000, "2026-12-31"), { employedDays: 1, totalDays: 31, amount: 300_000 });
  assert.deepEqual(fixedMonthlyFirstMonthProration(2_800_000, "2027-02-15"), { employedDays: 14, totalDays: 28, amount: 1_400_000 });
  assert.deepEqual(fixedMonthlyFirstMonthProration(2_900_000, "2028-02-15"), { employedDays: 15, totalDays: 29, amount: 1_500_000 }, "leap February");
  assert.equal(fixedMonthlyFirstMonthProration(8_000_000, "2026-02-30"), null, "invalid date");
});

test("hire date validation rejects empty and impossible dates", () => {
  assert.equal(isNewEmployeeHireDate("2026-11-16"), true);
  assert.equal(isNewEmployeeHireDate(""), false);
  assert.equal(isNewEmployeeHireDate("2026-02-30"), false);
  assert.equal(isNewEmployeeHireDate(null), false);
});
