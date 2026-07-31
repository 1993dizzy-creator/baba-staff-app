import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { calculateLatePenalty } from "../lib/payroll/penalties.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { applyPayrollWorkPolicy, calculatePayrollRates } from "../lib/payroll/work-policy.ts";
import type { PayrollContract } from "../lib/payroll/types.ts";

const base: PayrollContract={id:1,userId:1,payType:"monthly",calculationBasis:"day",baseSalary:9_500_000,fixedRaiseAmount:500_000,standardWorkdays:25,standardMinutesPerDay:480,timeBlockMinutes:60,roundingMode:"none",lateAdjustmentMode:"separate",earlyLeaveAdjustmentMode:"deduct_minutes",overtimeMode:"ignore",paidLeaveMode:"manual_review",effectiveFrom:"2026-07-01",effectiveTo:null,revision:1};
const calculate=(contract:PayrollContract,actualRecognizedMinutes:number,lateMinutes=0,earlyLeaveMinutes=0)=>applyPayrollWorkPolicy({contract,actualRecognizedMinutes,dayRate:380_000,minuteRate:380_000/480,lateMinutes,earlyLeaveMinutes});

test("actual-time basis pays every elapsed minute for monthly, daily, and hourly contracts",()=>{for(const contract of [{...base,calculationBasis:"minute" as const},{...base,payType:"daily" as const,calculationBasis:"minute" as const},{...base,payType:"hourly" as const,calculationBasis:"minute" as const}]){const result=calculate(contract,550,10,0);assert.equal(result.recognizedMinutes,550);assert.equal(result.recognizedWorkdays,550/480);assert.equal(result.workAmount,(380_000/480)*550);assert.equal(result.automaticLatePenalty,0);assert.equal(result.automaticEarlyLeavePenalty,0);}});
test("workday basis pays exactly one day without overtime expansion",()=>{const result=calculate(base,550,10,0);assert.equal(result.recognizedMinutes,480);assert.equal(result.recognizedWorkdays,1);assert.equal(result.workAmount,380_000);assert.equal(result.automaticLatePenalty,0);});
test("v6 preserves only the legacy day-basis early-leave contract behavior",()=>{const result=calculate(base,420,0,30);assert.equal(result.workAmount,380_000);assert.equal(result.automaticEarlyLeavePenalty,23_750);assert.equal(result.earlyLeaveRequiresReview,false);});
test("late penalty boundaries apply exactly one tier",()=>{const common={minuteRate:1_000,dayRate:480_000,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000};for(const [late,tier,amount] of [[0,"none",0],[1,"minor",60_000],[19,"minor",60_000],[20,"major",240_000],[21,"major",240_000]] as const){assert.deepEqual(calculateLatePenalty({...common,lateMinutes:late}),{tier,amount});}});
test("monthly, daily, and hourly contracts derive the documented minute and day rates",()=>{assert.deepEqual(calculatePayrollRates(base,9_500_000),{dayRate:380_000,minuteRate:380_000/480});assert.deepEqual(calculatePayrollRates({...base,payType:"daily",baseSalary:380_000}),{dayRate:380_000,minuteRate:380_000/480});assert.deepEqual(calculatePayrollRates({...base,payType:"hourly",baseSalary:60_000}),{dayRate:480_000,minuteRate:1_000});});
