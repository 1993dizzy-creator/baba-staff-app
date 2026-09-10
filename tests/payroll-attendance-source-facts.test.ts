import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { classifyPayrollAttendanceSource } from "../lib/payroll/source-facts/attendance.ts";
import type { AttendanceDayFacts, WorkScheduleVersion } from "../lib/payroll/types.ts";

const schedule: WorkScheduleVersion = { id: 4, userId: 1, startTime: "18:00", endTime: "23:00", unpaidBreakMinutes: 0, effectiveFrom: "2026-08-01", effectiveTo: null, revision: 2, changeReason: null };
const facts: AttendanceDayFacts = { userId:1,businessDate:"2026-08-09",scheduledMinutes:300,actualMinutes:280,scheduledOverlapMinutes:280,manualLateNormalized:false,lateMinutes:20,rawLateMinutes:20,effectiveLateMinutes:20,lateThresholdMinutes:0,earlyLeaveMinutes:0,rawEarlyLeaveMinutes:0,earlyLeaveThresholdMinutes:0,isEarlyLeave:false,overtimeCandidateMinutes:0,attendanceStatus:"late",payrollStatus:"calculable",warningCodes:[],stored:{status:"late",lateMinutes:20,earlyLeaveMinutes:0,workMinutes:280},source:{attendanceRecordId:7,scheduleVersionId:4,scheduleRevision:2,storeSettingsRevision:3,engineVersion:"attendance-facts-v2"} };

test("attendance source fact keeps operational facts separate from monetary amounts", () => {
  const result = classifyPayrollAttendanceSource({businessDate:"2026-08-09",facts,attendanceRecord:{id:7,status:"late",checkInAt:"2026-08-09T11:20:00Z",checkOutAt:"2026-08-09T16:00:00Z",approvalStatus:null,updatedAt:"2026-08-09T16:01:00Z"},schedule,storePolicyRevision:3});
  assert.equal(result.classification, "completed_work");
  assert.equal(result.recognizedAttendanceDay, true);
  assert.equal(result.lateMinutes, 20);
  assert.equal(result.schedule?.revision, 2);
  assert.equal(result.sourceUpdatedAt, "2026-08-09T16:01:00Z");
  assert.equal("baseWorkAmount" in result, false);
  assert.equal("lateDeductionAmount" in result, false);
});

test("leave and unauthorized absence are explicit source classifications", () => {
  const leave = classifyPayrollAttendanceSource({businessDate:"2026-08-09",facts:{...facts,actualMinutes:null,scheduledOverlapMinutes:null,attendanceStatus:"leave"},attendanceRecord:{id:8,status:"leave",checkInAt:null,checkOutAt:null,approvalStatus:"approved",updatedAt:"2026-08-09T12:00:00Z"},schedule,storePolicyRevision:3});
  const absent = classifyPayrollAttendanceSource({businessDate:"2026-08-10",facts:{...facts,businessDate:"2026-08-10",actualMinutes:null,scheduledOverlapMinutes:null,attendanceStatus:"unauthorized_absence"},attendanceRecord:{id:9,status:"unauthorized_absence",checkInAt:null,checkOutAt:null,approvalStatus:"approved",updatedAt:"2026-08-10T12:00:00Z"},schedule,storePolicyRevision:3});
  assert.equal(leave.classification, "leave");
  assert.equal(leave.leaveApproved, true);
  assert.equal(absent.classification, "unauthorized_absence");
  assert.equal(absent.unauthorizedAbsence, true);
});
