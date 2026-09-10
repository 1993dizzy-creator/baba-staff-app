import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/admin/payroll/part-time-extra-work/route.ts");
const monthly = read("lib/payroll/monthly-run.ts");
const overview = read("lib/payroll/overview.ts");
const ui = read("components/payroll/PartTimeExtraWorkSection.tsx");
const uiStyles = read("components/payroll/PartTimeExtraWorkSection.module.css");
const card = read("components/payroll/CompensationCard.tsx");
const payrollPage = read("app/(protected)/admin/payroll/page.tsx");

test("three production-history migration files define the decision ledger, strict grants, and RPCs", () => {
  const table = read("supabase/migrations/20260909064418_add_part_time_extra_work_decisions.sql");
  const grants = read("supabase/migrations/20260909064505_tighten_part_time_extra_work_privileges.sql");
  const rpcs = read("supabase/migrations/20260909064732_add_part_time_extra_work_decision_rpcs.sql");
  assert.match(table, /create table public\.payroll_part_time_extra_work_decisions/);
  assert.match(table, /where cancelled_at is null/);
  assert.match(grants, /revoke all .* public, anon, authenticated, service_role/);
  assert.match(grants, /grant select, insert, update .* to service_role/);
  assert.match(rpcs, /payroll_admin_set_part_time_extra_work_decision_v1/);
  assert.match(rpcs, /payroll_admin_cancel_part_time_extra_work_decision_v1/);
  assert.match(rpcs, /v_actor_role not in \('owner', 'master'\)/);
  assert.match(rpcs, /PAYROLL_EMPLOYEE_ALREADY_PAID/);
});

test("API is owner/master gated, recalculates server-side, compares sourceHash, and uses only decision RPCs", () => {
  assert.equal((route.match(/requirePayrollActor\(\)/g) ?? []).length, 3);
  assert.match(route, /loadPayrollOverview\(month\)/);
  assert.match(route, /candidate\.sourceHash !== sourceHash/);
  assert.doesNotMatch(route, /body\?\.(candidateAmount|candidateMinutes)/);
  assert.match(route, /payroll_admin_set_part_time_extra_work_decision_v1/);
  assert.match(route, /payroll_admin_cancel_part_time_extra_work_decision_v1/);
});

test("payroll integration uses a separate taxable automatic item and blocking reviews", () => {
  assert.match(monthly, /"part_time_extra_work","addition"/);
  assert.match(monthly, /PART_TIME_EXTRA_WORK_REVIEW_REQUIRED/);
  assert.match(monthly, /PART_TIME_EXTRA_WORK_DECISION_STALE/);
  assert.match(monthly, /BLOCKING_WARNING_CODES.*PART_TIME_EXTRA_WORK_REVIEW_REQUIRED.*PART_TIME_EXTRA_WORK_DECISION_STALE/);
  assert.match(overview, /partTimeExtraWorkAmount/);
  assert.match(overview, /"part_time_extra_work"/);
});

