import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { normalizeAttendanceDayFacts } from "../lib/payroll/attendance-facts.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { projectPayrollAttendanceDay, roundMinutes } from "../lib/payroll/projection.ts";
import type { PayrollContract, WorkScheduleVersion } from "../lib/payroll/types.ts";

const schedule: WorkScheduleVersion={id:1,userId:7,startTime:'16:00',endTime:'01:00',unpaidBreakMinutes:0,effectiveFrom:'2026-08-01',effectiveTo:null,revision:1,changeReason:'seed'};
const contract: PayrollContract={id:1,userId:7,payType:'daily',calculationBasis:'minute',baseSalary:900,fixedRaiseAmount:0,standardWorkdays:26,standardMinutesPerDay:540,timeBlockMinutes:60,roundingMode:'floor',lateAdjustmentMode:'separate',earlyLeaveAdjustmentMode:'separate',overtimeMode:'requires_approval',paidLeaveMode:'manual_review',effectiveFrom:'2026-08-01',effectiveTo:null,revision:1};

test('normalizes facts in integer minutes and separates out-of-schedule work',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule,attendanceRecord:{id:4,status:'done',checkInAt:'2026-08-03T08:50:00.000Z',checkOutAt:'2026-08-03T18:10:00.000Z',approvalStatus:'approved'}});assert.equal(facts.scheduledMinutes,540);assert.equal(facts.actualMinutes,560);assert.equal(facts.scheduledOverlapMinutes,540);assert.equal(facts.overtimeCandidateMinutes,20);assert.ok(facts.warningCodes.includes('OVERTIME_APPROVAL_UNAVAILABLE'));});
test('warns instead of backfilling schedules before automation start',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-07-31',schedule:null,attendanceRecord:null});assert.ok(facts.warningCodes.includes('SCHEDULE_HISTORY_UNAVAILABLE'));assert.equal(facts.payrollStatus,'requires_review');});
test('hour block rounding stays in integer minutes',()=>{assert.equal(roundMinutes(539,60,'floor'),480);assert.equal(roundMinutes(539,60,'ceil'),540);assert.equal(roundMinutes(511,60,'nearest'),540);});
test('missing checkout and contract never produce an estimated amount',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule,attendanceRecord:{id:4,status:'working',checkInAt:'2026-08-03T09:00:00.000Z',checkOutAt:null,approvalStatus:'approved'}});const result=projectPayrollAttendanceDay(facts,null,'minute');assert.equal(result.payrollStatus,'requires_review');assert.equal(result.estimatedAmount,null);assert.ok(result.warningCodes.includes('MISSING_CHECK_OUT'));assert.ok(result.warningCodes.includes('NO_PAYROLL_CONTRACT'));});

test('schedule-based auto-close clears missing checkout without stored policy mismatches',()=>{
  for(const [startTime,endTime,minutes] of [['16:00','17:00',60],['17:00','23:00',360],['18:00','23:00',300],['16:00','01:00',540]] as const){
    const checkOutDate=endTime<'03:00'?'2026-08-04':'2026-08-03';
    const facts=normalizeAttendanceDayFacts({
      userId:7,
      businessDate:'2026-08-03',
      schedule:{...schedule,startTime,endTime},
      attendanceRecord:{
        id:4,
        status:'done',
        checkInAt:`2026-08-03T${startTime}:00+07:00`,
        checkOutAt:`${checkOutDate}T${endTime}:00+07:00`,
        approvalStatus:'approved',
        storedLateMinutes:0,
        storedEarlyLeaveMinutes:0,
        storedWorkMinutes:minutes,
      },
    });
    assert.equal(facts.actualMinutes,minutes);
    assert.equal(facts.attendanceStatus,'done');
    assert.doesNotMatch(facts.warningCodes.join(','),/MISSING_CHECK_OUT|STORED_.*_MISMATCH/);
  }
});
test('minute and hour projections consume the exact same facts object',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule,attendanceRecord:{id:4,status:'done',checkInAt:'2026-08-03T09:00:00.000Z',checkOutAt:'2026-08-03T18:00:00.000Z',approvalStatus:'approved'}});const results=(['minute','hour'] as const).map(b=>projectPayrollAttendanceDay(facts,contract,b));assert.equal(results[0].recognizedMinutes,540);assert.equal(results[1].recognizedMinutes,540);assert.equal(facts.source.engineVersion,'attendance-facts-v1');});

