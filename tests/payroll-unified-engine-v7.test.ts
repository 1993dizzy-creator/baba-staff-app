import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { scheduledMinutesPerDay, schedulesActiveOn } from "../lib/payroll/work-schedule.ts";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { applyUnifiedPayrollWorkPolicy as applyPayrollWorkPolicy, calculatePayrollRates } from "../lib/payroll/work-policy.ts";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { normalizeAttendanceDayFacts } from "../lib/payroll/attendance-facts.ts";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { selectUnifiedRecognizedMinutes } from "../lib/payroll/work-policy.ts";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { calculateLatePenalty } from "../lib/payroll/penalties.ts";
import type { PayrollContract, WorkScheduleVersion } from "../lib/payroll/types.ts";
import fs from "node:fs";
import path from "node:path";

const contract: PayrollContract={id:4,userId:23,payType:"hourly",calculationBasis:"minute",baseSalary:30000,fixedRaiseAmount:0,standardWorkdays:null,standardMinutesPerDay:300,timeBlockMinutes:1,roundingMode:"none",lateAdjustmentMode:"ignore",earlyLeaveAdjustmentMode:"ignore",overtimeMode:"requires_approval",paidLeaveMode:"unpaid",effectiveFrom:"2026-08-01",effectiveTo:null,revision:1};

test("overnight schedules and unpaid breaks produce immutable contract minutes",()=>{
  assert.equal(scheduledMinutesPerDay("16:00","01:00"),540);
  assert.equal(scheduledMinutesPerDay("20:00","01:00"),300);
  assert.equal(scheduledMinutesPerDay("20:00","01:00",30),270);
  assert.equal(scheduledMinutesPerDay("20:00","20:00"),null);
  assert.equal(scheduledMinutesPerDay("20:00","21:00",60),null);
});

test("effective-dated schedule selection detects missing and overlapping history",()=>{
  const row:WorkScheduleVersion={id:1,userId:23,startTime:"20:00",endTime:"01:00",unpaidBreakMinutes:0,effectiveFrom:"2026-08-01",effectiveTo:null,revision:1,changeReason:null};
  assert.equal(schedulesActiveOn([row],"2026-08-01").length,1);
  assert.equal(schedulesActiveOn([row],"2026-07-31").length,0);
  assert.equal(schedulesActiveOn([row,{...row,id:2,revision:2}],"2026-08-01").length,2);
});

test("hourly unified engine pays 500 VND per minute and 150000 VND for five hours",()=>{
  const rates=calculatePayrollRates(contract);
  assert.equal(rates.minuteRate,500);
  const result=applyPayrollWorkPolicy({contract,actualRecognizedMinutes:300,dayRate:rates.dayRate,minuteRate:rates.minuteRate,lateMinutes:0,earlyLeaveMinutes:0});
  assert.equal(result.workAmount,150000);
  assert.equal(result.automaticLatePenalty,0);
  assert.equal(result.automaticEarlyLeavePenalty,0);
});

test("monthly and daily unified engine prorate only by recognized scheduled minutes",()=>{
  for(const payType of ["monthly","daily"] as const){
    const current={...contract,payType,baseSalary:payType==="monthly"?2_600_000:100_000,standardWorkdays:payType==="monthly"?26:null};
    const rates=calculatePayrollRates(current);
    assert.equal(applyPayrollWorkPolicy({contract:current,actualRecognizedMinutes:300,dayRate:rates.dayRate,minuteRate:rates.minuteRate,lateMinutes:0,earlyLeaveMinutes:0}).workAmount,100000);
    assert.equal(applyPayrollWorkPolicy({contract:current,actualRecognizedMinutes:150,dayRate:rates.dayRate,minuteRate:rates.minuteRate,lateMinutes:120,earlyLeaveMinutes:30}).workAmount,50000);
  }
});

function recognized(checkInAt:string,checkOutAt:string,lateGraceMinutes=0,earlyLeaveGraceMinutes=0,manualLateNormalized=false){
  const schedule:WorkScheduleVersion={id:1,userId:23,startTime:"16:00",endTime:"01:00",unpaidBreakMinutes:0,effectiveFrom:"2026-08-01",effectiveTo:null,revision:1,changeReason:null};
  const facts=normalizeAttendanceDayFacts({userId:23,businessDate:"2026-08-03",schedule,lateGraceMinutes,earlyLeaveGraceMinutes,manualLateNormalized,attendanceRecord:{id:1,status:"done",checkInAt,checkOutAt,approvalStatus:"approved"}});
  return {facts,minutes:selectUnifiedRecognizedMinutes({scheduledMinutes:facts.scheduledMinutes!,scheduledOverlapMinutes:facts.scheduledOverlapMinutes!,actualMinutes:facts.actualMinutes!,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes,manualLateNormalized:facts.manualLateNormalized})};
}

test("normal and grace-qualified attendance receives the full scheduled day",()=>{
  assert.equal(recognized("2026-08-03T16:00:00+07:00","2026-08-04T01:00:00+07:00").minutes,540);
  assert.equal(recognized("2026-08-03T16:05:00+07:00","2026-08-04T00:55:00+07:00",10,10).minutes,540);
});

