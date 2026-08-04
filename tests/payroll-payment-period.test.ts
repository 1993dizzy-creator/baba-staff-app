import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { isClosedPayrollMonth, vietnamPayrollMonth } from "../lib/payroll/payment-period.ts";

test("August payroll opens only after September begins in Vietnam",()=>{
  assert.equal(vietnamPayrollMonth(new Date("2026-08-31T16:59:59Z")),"2026-08");
  assert.equal(isClosedPayrollMonth("2026-08",new Date("2026-08-31T16:59:59Z")),false);
  assert.equal(vietnamPayrollMonth(new Date("2026-08-31T17:00:00Z")),"2026-09");
  assert.equal(isClosedPayrollMonth("2026-08",new Date("2026-08-31T17:00:00Z")),true);
});

test("current and future months stay blocked while older months are allowed",()=>{
  const now=new Date("2026-09-15T05:00:00Z");
  assert.equal(isClosedPayrollMonth("2026-08",now),true);
  assert.equal(isClosedPayrollMonth("2026-09",now),false);
  assert.equal(isClosedPayrollMonth("2026-10",now),false);
});
