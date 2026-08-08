import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const monthlyRun = read("lib/payroll/monthly-run.ts");
const timelineCore = read("lib/payroll/store-setting-timeline.ts");

// ---------------------------------------------------------------------------
// /admin/payroll 로딩 성능 최적화 1차 B — loadPayrollMonthSnapshot()의 날짜별
// store_get_settings_overview_v1 RPC 반복 호출(진행 중인 달 최대 7회, 완료월 최대
// 31회)을 store_setting_versions timeline 단일 조회 + 메모리 resolution으로 대체한다.
// ---------------------------------------------------------------------------

test("the per-date store_get_settings_overview_v1 RPC loop is completely gone from monthly-run.ts (a comment may still name the old RPC for context, but no rpc() call to it remains)", () => {
  assert.doesNotMatch(monthlyRun, /dates\.map\(date=>supabaseServer\.rpc\("store_get_settings_overview_v1"/);
  assert.doesNotMatch(monthlyRun, /\.rpc\("store_get_settings_overview_v1"/);
  assert.doesNotMatch(monthlyRun, /Promise\.all\(dates\.map\(/);
});

test("monthly-run.ts now queries store_setting_versions exactly once (with the store_attendance_policies embed), not per date", () => {
  assert.equal((monthlyRun.match(/\.from\("store_setting_versions"\)/g) ?? []).length, 1);
  assert.match(
    monthlyRun,
    /\.from\("store_setting_versions"\)\.select\("id,revision,effective_from_business_date,store_attendance_policies\(late_grace_minutes,early_leave_grace_minutes\)"\)\.eq\("state","active"\)\.lte\("effective_from_business_date",lastDate\)\.order\("effective_from_business_date",\{ascending:true\}\)\.order\("id",\{ascending:true\}\)/,
  );
});

test("dates=[] (e.g. a future payroll month with no calculationEndDate) skips the store settings query entirely — no query is issued, not even a cheap one", () => {
  const callSite = monthlyRun.slice(monthlyRun.indexOf("lastDate\n      ? supabaseServer.from(\"store_setting_versions\")"));
  const ternary = callSite.slice(0, callSite.indexOf(",\n    supabaseServer.from(\"payroll_insurance_setting_versions\")"));
  assert.match(ternary, /: Promise\.resolve\(\{data:\[\],error:null\}\)/);
});

test("monthly-run.ts delegates date resolution to the pure resolvePayrollAttendancePolicyByDate helper instead of building the Map inline from RPC results", () => {
  assert.match(monthlyRun, /import \{ resolvePayrollAttendancePolicyByDate, type PayrollStoreSettingTimelineRow \} from "\.\/store-setting-timeline";/);
  assert.match(monthlyRun, /const settingsByDate=resolvePayrollAttendancePolicyByDate\(dates,settingTimeline\);/);
});

test("the row-embed mapping defensively handles both a single-object and an array embed shape from PostgREST (cardinality is not hard-assumed)", () => {
  const mapLine = monthlyRun.slice(monthlyRun.indexOf("const settingTimeline:PayrollStoreSettingTimelineRow[]="));
  assert.match(mapLine.slice(0, mapLine.indexOf("\n")), /Array\.isArray\(rawPolicy\)\?rawPolicy\[0\]\?\?null:rawPolicy/);
});

test("a missing store_attendance_policies embed (null grace columns) maps to null, not 0, so the pure resolver's own 0-fallback is the single source of truth", () => {
  const mapLine = monthlyRun.slice(monthlyRun.indexOf("const settingTimeline:PayrollStoreSettingTimelineRow[]="));
  const firstLine = mapLine.slice(0, mapLine.indexOf("\n"));
  assert.match(firstLine, /lateGraceMinutes:policy\?\.late_grace_minutes==null\?null:Number\(policy\.late_grace_minutes\)/);
  assert.match(firstLine, /earlyLeaveGraceMinutes:policy\?\.early_leave_grace_minutes==null\?null:Number\(policy\.early_leave_grace_minutes\)/);
});

test("settingTimelineResult participates in the same combined error check as every other snapshot query (no silent partial failure)", () => {
  assert.match(
    monthlyRun,
    /if\(userResult\.error\|\|attendanceResult\.error\|\|overrideResult\.error\|\|contractResult\.error\|\|scheduleResult\.error\|\|settingTimelineResult\.error\|\|insuranceResult\.error\|\|payrollSettingsResult\.error\|\|levelProgramResult\.error\)throw new Error\("PAYROLL_MONTH_SNAPSHOT_READ_FAILED"\);/,
  );
});

test("context and sourceSnapshot (the payment snapshot/hash input) are untouched — this change only touches how settings are read, not what monthly-run returns", () => {
  assert.match(monthlyRun, /context:\{users:input\.users,contracts:input\.contracts,attendance:input\.attendance\}/);
  assert.match(
    monthlyRun,
    /sourceSnapshot:\{engineVersion:PAYROLL_RUN_ENGINE_VERSION,calculatedAt:new Date\(\)\.toISOString\(\),calculationEndDate,attendanceRecordIds:input\.attendance\.map\(row=>row\.id\),contractRevisions:\[\.\.\.new Set\(input\.contracts\.map\(row=>row\.revision\)\)\],scheduleRevisions:\[\.\.\.new Set\(input\.schedules\.map\(row=>row\.revision\)\)\],levelProgramVersions:\[\.\.\.levelPrograms\.entries\(\)\]\.map\(\(\[userId,version\]\)=>\(\{userId,\.\.\.version\}\)\),storeSettingRevisions:\[\.\.\.new Set\(\[\.\.\.settingsByDate\.values\(\)\]\.map\(value=>value\.revision\)\.filter\(value=>value!==null\)\)\],insuranceSettings:insuranceSettingsSnapshot,penaltySettings:\{\.\.\.penaltySettings,capturedAt:new Date\(\)\.toISOString\(\)\}\}/,
  );
});

test("BatchInput.settingsByDate consumers (calculateEmployee) are untouched — same .get(date) lookup with the same {revision,lateGraceMinutes,earlyLeaveGraceMinutes} shape", () => {
  assert.match(monthlyRun, /const settings=input\.settingsByDate\.get\(date\)\?\?\{revision:null,lateGraceMinutes:0,earlyLeaveGraceMinutes:0\};/);
});

// ---------------------------------------------------------------------------
// lib/payroll/store-setting-timeline.ts — pure core, no Supabase/server-only import
// (same core/adapter split as business-time-adapter-core.ts / policy-resolution-core.ts)
// ---------------------------------------------------------------------------

test("store-setting-timeline.ts is a pure module — no server-only or Supabase import, so it can be unit-tested directly and reused without a DB round-trip", () => {
  assert.doesNotMatch(timelineCore, /server-only/);
  assert.doesNotMatch(timelineCore, /supabaseServer|@\/lib\/supabase/);
});

test("store-setting-timeline.ts exports the exact Map value shape monthly-run.ts's settingsByDate has always used", () => {
  assert.match(timelineCore, /export type PayrollAttendancePolicyByDate = \{\s*\n\s*revision: number \| null;\s*\n\s*lateGraceMinutes: number;\s*\n\s*earlyLeaveGraceMinutes: number;\s*\n\s*\};/);
});

// ---------------------------------------------------------------------------
// scope discipline — nothing else about the snapshot/payment/hash pipeline changed
// ---------------------------------------------------------------------------

test("scope discipline: monthly-payroll-v7 engine version, calculatePayrollBatch/calculateEmployee formulas, and store_get_settings_overview_v1 itself (the RPC/migration) are all untouched by this change", () => {
  assert.match(monthlyRun, /export const PAYROLL_RUN_ENGINE_VERSION = "monthly-payroll-v7";/);
  assert.match(monthlyRun, /export function calculatePayrollBatch\(input:BatchInput\):PayrollRunEmployeeInput\[\]\{/);
  // No new/modified migration file for this phase — the RPC's own SQL definition is not part of this diff.
  assert.doesNotMatch(monthlyRun, /create (or replace )?function/);
});
