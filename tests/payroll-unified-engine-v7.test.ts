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
import { calculateLatePenalty, calculateTimePenalty } from "../lib/payroll/penalties.ts";
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

test("a late-only day recognizes the full scheduled day and preserves the effective late minutes",()=>{
  // 2시간 지각, 정시 퇴근 → 기본급은 스케줄 전액(540), 지각은 별도 deduction에서만.
  const late=recognized("2026-08-03T18:00:00+07:00","2026-08-04T01:00:00+07:00");
  assert.equal(late.facts.lateMinutes,120);
  assert.equal(late.facts.effectiveLateMinutes,120);
  assert.equal(late.facts.earlyLeaveMinutes,0);
  assert.equal(late.minutes,540);
});

test("an early-leave day now also recognizes the full scheduled day (base pay is not reduced)",()=>{
  // 정시 출근, 2시간 조퇴 → 기본급은 스케줄 전액(540), 조퇴는 별도 deduction에서만.
  const early=recognized("2026-08-03T16:00:00+07:00","2026-08-03T23:00:00+07:00");
  assert.equal(early.facts.earlyLeaveMinutes,120);
  assert.equal(early.facts.lateMinutes,0);
  assert.equal(early.minutes,540);
  // 지각 + 조퇴가 함께 있는 날도 기본급은 전액. 두 지연을 각각 독립적으로 보존한다.
  const both=recognized("2026-08-03T18:00:00+07:00","2026-08-03T23:00:00+07:00");
  assert.equal(both.facts.lateMinutes,120);
  assert.equal(both.facts.earlyLeaveMinutes,120);
  assert.equal(both.minutes,540);
});

test("calculateTimePenalty rounds effective minutes up to 30-minute blocks and charges the day's minute rate",()=>{
  for(const [effective,penaltyMinutes] of [[0,0],[1,30],[17,30],[28,30],[30,30],[31,60],[47,60],[60,60],[61,90],[90,90],[200,210]] as const){
    const result=calculateTimePenalty({effectiveMinutes:effective,minuteRate:583.3333333333334});
    assert.equal(result.penaltyMinutes,penaltyMinutes);
    assert.equal(result.amount,Math.round(583.3333333333334*penaltyMinutes));
  }
  // 예: 1일 급여 350,000 / 기준근무 600분 → 분급 583.33, 17분 지각 → 30분 → 17,500 VND
  assert.equal(calculateTimePenalty({effectiveMinutes:17,minuteRate:350_000/600}).amount,17_500);
});

