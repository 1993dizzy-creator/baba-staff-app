import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { calculateCombinedSalary } from "../lib/payroll/compensation.ts";
import type { EmployeeLevelInfo } from "../lib/employee-level/types.ts";
import type { PayrollContract } from "../lib/payroll/types.ts";

const contract: PayrollContract = { id:1,userId:7,payType:"monthly",calculationBasis:"minute",baseSalary:8_000_000,fixedRaiseAmount:500_000,standardWorkdays:26,standardMinutesPerDay:540,timeBlockMinutes:1,roundingMode:"none",lateAdjustmentMode:"deduct_minutes",earlyLeaveAdjustmentMode:"deduct_minutes",overtimeMode:"requires_approval",paidLeaveMode:"manual_review",effectiveFrom:"2026-07-01",effectiveTo:null,revision:1 };
const level = (earnedRaiseCount: number, reason: EmployeeLevelInfo["reason"] = null): EmployeeLevelInfo => ({ eligible:reason===null,reason,level:reason===null?Math.min(7,earnedRaiseCount+1) as EmployeeLevelInfo["level"]:null,displayLabel:null,baseDate:reason===null?"2026-01-01":null,baseDateSource:reason===null?"hire_date":null,calculationDate:"2026-07-31",completedQuarterCount:earnedRaiseCount,earnedRaiseCount,cumulativeRaiseAmount:earnedRaiseCount*500_000,raiseAmountPerStep:500_000,nextLevelDate:null,negotiationEligibleAt:null,negotiationEligible:false });

test("combined salary uses employee-management earned raises without an included-count offset",()=>{
  const result=calculateCombinedSalary(contract,level(2));
  assert.equal(result.levelRaiseAmount,1_000_000);
  assert.equal(result.combinedSalary,9_500_000);
});
test("zero earned raises keeps only contract and fixed compensation",()=>assert.equal(calculateCombinedSalary(contract,level(0)).combinedSalary,8_500_000));
test("missing employee level base date blocks level and combined salary",()=>assert.equal(calculateCombinedSalary(contract,level(0,"MISSING_BASE_DATE")).combinedSalary,null));
test("ineligible roles receive no level raise",()=>assert.equal(calculateCombinedSalary(contract,level(0,"ROLE_NOT_ELIGIBLE")).levelRaiseAmount,0));
test("non-monthly contracts do not receive monthly fixed or level raises",()=>assert.deepEqual(calculateCombinedSalary({...contract,payType:"hourly"},level(2)),{contractSalary:8_000_000,fixedRaiseAmount:0,levelRaiseAmount:0,combinedSalary:8_000_000,additionalRaiseCount:0}));
