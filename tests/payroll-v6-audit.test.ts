import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { normalizeAttendanceDayFacts } from "../lib/payroll/attendance-facts.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { isMissingAttendanceCandidateDate } from "../lib/payroll/missing-attendance.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { getLastCompletedBusinessDate } from "../lib/payroll/overview-period.ts";

const schedule={id:1,userId:7,startTime:"16:00",endTime:"01:00",unpaidBreakMinutes:0,effectiveFrom:"2026-07-01",effectiveTo:null,revision:1,changeReason:"fixture"};
test("missing-attendance fixtures preserve employment and completed-day boundaries",()=>{const base={hireDate:"2026-07-02",terminationDate:"2026-07-06",calculationEndDate:"2026-07-04",hasActiveSchedule:true};assert.equal(isMissingAttendanceCandidateDate({...base,date:"2026-07-02",hasAttendanceRecord:true}),false);assert.equal(isMissingAttendanceCandidateDate({...base,date:"2026-07-04",hasAttendanceRecord:false}),true);assert.equal(isMissingAttendanceCandidateDate({...base,date:"2026-07-01",hasAttendanceRecord:false}),false);assert.equal(isMissingAttendanceCandidateDate({...base,date:"2026-07-07",calculationEndDate:"2026-07-07",hasAttendanceRecord:false}),false)});
test("completed-business-date cutoff is strict",()=>{assert.equal(getLastCompletedBusinessDate(new Date("2026-08-01T02:59:00+07:00")),"2026-07-30");assert.equal(getLastCompletedBusinessDate(new Date("2026-08-01T03:00:00+07:00")),"2026-07-31")});
test("actual elapsed minutes preserve overnight and partial shifts",()=>{for(const[checkInAt,checkOutAt,expected]of[["2026-07-01T08:55:00.000Z","2026-07-01T18:05:00.000Z",550],["2026-07-01T09:10:00.000Z","2026-07-01T18:00:00.000Z",530]]as const){const facts=normalizeAttendanceDayFacts({userId:7,businessDate:"2026-07-01",schedule,attendanceRecord:{id:1,status:"done",checkInAt,checkOutAt,approvalStatus:"approved"}});assert.equal(facts.actualMinutes,expected)}});
test("manual late normalization overrides timestamp-derived late minutes",()=>{const input={userId:7,businessDate:"2026-07-01",schedule,attendanceRecord:{id:1,status:"done",checkInAt:"2026-07-01T09:10:00.000Z",checkOutAt:"2026-07-01T18:00:00.000Z",approvalStatus:"approved",storedLateMinutes:0}};assert.equal(normalizeAttendanceDayFacts(input).lateMinutes,10);assert.equal(normalizeAttendanceDayFacts({...input,manualLateNormalized:true}).lateMinutes,0)});
