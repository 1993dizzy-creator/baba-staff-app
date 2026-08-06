import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { isPayrollOwnerRole, requiresFixedMonthlyContract } from "../lib/payroll/eligibility.ts";

test("requiresFixedMonthlyContract: owner/master roles require fixed monthly regardless of attendance tracking", () => {
  assert.equal(requiresFixedMonthlyContract("owner", true), true);
  assert.equal(requiresFixedMonthlyContract("owner", false), true);
  assert.equal(requiresFixedMonthlyContract("master", true), true);
  assert.equal(requiresFixedMonthlyContract("master", false), true);
});

test("requiresFixedMonthlyContract: staff/manager/leader with attendance_tracking_enabled=false require fixed monthly (근태 미사용 staff)", () => {
  for (const role of ["staff", "manager", "leader"]) {
    assert.equal(requiresFixedMonthlyContract(role, false), true);
  }
});

test("requiresFixedMonthlyContract: staff/manager/leader with attendance_tracking_enabled=true use the normal minute-based/work-schedule path (근태 사용 staff)", () => {
  for (const role of ["staff", "manager", "leader"]) {
    assert.equal(requiresFixedMonthlyContract(role, true), false);
  }
});

test("requiresFixedMonthlyContract: does not alter or depend on role identity beyond isPayrollOwnerRole — attendance_tracking_enabled=false never implies owner", () => {
  assert.equal(requiresFixedMonthlyContract("staff", false), true);
  assert.equal(isPayrollOwnerRole("staff"), false, "role stays staff — requiresFixedMonthlyContract must never be mistaken for an owner-role check");
});

test("requiresFixedMonthlyContract: null/undefined attendance_tracking_enabled is treated as tracking-enabled (only an explicit false triggers fixed monthly)", () => {
  assert.equal(requiresFixedMonthlyContract("staff", null), false);
  assert.equal(requiresFixedMonthlyContract("staff", undefined), false);
});

test("requiresFixedMonthlyContract: null role with attendance tracking enabled does not require fixed monthly", () => {
  assert.equal(requiresFixedMonthlyContract(null, true), false);
  assert.equal(requiresFixedMonthlyContract(null, false), true);
});