test("late and early leave recognize only overlap inside the schedule",()=>{
  assert.equal(recognized("2026-08-03T18:00:00+07:00","2026-08-04T01:00:00+07:00").minutes,420);
  assert.equal(recognized("2026-08-03T16:00:00+07:00","2026-08-03T23:00:00+07:00").minutes,420);
  assert.equal(recognized("2026-08-03T18:00:00+07:00","2026-08-03T23:00:00+07:00").minutes,300);
});

test("v7 applies the configured late penalty after reducing base work to scheduled overlap",()=>{
  const settings={thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000};
  for(const [late,expectedTier] of [[0,"none"],[10,"minor"],[20,"minor"],[21,"major"],[200,"major"]] as const){
    const minutes=540-late;
    const penalty=calculateLatePenalty({lateMinutes:late,minuteRate:500,dayRate:270000,...settings});
    assert.equal(penalty.tier,expectedTier);
    assert.equal(penalty.amount,late===0?0:late<=20?30000:135000);
    assert.equal(500*minutes-penalty.amount,270000-(500*late)-penalty.amount);
  }
});

test("monthly, daily, and hourly penalties use their current day and minute rates",()=>{
  const examples=[
    calculatePayrollRates({...contract,payType:"monthly",baseSalary:8_000_000,fixedRaiseAmount:500_000,standardWorkdays:26,standardMinutesPerDay:540},9_500_000),
    calculatePayrollRates({...contract,payType:"daily",baseSalary:300_000,standardMinutesPerDay:540}),
    calculatePayrollRates({...contract,payType:"hourly",baseSalary:30_000,standardMinutesPerDay:540}),
  ];
  assert.equal(examples[0].dayRate,9_500_000/26);
  assert.equal(examples[0].minuteRate,(9_500_000/26)/540);
  assert.equal(examples[1].dayRate,300_000);
  assert.equal(examples[2].minuteRate,500);
  for(const rates of examples){
    assert.equal(calculateLatePenalty({lateMinutes:20,minuteRate:rates.minuteRate,dayRate:rates.dayRate,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000}).amount,Math.round(rates.minuteRate*60));
    assert.equal(calculateLatePenalty({lateMinutes:21,minuteRate:rates.minuteRate,dayRate:rates.dayRate,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000}).amount,Math.round(rates.dayRate*.5));
  }
});

test("Diep-equivalent 200-minute late shift pays 319 minutes then deducts half a day",()=>{
  const monthly={...contract,payType:"monthly" as const,baseSalary:8_500_000,standardWorkdays:26,standardMinutesPerDay:540};
  const attendance=recognized("2026-08-03T19:20:00+07:00","2026-08-04T00:39:00+07:00",0,90);
  const rates=calculatePayrollRates(monthly,8_500_000);
  const work=applyPayrollWorkPolicy({contract:monthly,actualRecognizedMinutes:attendance.minutes,dayRate:rates.dayRate,minuteRate:rates.minuteRate,lateMinutes:attendance.facts.lateMinutes,earlyLeaveMinutes:attendance.facts.earlyLeaveMinutes});
  const penalty=calculateLatePenalty({lateMinutes:attendance.facts.lateMinutes,minuteRate:rates.minuteRate,dayRate:rates.dayRate,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000});
  assert.equal(attendance.facts.lateMinutes,200);
  assert.equal(attendance.minutes,319);
  assert.equal(Math.round(work.workAmount),193127);
  assert.deepEqual(penalty,{tier:"major",amount:163462});
  assert.equal(Math.round(work.workAmount)-penalty.amount,29665);
});

test("normalized late keeps actual overlap and produces no late deduction",()=>{
  const schedule:WorkScheduleVersion={id:1,userId:5,startTime:"16:00",endTime:"01:00",unpaidBreakMinutes:0,effectiveFrom:"2026-08-01",effectiveTo:null,revision:1,changeReason:null};
  const record={id:1197,status:"done",checkInAt:"2026-08-03T19:20:00+07:00",checkOutAt:"2026-08-04T00:39:00+07:00",approvalStatus:"approved",storedLateMinutes:0,storedEarlyLeaveMinutes:0,storedWorkMinutes:319};
  const facts=normalizeAttendanceDayFacts({userId:5,businessDate:"2026-08-03",schedule,lateGraceMinutes:0,earlyLeaveGraceMinutes:90,manualLateNormalized:true,attendanceRecord:record});
  const minutes=selectUnifiedRecognizedMinutes({scheduledMinutes:facts.scheduledMinutes!,scheduledOverlapMinutes:facts.scheduledOverlapMinutes!,actualMinutes:facts.actualMinutes!,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes,manualLateNormalized:facts.manualLateNormalized});
  const normalizedContract={...contract,payType:"monthly" as const,baseSalary:8_000_000,fixedRaiseAmount:500_000,standardWorkdays:26,standardMinutesPerDay:540};
  const rates=calculatePayrollRates(normalizedContract,9_500_000);
  const work=applyPayrollWorkPolicy({contract:normalizedContract,actualRecognizedMinutes:minutes,dayRate:rates.dayRate,minuteRate:rates.minuteRate,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes});
  const penalty=calculateLatePenalty({lateMinutes:facts.lateMinutes,minuteRate:rates.minuteRate,dayRate:rates.dayRate,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000});
  assert.equal(facts.manualLateNormalized,true);
  assert.equal(facts.lateMinutes,0);
  assert.equal(facts.actualMinutes,319);
  assert.equal(facts.stored.workMinutes,319);
  assert.equal(record.checkInAt,"2026-08-03T19:20:00+07:00");
  assert.equal(record.checkOutAt,"2026-08-04T00:39:00+07:00");
  assert.equal(minutes,319);
  assert.notEqual(minutes,540);
  assert.equal(minutes/540,319/540);
  assert.equal(Math.round(work.workAmount),215848);
  assert.deepEqual(penalty,{tier:"none",amount:0});
});

