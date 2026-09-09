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

test("hourly-only bilingual UI uses compact rows, small actions, a details toggle, blocking reason, and paid lock", () => {
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
  assert.match(ui, /disabled=\{paid \|\|/);
  assert.match(ui, /method: "DELETE"/);
});

test("extra-work review calculation and UI stay hourly-only, including the fixed-monthly early return", () => {
  assert.match(monthly, /if\(isPartTimeExtraWorkEligible\(contract\.payType\)&&record\?\.check_in_at&&record\.check_out_at\)/);
  assert.match(monthly, /calculationBasis:"fixed_monthly"[\s\S]*?partTimeExtraWork:\[\]/);
  assert.match(card, /employee\.contract\.payType === "hourly" && <PartTimeExtraWorkSection/);
  assert.match(monthly, /PART_TIME_EXTRA_WORK_REVIEW_REQUIRED/);
  assert.match(monthly, /PART_TIME_EXTRA_WORK_DECISION_STALE/);
});