test('Asia/Ho_Chi_Minh overnight schedule keeps late grace exclusive and early grace deducted, not thresholded',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule,lateGraceMinutes:10,earlyLeaveGraceMinutes:10,attendanceRecord:{id:4,status:'done',checkInAt:'2026-08-03T09:10:00.000Z',checkOutAt:'2026-08-03T17:50:00.000Z',approvalStatus:'approved'}});assert.equal(facts.scheduledMinutes,540);assert.equal(facts.lateMinutes,0);assert.equal(facts.rawEarlyLeaveMinutes,10);assert.equal(facts.earlyLeaveMinutes,0);const minute=projectPayrollAttendanceDay(facts,contract,'minute');assert.equal(minute.adjustmentMinutes,0);});
// 조퇴 유예는 threshold가 아니라 raw 조기퇴근분에서 공제되는 허용 시간이다:
// earlyLeaveMinutes = max(0, raw - grace). raw==grace 경계값도 전액 공제된다.
test('early-leave grace deducts from the raw duration instead of gating it all-or-nothing',()=>{for(const [grace,values] of [[90,[0,89,90,91,110]],[30,[29,30,31]]] as const){for(const raw of values){const expected=Math.max(0,raw-grace);const total=60-raw;const hours=total<0?24+Math.floor(total/60):Math.floor(total/60);const minutes=((total%60)+60)%60;const checkOutDate=hours>=16?'2026-08-03':'2026-08-04';const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule:{...schedule,startTime:'16:00',endTime:'01:00'},earlyLeaveGraceMinutes:grace,attendanceRecord:{id:4,status:expected>0?'early_leave':'done',checkInAt:'2026-08-03T09:00:00.000Z',checkOutAt:`${checkOutDate}T${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:00+07:00`,approvalStatus:'approved'}});assert.equal(facts.rawEarlyLeaveMinutes,raw);assert.equal(facts.isEarlyLeave,expected>0);assert.equal(facts.earlyLeaveMinutes,expected);}}});
test('overnight scheduled end calculates 23:30 as 90 raw minutes and midnight as 60 raw minutes early, minus grace',()=>{for(const [checkOutAt,rawExpected] of [['2026-08-03T23:30:00+07:00',90],['2026-08-04T00:00:00+07:00',60]] as const){const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule:{...schedule,startTime:'16:00',endTime:'01:00'},earlyLeaveGraceMinutes:30,attendanceRecord:{id:4,status:'early_leave',checkInAt:'2026-08-03T16:00:00+07:00',checkOutAt,approvalStatus:'approved'}});assert.equal(facts.rawEarlyLeaveMinutes,rawExpected);assert.equal(facts.earlyLeaveMinutes,rawExpected-30);}});

test('monthly, daily, and hourly contracts support minute and hour projections',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule,attendanceRecord:{id:4,status:'done',checkInAt:'2026-08-03T09:00:00.000Z',checkOutAt:'2026-08-03T18:00:00.000Z',approvalStatus:'approved'}});for(const payType of ['monthly','daily','hourly'] as const){for(const basis of ['minute','hour'] as const){const result=projectPayrollAttendanceDay(facts,{...contract,payType,baseSalary:payType==='hourly'?10001:contract.baseSalary,calculationBasis:basis},basis);assert.equal(result.payrollStatus,'calculable');assert.ok(Number.isInteger(result.estimatedAmount));}}});

test('actual-time projection ignores unpaid breaks and rounds VND once',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule:{...schedule,unpaidBreakMinutes:539},attendanceRecord:{id:4,status:'done',checkInAt:'2026-08-03T09:00:00.000Z',checkOutAt:'2026-08-03T18:00:00.000Z',approvalStatus:'approved'}});const result=projectPayrollAttendanceDay(facts,{...contract,payType:'hourly',baseSalary:10001,timeBlockMinutes:1,roundingMode:'none'},'minute');assert.equal(result.recognizedMinutes,540);assert.equal(result.estimatedAmount,90009);assert.ok(Number.isInteger(result.estimatedAmount));});

test('leave without payroll treatment is never calculated automatically',()=>{const pending=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule,attendanceRecord:{id:1,status:'leave',checkInAt:null,checkOutAt:null,approvalStatus:'pending'}});assert.equal(pending.payrollStatus,'pending');assert.ok(pending.warningCodes.includes('PENDING_LEAVE_APPROVAL'));const approved=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-04',schedule,attendanceRecord:{id:2,status:'leave',checkInAt:null,checkOutAt:null,approvalStatus:'approved'}});assert.equal(approved.payrollStatus,'requires_review');assert.ok(approved.warningCodes.includes('LEAVE_PAYROLL_TREATMENT_UNSPECIFIED'));assert.equal(projectPayrollAttendanceDay(approved,contract,'minute').estimatedAmount,null);});

test('stored attendance differences are exposed as policy mismatch warnings',()=>{const facts=normalizeAttendanceDayFacts({userId:7,businessDate:'2026-08-03',schedule,attendanceRecord:{id:4,status:'late',checkInAt:'2026-08-03T09:00:00.000Z',checkOutAt:'2026-08-03T18:00:00.000Z',approvalStatus:'approved',storedLateMinutes:10,storedEarlyLeaveMinutes:3,storedWorkMinutes:500}});assert.deepEqual(facts.stored,{status:'late',lateMinutes:10,earlyLeaveMinutes:3,workMinutes:500});assert.ok(facts.warningCodes.includes('STORED_STATUS_POLICY_MISMATCH'));assert.ok(facts.warningCodes.includes('STORED_LATE_MINUTES_MISMATCH'));assert.ok(facts.warningCodes.includes('STORED_EARLY_LEAVE_MINUTES_MISMATCH'));assert.ok(facts.warningCodes.includes('STORED_WORK_MINUTES_MISMATCH'));});
