import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { isOwnerOrMasterRole } from "../lib/common/roles.ts";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { isPayrollOwnerRole } from "../lib/payroll/eligibility.ts";

// lib/payroll/eligibility.ts intentionally keeps its own self-contained
// role === "owner" || role === "master" check instead of importing
// lib/common/roles.ts (a "@/"-aliased import there breaks Node's native ESM
// resolution when tests/employee-lifecycle-policy.test.ts imports this file
// directly via a relative path with --experimental-strip-types). That is a
// deliberate, narrow duplication — this test is the guardrail that keeps the
// two definitions from silently drifting apart in the future.

const roleExpectations: Array<[unknown, boolean]> = [
  ["master", true],
  ["owner", true],
  ["manager", false],
  ["leader", false],
  ["staff", false],
  [null, false],
  [undefined, false],
  ["", false],
  ["admin", false],
  ["some-future-role", false],
];

test("isOwnerOrMasterRole and isPayrollOwnerRole agree on every role value", () => {
  for (const [role, expected] of roleExpectations) {
    assert.equal(isOwnerOrMasterRole(role), expected, `isOwnerOrMasterRole(${JSON.stringify(role)})`);
    assert.equal(isPayrollOwnerRole(role as string | null), expected, `isPayrollOwnerRole(${JSON.stringify(role)})`);
    assert.equal(
      isOwnerOrMasterRole(role),
      isPayrollOwnerRole(role as string | null),
      `parity mismatch for role=${JSON.stringify(role)}`
    );
  }
});
