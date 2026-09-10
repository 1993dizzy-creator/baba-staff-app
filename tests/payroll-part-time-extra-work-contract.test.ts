import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/admin/payroll/part-time-extra-work/route.ts");
const monthly = read("lib/payroll/monthly-run.ts");
const overview = read("lib/payroll/overview.ts");
const ui = read("components/payroll/PartTimeExtraWorkSection.tsx");
const card = read("components/payroll/CompensationCard.tsx");

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

test("hourly-only bilingual UI uses compact rows, collapsible history, state summaries, and paid lock", () => {
  assert.match(card, /employee\.contract\.payType === "hourly"/);
  for (const label of ["파트타임 추가근무", "Làm thêm part-time", "출퇴근", "근무시간", "추가", "Chấm công", "Giờ làm", "Làm thêm", "계산 상세", "Chi tiết tính", "급여 지급 불가"]) assert.match(ui, new RegExp(label));
  assert.doesNotMatch(ui, /가게 영업시간|Giờ hoạt động cửa hàng|개인 스케줄|Lịch cá nhân/);
  assert.match(ui, /const formatDate = \(value: string\) => value\.slice\(5\)\.replace\("-", "\."\)/);
  assert.match(ui, /<details style=\{s\.details\}>/);
  assert.match(ui, /beforeScheduleMinutes.*afterScheduleMinutes.*excludedBeforeOpenMinutes.*excludedAfterCloseMinutes/);
  assert.match(ui, /출근 전 추가.*퇴근 후 추가.*제외/);
  assert.match(ui, /Làm thêm trước giờ vào ca.*Làm thêm sau giờ tan ca.*Loại trừ/);
  assert.doesNotMatch(ui, /`스케줄 전 .*스케줄 후/);
  assert.match(ui, /gridTemplateColumns: "36px minmax\(0,1fr\) auto auto"/);
  assert.match(ui, /flexWrap: "wrap"/);
  assert.match(ui, /padding: "3px 7px"/);
  assert.doesNotMatch(ui, /Thời gian ứng viên|후보 시간|candidateMinutes = rows\.reduce/);
  assert.match(ui, /reviewRequiredCount = rows\.filter\(row => row\.status === "review_required"\)\.length/);
  assert.match(ui, /staleCount = rows\.filter\(row => row\.status === "stale"\)\.length/);
  assert.match(ui, /reviewRequiredCount > 0 && <Metric label=\{vi \? "Chưa duyệt" : "미검토"\}/);
  assert.match(ui, /staleCount > 0 && <Metric label=\{vi \? "Cần duyệt lại" : "재검토"\}/);
  assert.doesNotMatch(ui, /미검토·재검토|Chưa xử lý \/ cần xem lại/);
  assert.match(ui, /const \[isExpanded, setIsExpanded\] = useState\(false\)/);
  assert.match(ui, /rows\.length === 0 \? <small[\s\S]*?isExpanded && <div id=\{listId\}/);
  for (const label of ["전체 내역 펼치기", "전체 내역 접기", "Xem toàn bộ", "Thu gọn toàn bộ"]) assert.match(ui, new RegExp(label));
  assert.match(ui, /aria-expanded=\{isExpanded\}/);
  assert.match(ui, /aria-controls=\{listId\}/);
  assert.match(ui, /maxHeight: 360, overflowY: "auto"/);
  assert.match(ui, /const disabled = paid \|\| busyId === row\.attendanceRecordId/);
  assert.match(ui, /enabledButton: \{ cursor: "pointer" \}/);
  assert.match(ui, /disabledButton: \{ cursor: "not-allowed", opacity: 0\.55 \}/);
  assert.match(ui, /disabled=\{disabled\}/);
  assert.match(ui, /method: "DELETE"/);
});

test("extra-work review calculation and UI stay hourly-only, including the fixed-monthly early return", () => {
  assert.match(monthly, /if\(isPartTimeExtraWorkEligible\(contract\.payType\)&&record\?\.check_in_at&&record\.check_out_at\)/);
  assert.match(monthly, /calculationBasis:"fixed_monthly"[\s\S]*?partTimeExtraWork:\[\]/);
  assert.match(card, /employee\.contract\.payType === "hourly" && <PartTimeExtraWorkSection/);
  assert.match(monthly, /PART_TIME_EXTRA_WORK_REVIEW_REQUIRED/);
  assert.match(monthly, /PART_TIME_EXTRA_WORK_DECISION_STALE/);
});

test("employee card header shows a compact extra-work badge only for non-empty rows and highlights unresolved work", () => {
  assert.match(card, /const extraWorkCount = employee\.partTimeExtraWork\.length/);
  assert.match(card, /employee\.partTimeExtraWork\.some\(row => row\.status === "review_required" \|\| row\.status === "stale"\)/);
  assert.match(card, /extraWorkCount > 0 \? \(/);
  assert.doesNotMatch(card, /contract\.payType[^\n]*extraWorkBadge/);
  assert.match(card, /`파트타임 추가근무 내역 \$\{extraWorkCount\}건`/);
  assert.match(card, /`Làm thêm part-time: \$\{extraWorkCount\} mục`/);
  assert.match(card, /title=\{extraWorkBadgeLabel\} aria-label=\{extraWorkBadgeLabel\}>⏱️<\/span>/);
  assert.match(card, /extraWorkNeedsReview \? s\.extraWorkBadgeAlert : \{\}/);
  assert.match(card, /extraWorkBadgeAlert: \{ background: "#ffedd5"/);

  const identityIndex = card.indexOf("<span style={s.identity}>");
  const attendanceIndex = card.indexOf("<AttendancePerfectScoreBadge", identityIndex);
  const mealIndex = card.indexOf("mealAllowanceEligible ? (", identityIndex);
  const extraWorkIndex = card.indexOf("extraWorkCount > 0 ? (", identityIndex);
  const separatorIndex = card.indexOf("s.separator", identityIndex);
  assert.ok(identityIndex > -1 && attendanceIndex > -1 && mealIndex > -1 && extraWorkIndex > -1 && separatorIndex > -1);
  assert.ok(attendanceIndex < mealIndex && mealIndex < extraWorkIndex && extraWorkIndex < separatorIndex);
});