test("extra-work UI uses compact one-line summaries with one expanded row", () => {
  assert.doesNotMatch(card, /employee\.contract\.payType === "hourly" && <PartTimeExtraWorkSection/);
  assert.match(ui, /const \[expandedAttendanceId, setExpandedAttendanceId\] = useState<number \| null>\(null\)/);
  assert.match(ui, /setExpandedAttendanceId\(current => current === attendanceRecordId \? null : attendanceRecordId\)/);
  assert.match(ui, /const rowExpanded = expandedAttendanceId === row\.attendanceRecordId/);
  assert.match(ui, /className=\{styles\.summaryToggle\}[\s\S]*?formatDate\(row\.businessDate\)[\s\S]*?row\.candidateMinutes[\s\S]*?formatVnd\(row\.candidateAmount\)/);
  assert.match(ui, /rowExpanded && <div id=\{detailId\} className=\{styles\.info\}/);
  assert.doesNotMatch(ui, /<details className=\{styles\.details\}/);
  assert.match(ui, /beforeScheduleMinutes/);
  assert.match(ui, /afterScheduleMinutes/);
  assert.match(ui, /excludedBeforeOpenMinutes \+ row\.excludedAfterCloseMinutes/);
  assert.match(uiStyles, /grid-template-areas:\s*"summary controls"\s*"detail detail"/);
  assert.match(uiStyles, /\.summaryToggle\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(uiStyles, /\.summaryMain\s*\{[\s\S]*?display: flex;[\s\S]*?gap: 10px;[\s\S]*?white-space: nowrap/);
  assert.match(uiStyles, /\.extra\s*\{[\s\S]*?white-space: nowrap/);
  assert.match(uiStyles, /\.controls\s*\{[\s\S]*?white-space: nowrap/);
  assert.match(ui, /const \[isExpanded, setIsExpanded\] = useState\(false\)/);
  assert.match(ui, /rows\.length === 0 \? <small[\s\S]*?isExpanded && <div ref=\{listRef\} id=\{listId\}/);
  assert.match(ui, /data-extra-work-list[\s\S]*?data-extra-work-item[\s\S]*?data-extra-work-controls[\s\S]*?data-extra-work-info/);
  assert.match(uiStyles, /\.list\s*\{[\s\S]*?grid-auto-rows: max-content;[\s\S]*?max-height: 360px;[\s\S]*?overflow-y: auto/);
  assert.match(ui, /const disabled = paid \|\| busyId === row\.attendanceRecordId/);
  assert.match(uiStyles, /\.disabledButton\s*\{[\s\S]*?opacity: 0\.42/);
});

test("expanded details wrap into available space and omit empty facts", () => {
  assert.match(uiStyles, /\.info\s*\{[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;[\s\S]*?gap: 3px 14px/);
  assert.match(uiStyles, /\.detailLine\s*\{[\s\S]*?flex: 1 1 145px/);
  assert.match(uiStyles, /@media \(max-width: 480px\)[\s\S]*?\.summaryMain\s*\{[\s\S]*?gap: 8px/);
  assert.match(ui, /hasValidDateTime\(row\.checkInAt\) && hasValidDateTime\(row\.checkOutAt\)/);
  assert.match(ui, /row\.scheduleStartTime && row\.scheduleEndTime/);
  assert.match(ui, /row\.beforeScheduleMinutes > 0 && <DetailLine accent/);
  assert.match(ui, /row\.afterScheduleMinutes > 0 && <DetailLine accent/);
  assert.match(ui, /excludedMinutes > 0 && <DetailLine wide/);
  assert.match(ui, /excludedParts\.join\(" · "\)/);
});

test("extra-work action clicks do not toggle row details", () => {
  assert.match(ui, /onClick=\{\(\) => toggleRow\(row\.attendanceRecordId\)\}/);
  assert.match(ui, /className=\{styles\.actions\} onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.ok((ui.match(/event\.stopPropagation\(\)/g) ?? []).length >= 4);
  assert.match(ui, /void decide\(row\.attendanceRecordId, "approved", row\.sourceHash\)/);
  assert.match(ui, /void decide\(row\.attendanceRecordId, "rejected", row\.sourceHash\)/);
  assert.match(ui, /void cancel\(row\.attendanceRecordId\)/);
  assert.match(ui, /method: "POST"/);
  assert.match(ui, /method: "DELETE"/);
});

test("extra-work actions preserve open UI and scroll through background refresh", () => {
  assert.match(payrollPage, /loading&&!overview\?<div style=\{styles\.state\}/);
  assert.match(payrollPage, /error&&!overview\?<div role="alert"/);
  assert.match(payrollPage, /<CompensationCard key=\{employee\.userId\}/);
  assert.match(ui, /captureScrollPosition\(\);[\s\S]*?setBusyId\(attendanceRecordId\)/);
  assert.match(ui, /listScrollTop: listRef\.current\?\.scrollTop \?\? 0/);
  assert.match(ui, /windowScrollY: window\.scrollY/);
  assert.match(ui, /useLayoutEffect\(\(\) => \{[\s\S]*?listRef\.current\.scrollTop = saved\.listScrollTop[\s\S]*?window\.scrollTo\([\s\S]*?saved\.windowScrollY[\s\S]*?requestAnimationFrame/);
  assert.match(ui, /\}, \[rows\]\)/);
  assert.match(ui, /pendingScrollRestoreRef\.current = null/);
});

test("mobile summary stays compact and keeps the established action palette", () => {
  assert.match(uiStyles, /@media \(max-width: 480px\)/);
  assert.match(uiStyles, /@media \(max-width: 480px\)[\s\S]*?\.item\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) max-content;[\s\S]*?min-height: 31px/);
  assert.match(uiStyles, /@media \(max-width: 480px\)[\s\S]*?\.actionButton\s*\{[\s\S]*?min-height: 23px;[\s\S]*?font-size: 8\.5px/);
  assert.match(uiStyles, /\.approve\s*\{[\s\S]*?border: 1px solid #dcfce7;[\s\S]*?background: #f7fcf8;[\s\S]*?color: #166534/);
  assert.match(uiStyles, /\.reject\s*\{[\s\S]*?border: 1px solid #fee2e2;[\s\S]*?background: #fff8f8;[\s\S]*?color: #991b1b/);
  assert.doesNotMatch(uiStyles, /\.approve\s*\{[^}]*background: #166534|\.reject\s*\{[^}]*background: #b91c1c/);
});

test("extra-work review calculation covers attendance-based contracts while fixed-monthly stays excluded", () => {
  assert.match(monthly, /if\(isExtraWorkEligible\(contract\)&&record\?\.check_in_at&&record\.check_out_at\)/);
  assert.match(monthly, /minuteRateAmount:rate\.minuteRate/);
  assert.match(monthly, /hourlyRateAmount:vnd\(rate\.minuteRate\*60\)/);
  assert.doesNotMatch(monthly, /hourlyRateAmount:compensation\.combinedSalary/);
  assert.match(monthly, /calculationBasis:"fixed_monthly"[\s\S]*?partTimeExtraWork:\[\]/);
  assert.match(card, /employee\.contract\.calculationBasis !== "fixed_monthly" && <PartTimeExtraWorkSection/);
  assert.doesNotMatch(monthly, /reviews\.push\(review\("OVERTIME_APPROVAL_UNAVAILABLE"/);
  assert.doesNotMatch(read("lib/payroll/attendance-facts.ts"), /warnings\.push\("OVERTIME_APPROVAL_UNAVAILABLE"\)/);
});

test("employee card keeps a stable user key and shows the extra-work badge only for non-empty rows", () => {
  assert.match(payrollPage, /<CompensationCard key=\{employee\.userId\}/);
  assert.match(card, /const extraWorkCount = employee\.partTimeExtraWork\.length/);
  assert.match(card, /employee\.partTimeExtraWork\.some\(row => row\.status === "review_required" \|\| row\.status === "stale"\)/);
  assert.match(card, /extraWorkCount > 0 \? \(/);
  assert.doesNotMatch(card, /contract\.payType[^\n]*extraWorkBadge/);
});
