import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { applyPayrollWorkPolicy } from "../lib/payroll/work-policy.ts";
import type { PayrollContract } from "../lib/payroll/types.ts";

const base: PayrollContract={id:1,userId:1,payType:"monthly",calculationBasis:"day",baseSalary:9_500_000,fixedRaiseAmount:500_000,standardWorkdays:25,standardMinutesPerDay:480,timeBlockMinutes:1,roundingMode:"none",lateAdjustmentMode:"deduct_minutes",earlyLeaveAdjustmentMode:"deduct_minutes",overtimeMode:"requires_approval",paidLeaveMode:"manual_review",effectiveFrom:"2026-07-01",effectiveTo:null,revision:1};
const calculate=(contract:PayrollContract,actualRecognizedMinutes:number,lateMinutes=0,earlyLeaveMinutes=0)=>applyPayrollWorkPolicy({contract,actualRecognizedMinutes,dayRate:380_000,minuteRate:380_000/480,lateMinutes,earlyLeaveMinutes});

test("monthly late minutes keep one full workday and deduct exactly once",()=>{const normal=calculate(base,480);const late=calculate(base,420,60);assert.equal(late.recognizedWorkdays,1);assert.equal(late.workAmount,normal.workAmount);assert.equal(late.automaticLatePenalty,47_500);assert.equal(late.workAmount-late.automaticLatePenalty,normal.workAmount-47_500)});
test("monthly late and early leave combine only in automatic penalties",()=>{const result=calculate(base,420,30,30);assert.equal(result.workAmount,380_000);assert.equal(result.automaticLatePenalty+result.automaticEarlyLeavePenalty,47_500)});
test("separate and ignore never reduce monthly work amount",()=>{for(const mode of ["separate","ignore"] as const){const result=calculate({...base,lateAdjustmentMode:mode,earlyLeaveAdjustmentMode:mode},420,30,30);assert.equal(result.workAmount,380_000);assert.equal(result.automaticLatePenalty+result.automaticEarlyLeavePenalty,0);assert.equal(result.lateRequiresReview,mode==="separate")}});
test("hourly work uses actual time and never adds an automatic attendance penalty",()=>{const result=calculate({...base,payType:"hourly",calculationBasis:"minute",baseSalary:60_000},420,60,30);assert.equal(result.recognizedMinutes,420);assert.equal(result.workAmount,(380_000/480)*420);assert.equal(result.automaticLatePenalty+result.automaticEarlyLeavePenalty,0)});
test("daily day basis pays one day then deducts minutes once",()=>{const result=calculate({...base,payType:"daily",baseSalary:380_000},420,60);assert.equal(result.recognizedWorkdays,1);assert.equal(result.workAmount,380_000);assert.equal(result.automaticLatePenalty,47_500)});
test("daily minute basis uses actual time without an automatic attendance penalty",()=>{const result=calculate({...base,payType:"daily",calculationBasis:"minute",baseSalary:380_000},420,60);assert.equal(result.recognizedMinutes,420);assert.equal(result.automaticLatePenalty,0)});
