import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import {resolveEarlyLeaveReview} from "../lib/attendance/early-leave-review.ts";
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import {evaluateAttendancePolicy} from "../lib/attendance/policy-engine.ts";
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import {normalizeAttendanceDayFacts} from "../lib/payroll/attendance-facts.ts";
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import {calculateTimePenalty} from "../lib/payroll/penalties.ts";
import type {EarlyLeaveSelection} from "../lib/attendance/early-leave-review";
const read=(p:string)=>readFileSync(p,"utf8");
const checkOut=(raw:number)=>new Date(new Date("2026-09-02T01:00:00+07:00").getTime()-raw*60_000).toISOString();
const schedule={id:1,userId:9,startTime:"16:00",endTime:"01:00",unpaidBreakMinutes:0,effectiveFrom:"2026-09-01",effectiveTo:null,revision:1,changeReason:null};
function attendance(raw:number, selection?:EarlyLeaveSelection) {
 return evaluateAttendancePolicy({businessDate:"2026-09-01",timezone:"Asia/Ho_Chi_Minh",businessDayCutoffTime:"03:00",settingsRevision:1,scheduledStartTime:"16:00",scheduledEndTime:"01:00",storeOpenTime:"16:00",storeCloseTime:"01:00",lateGraceMinutes:5,earlyLeaveGraceMinutes:60,missingCheckoutGraceMinutes:60,overrideCloseTime:null,checkInAt:"2026-09-01T16:00:00+07:00",checkOutAt:checkOut(raw),earlyLeaveSelection:selection});
}
function facts(raw:number, selection?:EarlyLeaveSelection) {
 return normalizeAttendanceDayFacts({userId:9,businessDate:"2026-09-01",schedule,earlyLeaveGraceMinutes:60,earlyLeaveSelection:selection,
 attendanceRecord:{id:1,status:raw>60?"early_leave":"done",checkInAt:"2026-09-01T16:00:00+07:00",checkOutAt:checkOut(raw),approvalStatus:null}});
}
for(const raw of [59,60,61,120]) test(`raw ${raw}/grace 60 has matching attendance/payroll review boundaries`,()=>{
 const result=attendance(raw);const day=facts(raw);
 assert.equal(result.rawEarlyLeaveMinutes,raw);
 assert.equal(result.effectiveEarlyLeaveMinutes,Math.max(0,raw-60));
 assert.equal(result.earlyLeaveReviewRequired,raw>60);
 assert.equal(day.warningCodes.includes("EARLY_LEAVE_REVIEW_REQUIRED"),raw>60);
 if(raw<=60){assert.equal(result.earlyLeaveMinutes,0);assert.equal(day.earlyLeaveMinutes,0)}
});
for(const selection of ["use_raw","use_effective"] as const) for(const raw of [61,120]) test(`${selection} selects consistent attendance/payroll minutes and 30-minute penalty for raw ${raw}`,()=>{
 const result=attendance(raw,selection);const day=facts(raw,selection);const expected=selection==="use_raw"?raw:raw-60;
 assert.equal(result.earlyLeaveMinutes,expected);assert.equal(day.earlyLeaveMinutes,expected);
 assert.equal(result.earlyLeaveReviewRequired,false);assert.equal(day.warningCodes.includes("EARLY_LEAVE_REVIEW_REQUIRED"),false);
 const penalty=calculateTimePenalty({effectiveMinutes:day.earlyLeaveMinutes,minuteRate:1000});
 assert.equal(penalty.penaltyMinutes,Math.ceil(expected/30)*30);assert.equal(penalty.amount,Math.ceil(expected/30)*30000);
});
test("August retains the existing grace subtraction without review",()=>{
 assert.deepEqual(resolveEarlyLeaveReview({businessDate:"2026-08-31",rawEarlyLeaveMinutes:120,earlyLeaveGraceMinutes:60,selection:"use_raw"}),{
 effectiveEarlyLeaveMinutes:60,earlyLeaveMinutes:60,earlyLeaveReviewRequired:false,earlyLeaveSelection:null});
});
test("store early closing is the shared raw baseline and late normalization remains independent",()=>{
 const day=normalizeAttendanceDayFacts({userId:9,businessDate:"2026-09-01",schedule,earlyLeaveGraceMinutes:60,earlyLeaveSelection:"use_raw",normalCheckoutThresholdAt:"2026-09-01T23:00:00+07:00",manualLateNormalized:true,
 attendanceRecord:{id:1,status:"early_leave",checkInAt:"2026-09-01T16:20:00+07:00",checkOutAt:"2026-09-01T21:59:00+07:00",approvalStatus:null}});
 assert.equal(day.rawEarlyLeaveMinutes,61);assert.equal(day.earlyLeaveMinutes,61);assert.equal(day.lateMinutes,0);assert.equal(day.effectiveLateMinutes,20);
});
test("admin APIs and both language UIs wire review, resolution and date-specific navigation",()=>{
 const admin=read("app/api/attendance/admin/route.ts");const records=read("app/api/attendance/records/route.ts");
 const overview=read("app/(protected)/admin/payroll/attendance/page.tsx");const detail=read("app/(protected)/admin/payroll/attendance/[userId]/page.tsx");
 assert.match(admin,/earlyLeaveReviewRecords: earlyLeaveReviews/);assert.match(admin,/context\.earlyLeaveReviewRequired/);
 assert.match(admin,/isEarlyLeaveSelection\(selection\)/);assert.match(admin,/p_expected_threshold_at: resolved\.normalCheckoutThresholdAt/);
 assert.match(admin,/p_expected_grace_minutes: resolved\.earlyLeaveGraceMinutes/);assert.match(admin,/PAYROLL_PAID_LOCKED/);
 assert.match(records,/early_leave_review: earlyLeaveContexts\.get/);
 assert.match(overview,/earlyLeaveReviewBanner/);assert.match(overview,/goDetailForDate\(record\.user_id, record\.work_date\)/);
 assert.match(overview,/action: "resolve_early_leave"/);assert.match(overview,/unresolvedOpenRecordsBanner/);
 assert.match(detail,/action: "resolve_early_leave"/);assert.match(detail,/onResolveEarlyLeave\(record\.id, "use_raw"\)/);assert.match(detail,/onResolveEarlyLeave\(record\.id, "use_effective"\)/);
 const text=read("lib/text/attendance.ts");assert.match(text,/조퇴 적용 기준 확인 필요/);assert.match(text,/Cần xác nhận cách tính phút về sớm/);
 const payroll=read("lib/payroll/monthly-run.ts");assert.match(payroll,/BLOCKING_WARNING_CODES=new Set<string>\(\["EARLY_LEAVE_REVIEW_REQUIRED"/);
 assert.match(payroll,/earlyLeaveSelection:record\?input\.earlyLeaveContexts/);
 assert.match(payroll,/calculateTimePenalty\(\{effectiveMinutes:facts\.earlyLeaveMinutes/);
});