test("preview, run creation, and recalculation share the same monthly snapshot calculation",()=>{
  const overviewRoute=fs.readFileSync(path.join(process.cwd(),"app/api/admin/payroll/overview/route.ts"),"utf8");
  const runsRoute=fs.readFileSync(path.join(process.cwd(),"app/api/admin/payroll/runs/route.ts"),"utf8");
  const runRoute=fs.readFileSync(path.join(process.cwd(),"app/api/admin/payroll/runs/[runId]/route.ts"),"utf8");
  for(const source of [overviewRoute,runsRoute,runRoute]) assert.match(source,/loadPayrollMonthSnapshot/);
  assert.match(runsRoute,/p_employees:snapshot\.employees/);
  assert.match(runRoute,/p_employees: snapshot\.employees/);
});

test("late deduction snapshot keeps all inputs while early-leave deduction remains absent",()=>{
  const engine=fs.readFileSync(path.join(process.cwd(),"lib/payroll/monthly-run.ts"),"utf8");
  for(const field of ["attendanceRecordId","lateMinutes","penaltyTier","thresholdMinutes","minorPenaltyMinutes","majorPenaltyRateBp","minuteRate","dayRate","calculatedAmount","contractRevision","scheduleRevision","storeSettingsRevision","engineVersion"]) assert.match(engine,new RegExp(field));
  assert.match(engine,/item\("late_deduction","deduction"/);
  assert.doesNotMatch(engine,/item\("early_leave_deduction"/);
  assert.match(engine,/penaltySettings:\{\.\.\.penaltySettings,capturedAt:/);
});

test("early arrival and late departure never increase base recognized time",()=>{
  assert.equal(recognized("2026-08-03T15:45:00+07:00","2026-08-04T01:00:00+07:00").minutes,540);
  assert.equal(recognized("2026-08-03T16:00:00+07:00","2026-08-04T01:30:00+07:00").minutes,540);
});

test("v7 migration is transactional, data-preserving, private, and API signatures match",()=>{
  const sql=fs.readFileSync(path.join(process.cwd(),"supabase/migrations/202608020002_add_unified_payroll_engine_v7.sql"),"utf8");
  assert.match(sql,/^begin;[\s\S]*commit;\s*$/);
  assert.doesNotMatch(sql,/(update|delete from) public\.(payroll_contract_versions|payroll_runs|payroll_run_employees|payroll_contract_audit_logs)/i);
  for(const fn of ["payroll_create_contract_version_v4","payroll_correct_latest_unused_contract_v2"]){assert.match(sql,new RegExp(`create or replace function public\\.${fn}`));assert.match(sql,new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*from public,anon,authenticated`));assert.match(sql,new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*to service_role`));}
  assert.match(sql,/security definer set search_path=public/g);
  assert.match(sql,/payroll_correct_latest_unused_contract_v1/);
  assert.doesNotMatch(sql,/drop function public\.payroll_correct_latest_unused_contract_v1/);
  for(const guard of ["PAYROLL_V7_PREFLIGHT_COLUMN_MISMATCH","PAYROLL_V7_PREFLIGHT_FUNCTION_SIGNATURE_MISMATCH","PAYROLL_V7_PREFLIGHT_NEW_FUNCTION_OVERLOAD","PAYROLL_V7_PREFLIGHT_CONSTRAINT_MISMATCH"]) assert.match(sql,new RegExp(guard));
  assert.ok(sql.indexOf("PAYROLL_V7_PREFLIGHT_COLUMN_MISMATCH") < sql.indexOf("create or replace function public.payroll_create_contract_version_v4"));
});

test("v7 postflight is read-only and reports exact signatures plus all overloads",()=>{
  const sql=fs.readFileSync(path.join(process.cwd(),"supabase/payroll_unified_engine_v7_postflight.sql"),"utf8");
  assert.doesNotMatch(sql,/\b(insert|update|delete|alter|drop|create|grant|revoke|truncate)\b/i);
  for(const marker of ["overloadCount","overloads","exactExists","securityDefiner","serviceRoleExecute","existingFunctions","stillUnused","still540"]) assert.match(sql,new RegExp(marker));
});