test("general late still uses the settings minor/major tier; only normalized late and early leave use the 30-minute block",()=>{
  const engine=fs.readFileSync(path.join(process.cwd(),"lib/payroll/monthly-run.ts"),"utf8");
  // 일반 지각(manualLateNormalized=false) 경로는 /admin/payroll/settings 값을 실제로 사용한다.
  assert.match(engine,/if\(facts\.manualLateNormalized\)\{/);
  assert.match(engine,/calculateLatePenalty\(\{lateMinutes:facts\.effectiveLateMinutes,minuteRate:rate\.minuteRate,dayRate:rate\.dayRate,thresholdMinutes:input\.penaltySettings\.lateMajorThresholdMinutes,minorPenaltyMinutes:input\.penaltySettings\.lateMinorPenaltyMinutes,majorPenaltyRateBp:input\.penaltySettings\.lateMajorPenaltyRateBp\}\)/);
  assert.match(engine,/calculateTimePenalty\(\{effectiveMinutes:facts\.effectiveLateMinutes,minuteRate:rate\.minuteRate\}\)/);
  assert.match(engine,/calculateTimePenalty\(\{effectiveMinutes:facts\.earlyLeaveMinutes,minuteRate:rate\.minuteRate\}\)/);
  // minor/major tier 순수 함수 계약은 그대로.
  assert.deepEqual(calculateLatePenalty({lateMinutes:20,minuteRate:1_000,dayRate:480_000,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000}),{tier:"minor",amount:60_000});
  assert.deepEqual(calculateLatePenalty({lateMinutes:21,minuteRate:1_000,dayRate:480_000,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000}),{tier:"major",amount:240_000});
});

test("Diep-equivalent 200-minute GENERAL late shift pays the full day, then applies the settings major-tier penalty (not the 30-minute block)",()=>{
  const monthly={...contract,payType:"monthly" as const,baseSalary:8_500_000,standardWorkdays:26,standardMinutesPerDay:540};
  const attendance=recognized("2026-08-03T19:20:00+07:00","2026-08-04T00:39:00+07:00",0,90); // manualLateNormalized=false
  const rates=calculatePayrollRates(monthly,8_500_000);
  const work=applyPayrollWorkPolicy({contract:monthly,actualRecognizedMinutes:attendance.minutes,dayRate:rates.dayRate,minuteRate:rates.minuteRate,lateMinutes:attendance.facts.lateMinutes,earlyLeaveMinutes:attendance.facts.earlyLeaveMinutes});
  const penalty=calculateLatePenalty({lateMinutes:attendance.facts.effectiveLateMinutes,minuteRate:rates.minuteRate,dayRate:rates.dayRate,thresholdMinutes:20,minorPenaltyMinutes:60,majorPenaltyRateBp:5000});
  assert.equal(attendance.facts.manualLateNormalized,false);
  assert.equal(attendance.facts.effectiveLateMinutes,200);
  assert.equal(attendance.facts.earlyLeaveMinutes,0);
  // 지각 200분이어도 기본 근무급여는 스케줄 전액(1일 기준급여) 그대로.
  assert.equal(attendance.minutes,540);
  assert.equal(Math.round(work.workAmount),Math.round(rates.dayRate));
  assert.equal(Math.round(work.workAmount),326923);
  // 20분 초과 → major tier = dayRate × 0.5
  assert.deepEqual(penalty,{tier:"major",amount:Math.round(rates.dayRate*0.5)});
  assert.equal(penalty.amount,163462);
});

test("manual late normalization: full-day base pay recognised, display late zeroed, but effective late (from check-in) still drives a 30-minute-block penalty",()=>{
  const schedule:WorkScheduleVersion={id:1,userId:5,startTime:"16:00",endTime:"01:00",unpaidBreakMinutes:0,effectiveFrom:"2026-08-01",effectiveTo:null,revision:1,changeReason:null};
  // attendance_admin_normalize_late_v1 은 late_minutes 를 0으로 덮지만 check_in_at 은 그대로 둔다.
  const record={id:1197,status:"done",checkInAt:"2026-08-03T16:17:00+07:00",checkOutAt:"2026-08-04T01:00:00+07:00",approvalStatus:"approved",storedLateMinutes:0,storedEarlyLeaveMinutes:0,storedWorkMinutes:523};
  const facts=normalizeAttendanceDayFacts({userId:5,businessDate:"2026-08-03",schedule,lateGraceMinutes:0,earlyLeaveGraceMinutes:0,manualLateNormalized:true,attendanceRecord:record});
  const minutes=selectUnifiedRecognizedMinutes({scheduledMinutes:facts.scheduledMinutes!,scheduledOverlapMinutes:facts.scheduledOverlapMinutes!,actualMinutes:facts.actualMinutes!,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes,manualLateNormalized:facts.manualLateNormalized});
  const normalizedContract={...contract,payType:"monthly" as const,baseSalary:8_000_000,fixedRaiseAmount:500_000,standardWorkdays:26,standardMinutesPerDay:540};
  const rates=calculatePayrollRates(normalizedContract,9_500_000);
  const work=applyPayrollWorkPolicy({contract:normalizedContract,actualRecognizedMinutes:minutes,dayRate:rates.dayRate,minuteRate:rates.minuteRate,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes});
  const penalty=calculateTimePenalty({effectiveMinutes:facts.effectiveLateMinutes,minuteRate:rates.minuteRate});
  assert.equal(facts.manualLateNormalized,true);
  assert.equal(facts.lateMinutes,0);            // 표시/개근용은 0
  assert.equal(facts.rawLateMinutes,17);        // check-in 16:17 → 스케줄 16:00 대비 17분
  assert.equal(facts.effectiveLateMinutes,17);  // grace 0 → effective 17분 (정상화되어도 유지)
  assert.equal(minutes,540);                    // 기본급은 정상근무 1일 전액
  assert.equal(Math.round(work.workAmount),Math.round(rates.dayRate));
  assert.equal(penalty.penaltyMinutes,30);      // 17 → 30분 올림
  assert.ok(penalty.amount>0);                  // 정상화가 지각 벌금 면제는 아니다
});

test("overview and employee payment share the same monthly snapshot calculation",()=>{
  const overviewRoute=fs.readFileSync(path.join(process.cwd(),"app/api/admin/payroll/overview/route.ts"),"utf8");
  const overviewServer=fs.readFileSync(path.join(process.cwd(),"lib/payroll/overview-server.ts"),"utf8");
  const payments=fs.readFileSync(path.join(process.cwd(),"app/api/admin/payroll/payments/route.ts"),"utf8");
  // overview route now also passes an onSnapshotReady options object
  // (Phase 2, meal-allowance early start), but still calls the same shared
  // loadPayrollOverview(month, ...) — payments/route.ts is untouched.
  assert.match(overviewRoute,/loadPayrollOverview\(month,\{/);
  assert.match(payments,/loadPayrollOverview\(month\)/);
  assert.match(overviewServer,/loadPayrollMonthSnapshot\(month/);
  assert.match(payments,/p_calculation_snapshot:calculationSnapshot/);
});

test("late and early-leave deduction snapshots carry the full T8 cross-check trail",()=>{
  const engine=fs.readFileSync(path.join(process.cwd(),"lib/payroll/monthly-run.ts"),"utf8");
  // 지각/조퇴 deduction item metadata에 남아야 하는 근거들.
  for(const field of ["attendanceRecordId","businessDate","rawLateMinutes","effectiveLateMinutes","penaltyMinutes","penaltyBlockMinutes","lateThresholdMinutes","manualLateNormalized","minuteRate","dayRate","calculatedAmount","contractRevision","scheduleVersionId","scheduleRevision","storeSettingsRevision","storePolicyRevision","engineVersion"]) assert.match(engine,new RegExp(field));
  for(const field of ["rawEarlyLeaveMinutes","effectiveEarlyLeaveMinutes","earlyLeaveThresholdMinutes"]) assert.match(engine,new RegExp(field));
  assert.match(engine,/item\("late_deduction","deduction"/);
  assert.match(engine,/item\("early_leave_deduction","deduction"/);
  assert.match(engine,/type:"late"/);
  assert.match(engine,/type:"early_leave"/);
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
