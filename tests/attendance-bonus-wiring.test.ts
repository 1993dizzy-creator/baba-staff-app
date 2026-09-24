import assert from "node:assert/strict";import {readFileSync} from "node:fs";import {join} from "node:path";import test from "node:test";const read=(p:string)=>readFileSync(join(process.cwd(),p),"utf8");
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import {attendanceBonusProgressIcon,shouldShowAttendancePerfectScoreBadge} from "../lib/payroll/attendance-bonus.ts";
test("monthly summary is batch-oriented and contains no payroll overview",()=>{const server=read("lib/attendance/monthly-standing-server.ts");const route=read("app/api/attendance/monthly-summary/route.ts");assert.match(server,/Promise\.all/);assert.doesNotMatch(server,/loadPayrollOverview/);assert.doesNotMatch(route,/loadPayrollOverview/)});
test("monthly standing combines store hours with the shared holiday operation policy and scopes overrides to monthly attendance ids",()=>{const server=read("lib/attendance/monthly-standing-server.ts");assert.match(server,/store_business_hours\(weekday,is_closed,open_time,close_time\)/);assert.match(server,/countHolidayGroupSizes|isBabaPremiumHoliday/);assert.doesNotMatch(server,/closedHolidayDates|!embedded/);assert.match(server,/\.in\("attendance_record_id", attendanceRecordIds\)/);assert.match(server,/classifyMonthlyAttendanceDay|resolveAttendanceStoreClosed/)});
test("staff and leave pages do not load payroll overview",()=>{assert.doesNotMatch(read("app/(protected)/attendance/staff/page.tsx"),/loadPayrollOverview|payroll\/overview/);assert.doesNotMatch(read("app/(protected)/attendance/leave/page.tsx"),/loadPayrollOverview|payroll\/overview/)});
test("non-admin-attendance screens keep using the shared perfect-only badge",()=>{for(const file of ["app/(protected)/attendance/page.tsx","app/(protected)/attendance/staff/page.tsx","app/(protected)/attendance/leave/page.tsx","components/payroll/CompensationCard.tsx"]){assert.match(read(file),/AttendancePerfectScoreBadge/,file)}assert.match(read("app/(protected)/admin/payroll/attendance/page.tsx"),/AttendanceBonusProgressBadge/)});
test("perfect-attendance badge requires both bonus eligibility and current perfect attendance",()=>{
 assert.equal(shouldShowAttendancePerfectScoreBadge(false,true),false);
 assert.equal(shouldShowAttendancePerfectScoreBadge(true,true),true);
 assert.equal(shouldShowAttendancePerfectScoreBadge(true,false),false);
});
test("admin attendance progress icon distinguishes perfect, eligible fallback and ineligible",()=>{
 assert.equal(attendanceBonusProgressIcon(true,true),"perfect");
 assert.equal(attendanceBonusProgressIcon(true,false),"eligible");
 assert.equal(attendanceBonusProgressIcon(false,true),null);
 const adminPage=read("app/(protected)/admin/payroll/attendance/page.tsx");
 const progressBadge=read("components/attendance/AttendanceBonusProgressBadge.tsx");
 assert.match(adminPage,/AttendanceBonusProgressBadge/);
 assert.match(progressBadge,/perfect \? "💯" : String\.fromCodePoint\(0x1F4C5\)/);
 assert.doesNotMatch(progressBadge,/\u2728/);
 for(const file of ["app/(protected)/attendance/page.tsx","app/(protected)/attendance/staff/page.tsx","app/(protected)/attendance/leave/page.tsx","components/payroll/CompensationCard.tsx"]){assert.doesNotMatch(read(file),/AttendanceBonusProgressBadge/,file)}
 assert.match(progressBadge,/"현재까지 개근 조건 충족"/);
 assert.match(progressBadge,/"개근 보너스 대상"/);
 assert.match(progressBadge,/"Đạt điều kiện chuyên cần đến hiện tại"/);
 assert.match(progressBadge,/"Thuộc đối tượng thưởng chuyên cần"/);
});
test("every perfect-attendance badge call passes the month-scoped eligibility guard",()=>{for(const file of ["app/(protected)/attendance/page.tsx","app/(protected)/admin/payroll/attendance/page.tsx","app/(protected)/attendance/staff/page.tsx","app/(protected)/attendance/leave/page.tsx","components/payroll/CompensationCard.tsx"]){const source=read(file);for(const call of source.matchAll(/<AttendancePerfectScoreBadge[\s\S]*?\/>/g))assert.match(call[0],/eligible=\{/,file)}});
test("monthly attendance summary reuses the existing attendance-bonus eligibility resolver",()=>{const route=read("app/api/attendance/monthly-summary/route.ts");assert.match(route,/loadAttendanceBonusVersions/);assert.match(route,/selectAttendanceBonusEligibilityAt/);assert.match(route,/attendanceBonusEligible/)});
test("payroll emits one deterministic automatic attendance bonus and separates incentive totals",()=>{const overviewServer=read("lib/payroll/overview-server.ts");const overview=read("lib/payroll/overview.ts");assert.match(overviewServer,/category:"attendance_bonus"/);assert.match(overviewServer,/itemType:"automatic"/);assert.match(overview,/manualIncentiveAmount/);assert.match(overview,/automaticIncentiveAmount/);assert.match(overview,/manualIncentiveAmount\+automaticIncentiveAmount/)});
test("attendance bonus source snapshot distinguishes payroll and effective months",()=>{const overviewServer=read("lib/payroll/overview-server.ts");assert.match(overviewServer,/payrollMonth:month/);assert.match(overviewServer,/policyEffectiveMonth:bonusPolicy\.effectiveMonth/);assert.match(overviewServer,/eligibilityEffectiveMonth:eligibility\?\.effectiveMonth/);assert.doesNotMatch(overviewServer,/effectiveMonth:month/)});
test("employee incentive detail exposes automatic source without salary fields",()=>{const summary=read("lib/payroll/attendance-self-summary.ts");const route=read("app/api/attendance/payroll-summary/route.ts");assert.match(summary,/sourceType: "automatic"/);assert.match(summary,/automaticIncentives/);assert.doesNotMatch(route,/contractSalary|currentAmount|netPayoutAmount/)});
