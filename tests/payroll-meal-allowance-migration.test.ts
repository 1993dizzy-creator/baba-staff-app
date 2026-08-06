import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { selectMealAllowanceEligibilityAt } from "../lib/payroll/meal-allowance.ts";

const MIGRATION_PATH = "supabase/migrations/202608070001_add_payroll_meal_allowance.sql";
const sql = readFileSync(join(process.cwd(), MIGRATION_PATH), "utf8");

test("migration file exists and is transaction-wrapped", () => {
  // 파일 맨 앞의 설명 주석(--로 시작하는 줄)과 빈 줄을 걷어내면 첫 실행문이 begin;이어야 한다.
  const firstStatement = sql
    .split("\n")
    .find((line) => line.trim() !== "" && !line.trim().startsWith("--"));
  assert.equal(firstStatement?.trim(), "begin;");
  // 파일 끝의 "Postflight (read only)" 주석 블록을 제외하면 마지막 실행문은 commit;이어야 한다.
  const lastStatement = [...sql.split("\n")].reverse().find((line) => line.trim() !== "" && !line.trim().startsWith("--"));
  assert.equal(lastStatement?.trim(), "commit;");
});

test("migration is idempotent: table/index creation uses IF NOT EXISTS, functions use CREATE OR REPLACE, trigger uses DROP IF EXISTS", () => {
  assert.match(sql, /create table if not exists public\.payroll_meal_allowance_policy_versions/);
  assert.match(sql, /create table if not exists public\.payroll_meal_allowance_eligibility_versions/);
  assert.match(sql, /create index if not exists payroll_meal_allowance_policy_lookup_idx/);
  assert.match(sql, /create index if not exists payroll_meal_allowance_eligibility_lookup_idx/);
  assert.match(sql, /create or replace function public\.payroll_create_meal_allowance_policy_version_v1/);
  assert.match(sql, /create or replace function public\.payroll_create_meal_allowance_eligibility_version_v1/);
  assert.match(sql, /create or replace function public\.users_block_attendance_tracking_disable_when_meal_eligible/);
  assert.match(sql, /drop trigger if exists users_block_attendance_tracking_disable_when_meal_eligible on public\.users/);
});

test("policy table: daily_amount rejects negative values via CHECK constraint", () => {
  assert.match(
    sql,
    /constraint payroll_meal_allowance_policy_amount_check\s*\n\s*check \(daily_amount >= 0 and daily_amount = trunc\(daily_amount\)\)/,
  );
});

test("policy table: revision is globally unique (no user_id — company-wide setting)", () => {
  assert.match(sql, /constraint payroll_meal_allowance_policy_revision_unique unique \(revision\)/);
  assert.doesNotMatch(
    sql.slice(sql.indexOf("create table if not exists public.payroll_meal_allowance_policy_versions"), sql.indexOf("payroll_meal_allowance_eligibility_versions (")),
    /user_id/,
  );
});

test("eligibility table: is_eligible is NOT NULL, revision unique per user (append-only, no separate audit table needed)", () => {
  const eligibilityTableBlock = sql.slice(
    sql.indexOf("create table if not exists public.payroll_meal_allowance_eligibility_versions"),
    sql.indexOf("create index if not exists payroll_meal_allowance_eligibility_lookup_idx"),
  );
  assert.match(eligibilityTableBlock, /is_eligible boolean not null/);
  assert.match(eligibilityTableBlock, /user_id bigint not null references public\.users\(id\)/);
  assert.match(sql, /constraint payroll_meal_allowance_eligibility_revision_unique unique \(user_id, revision\)/);
});

test("effective_from is a plain date column on both tables (not effective_month) per date-level policy", () => {
  assert.match(sql, /payroll_meal_allowance_policy_versions[\s\S]*?effective_from date not null/);
  assert.match(sql, /payroll_meal_allowance_eligibility_versions[\s\S]*?effective_from date not null/);
});

test("no default meal amount is ever inserted by this migration (only the RPC bodies insert, never the migration script itself)", () => {
  // 함수 본문($$...$$)에서 실제 INSERT를 만드는 것은 정상 RPC 로직이다(호출 시에만 실행됨).
  // 여기서 검증할 것은 "Migration 스크립트 자체가 실행 시점에 즉시 INSERT를 실행하지
  // 않는다"는 것 — 즉 함수 정의 바깥에 top-level INSERT 문이 없어야 한다.
  const withoutFunctionBodies = sql.replace(/as \$\$[\s\S]*?\$\$;/g, "");
  assert.doesNotMatch(withoutFunctionBodies, /insert into public\.payroll_meal_allowance_policy_versions/);
  assert.doesNotMatch(withoutFunctionBodies, /insert into public\.payroll_meal_allowance_eligibility_versions/);
});

test("both RPCs reuse the existing payroll_assert_actor_v2 owner/master check instead of re-implementing actor validation", () => {
  const policyFn = sql.slice(
    sql.indexOf("create or replace function public.payroll_create_meal_allowance_policy_version_v1"),
    sql.indexOf("$$;\n\nrevoke all on function public.payroll_create_meal_allowance_policy_version_v1"),
  );
  const eligibilityFn = sql.slice(
    sql.indexOf("create or replace function public.payroll_create_meal_allowance_eligibility_version_v1"),
    sql.indexOf("$$;\n\nrevoke all on function public.payroll_create_meal_allowance_eligibility_version_v1"),
  );
  assert.match(policyFn, /perform public\.payroll_assert_actor_v2\(p_actor_user_id\);/);
  assert.match(eligibilityFn, /perform public\.payroll_assert_actor_v2\(p_actor_user_id\);/);
});

test("eligibility RPC blocks turning eligibility on for attendance-tracking-disabled employees", () => {
  const eligibilityFn = sql.slice(
    sql.indexOf("create or replace function public.payroll_create_meal_allowance_eligibility_version_v1"),
    sql.indexOf("$$;\n\nrevoke all on function public.payroll_create_meal_allowance_eligibility_version_v1"),
  );
  assert.match(
    eligibilityFn,
    /if p_is_eligible and v_target\.attendance_tracking_enabled = false then\s*\n\s*raise exception 'MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING'/,
  );
});

test("trigger blocks disabling attendance tracking while the employee is currently meal-eligible (reverse direction of the RPC check)", () => {
  const triggerFn = sql.slice(
    sql.indexOf("create or replace function public.users_block_attendance_tracking_disable_when_meal_eligible"),
    sql.indexOf("drop trigger if exists users_block_attendance_tracking_disable_when_meal_eligible"),
  );
  assert.match(triggerFn, /old\.attendance_tracking_enabled is distinct from true/);
  assert.match(triggerFn, /new\.attendance_tracking_enabled is distinct from false/);
  assert.match(triggerFn, /raise exception 'MEAL_ALLOWANCE_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE'/);
  assert.match(sql, /before update on public\.users/);
});

test("trigger fix: the eligibility check also examines future-dated (effective_from > today) versions, not just the value effective today", () => {
  const triggerFn = sql.slice(
    sql.indexOf("create or replace function public.users_block_attendance_tracking_disable_when_meal_eligible"),
    sql.indexOf("drop trigger if exists users_block_attendance_tracking_disable_when_meal_eligible"),
  );
  // 오늘 기준 현재 유효값 분기
  assert.match(triggerFn, /effective_from <= \(now\(\) at time zone 'Asia\/Ho_Chi_Minh'\)::date\s*\n\s*order by effective_from desc, revision desc\s*\n\s*limit 1/);
  // union all로 이어지는 미래 예약 분기 — effective_from > 오늘
  assert.match(triggerFn, /union all/);
  assert.match(triggerFn, /effective_from > \(now\(\) at time zone 'Asia\/Ho_Chi_Minh'\)::date/);
  // 동일 effective_from은 distinct on + revision desc로 최신 revision만 남긴다
  assert.match(triggerFn, /select distinct on \(effective_from\) is_eligible/);
  assert.match(triggerFn, /order by effective_from, revision desc/);
  // 두 분기 중 하나라도 true면 차단하는 exists(...) 구조
  assert.match(triggerFn, /select exists \(/);
  assert.match(triggerFn, /where resolved\.is_eligible = true/);
});

test("trigger fix (PostgreSQL syntax): each UNION branch is wrapped in its own parentheses — PostgreSQL requires this to attach ORDER BY/LIMIT to an individual UNION branch instead of the whole UNION result", () => {
  const triggerFn = sql.slice(
    sql.indexOf("create or replace function public.users_block_attendance_tracking_disable_when_meal_eligible"),
    sql.indexOf("drop trigger if exists users_block_attendance_tracking_disable_when_meal_eligible"),
  );
  // 첫 번째 분기: 괄호로 시작 → select is_eligible ... → order by ... → limit 1 → 괄호로 끝
  assert.match(
    triggerFn,
    /\(\s*\n(?:\s*--[^\n]*\n)*\s*select is_eligible\s*\n\s*from public\.payroll_meal_allowance_eligibility_versions\s*\n\s*where user_id = new\.id\s*\n\s*and effective_from <= \(now\(\) at time zone 'Asia\/Ho_Chi_Minh'\)::date\s*\n\s*order by effective_from desc, revision desc\s*\n\s*limit 1\s*\n\s*\)/,
  );
  // union all이 두 괄호 그룹 사이에 있다.
  assert.match(triggerFn, /\)\s*\n\s*\n\s*union all\s*\n\s*\n\s*\(/);
  // 두 번째 분기: 괄호로 시작 → distinct on(effective_from) ... → order by effective_from, revision desc → 괄호로 끝
  assert.match(
    triggerFn,
    /\(\s*\n(?:\s*--[^\n]*\n)*\s*select distinct on \(effective_from\) is_eligible\s*\n\s*from public\.payroll_meal_allowance_eligibility_versions\s*\n\s*where user_id = new\.id\s*\n\s*and effective_from > \(now\(\) at time zone 'Asia\/Ho_Chi_Minh'\)::date\s*\n\s*order by effective_from, revision desc\s*\n\s*\)/,
  );
});

test("trigger fix (PostgreSQL syntax): the two parenthesized branches sit inside a single FROM (...) subquery feeding select exists(...)", () => {
  const triggerFn = sql.slice(
    sql.indexOf("create or replace function public.users_block_attendance_tracking_disable_when_meal_eligible"),
    sql.indexOf("drop trigger if exists users_block_attendance_tracking_disable_when_meal_eligible"),
  );
  const existsIndex = triggerFn.indexOf("select exists (");
  const fromIndex = triggerFn.indexOf("from (", existsIndex);
  const resolvedIndex = triggerFn.indexOf(") resolved", fromIndex);
  assert.ok(existsIndex > -1 && fromIndex > existsIndex && resolvedIndex > fromIndex);
  const subquery = triggerFn.slice(fromIndex, resolvedIndex);
  // 괄호로 감싼 두 UNION 분기가 정확히 이 서브쿼리 구간 안에 있어야 한다.
  assert.match(subquery, /\(\s*\n\s*(?:--[^\n]*\n\s*)*select is_eligible/);
  assert.match(subquery, /union all/);
  assert.match(subquery, /select distinct on \(effective_from\) is_eligible/);
});

test("trigger fix: error code, message intent, trigger name and BEFORE UPDATE wiring are unchanged by the fix", () => {
  assert.match(sql, /create trigger users_block_attendance_tracking_disable_when_meal_eligible\s*\n\s*before update on public\.users\s*\n\s*for each row\s*\n\s*execute function public\.users_block_attendance_tracking_disable_when_meal_eligible\(\);/);
  const occurrences = sql.match(/'MEAL_ALLOWANCE_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE'/g) ?? [];
  assert.ok(occurrences.length >= 1);
});

// ---------------------------------------------------------------------------
// 미래 예약 판정 semantics를 실제 production resolver(selectMealAllowanceEligibilityAt)로
// 재현해 6개 시나리오를 실제 함수 호출로 고정한다. 이 helper는 테스트 파일 안에서만
// 존재하며(운영 코드에 새 추상화를 추가하지 않음), SQL trigger가 하는 것과 동일한
// "오늘 + 미래 각 effective_from"별 판정을 동일한 resolver 의미로 검증한다.
// ---------------------------------------------------------------------------

function candidateDates(versions: { effectiveFrom: string }[], today: string) {
  const dates = new Set<string>([today]);
  for (const version of versions) {
    if (version.effectiveFrom > today) dates.add(version.effectiveFrom);
  }
  return [...dates].sort();
}

function hasConflictingEligiblePeriod(
  versions: { userId: number; id: number; isEligible: boolean; effectiveFrom: string; revision: number }[],
  today: string,
) {
  return candidateDates(versions, today).some((date) => selectMealAllowanceEligibilityAt(versions, date));
}

test("future-conflict resolver: 현재 대상=true → 차단(conflict)", () => {
  const versions = [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 }];
  assert.equal(hasConflictingEligiblePeriod(versions, "2026-08-06"), true);
});

test("future-conflict resolver: 현재 미대상, 미래(9/1) 대상=true → 차단", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-09-01", revision: 1 },
  ];
  assert.equal(hasConflictingEligiblePeriod(versions, "2026-08-06"), true);
});

test("future-conflict resolver: 미래(9/1) 대상=true, 이후 미래(10/1) 미대상=false → 9월 구간이 존재하므로 차단", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-09-01", revision: 1 },
    { id: 3, userId: 1, isEligible: false, effectiveFrom: "2026-10-01", revision: 1 },
  ];
  assert.equal(hasConflictingEligiblePeriod(versions, "2026-08-06"), true);
});

test("future-conflict resolver: 동일 미래 effective_from(9/1)의 최신 revision=false → 그 날짜 때문에 차단되지 않음(허용)", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-09-01", revision: 1 },
    { id: 3, userId: 1, isEligible: false, effectiveFrom: "2026-09-01", revision: 2 },
  ];
  assert.equal(hasConflictingEligiblePeriod(versions, "2026-08-06"), false);
});

test("future-conflict resolver: 과거에 종료된 대상=true 이력만 있고 현재·미래는 미대상 → 허용(과거 이력만으로 오탐 없음)", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 },
    { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-02-01", revision: 1 },
  ];
  assert.equal(hasConflictingEligiblePeriod(versions, "2026-08-06"), false);
});

test("future-conflict resolver: 미래 미대상 예약만 존재 → 허용", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-09-01", revision: 1 },
  ];
  assert.equal(hasConflictingEligiblePeriod(versions, "2026-08-06"), false);
});

test("revoke/grant: PUBLIC, anon, authenticated never get direct table or function access", () => {
  assert.match(
    sql,
    /revoke all on table public\.payroll_meal_allowance_policy_versions\s*\n\s*from public, anon, authenticated, service_role;/,
  );
  assert.match(
    sql,
    /revoke all on table public\.payroll_meal_allowance_eligibility_versions\s*\n\s*from public, anon, authenticated, service_role;/,
  );
  assert.match(
    sql,
    /revoke all on function public\.payroll_create_meal_allowance_policy_version_v1\(numeric, date, bigint, text\)\s*\n\s*from public, anon, authenticated;/,
  );
  assert.match(
    sql,
    /revoke all on function public\.payroll_create_meal_allowance_eligibility_version_v1\(bigint, boolean, date, bigint, text\)\s*\n\s*from public, anon, authenticated;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.payroll_create_meal_allowance_policy_version_v1\(numeric, date, bigint, text\)\s*\n\s*to service_role;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.payroll_create_meal_allowance_eligibility_version_v1\(bigint, boolean, date, bigint, text\)\s*\n\s*to service_role;/,
  );
});

test("both new functions use a fixed search_path (pg_catalog, public)", () => {
  const occurrences = sql.match(/set search_path = pg_catalog, public/g) ?? [];
  // 정책 RPC + 대상 RPC + trigger 함수 = 최소 3곳
  assert.ok(occurrences.length >= 3, `expected at least 3 fixed search_path declarations, found ${occurrences.length}`);
});

test("row level security is enabled on both new tables", () => {
  assert.match(sql, /alter table public\.payroll_meal_allowance_policy_versions enable row level security;/);
  assert.match(sql, /alter table public\.payroll_meal_allowance_eligibility_versions enable row level security;/);
});

test("existing payroll contract/insurance/payment RPCs and tables are not modified or dropped by this migration", () => {
  assert.doesNotMatch(sql, /drop (table|function) public\.payroll_contract_versions/);
  assert.doesNotMatch(sql, /drop (table|function) public\.payroll_insurance_setting_versions/);
  assert.doesNotMatch(sql, /create or replace function public\.payroll_create_contract_version/);
  assert.doesNotMatch(sql, /create or replace function public\.payroll_correct_latest_unused_contract/);
  assert.doesNotMatch(sql, /create or replace function public\.payroll_pay_employee/);
  assert.doesNotMatch(sql, /create or replace function public\.employee_update_profile_and_level/);
});

test("preflight checks required dependencies before creating anything", () => {
  const preflight = sql.slice(0, sql.indexOf("-- 1. 공통 1일 식대 금액"));
  assert.match(preflight, /payroll_assert_actor_v2/);
  assert.match(preflight, /attendance_tracking_enabled/);
  assert.match(preflight, /standard_workdays/);
  assert.match(preflight, /raise exception 'preflight failed/);
});

// ---------------------------------------------------------------------------
// 공통 설정 통합 저장 RPC (payroll_update_common_settings_v1) — payroll_settings와 식대
// 정책을 하나의 transaction으로 저장하고, 값이 실제로 바뀌었을 때만 revision을 만든다.
// ---------------------------------------------------------------------------

const commonSettingsRpc = sql.slice(
  sql.indexOf("create or replace function public.payroll_update_common_settings_v1"),
  sql.indexOf("revoke all on function public.payroll_update_common_settings_v1"),
);

test("payroll_update_common_settings_v1 exists, reuses payroll_assert_actor_v2, and is defined inside the same begin/commit transaction as everything else in this file", () => {
  assert.ok(commonSettingsRpc.length > 0, "RPC body must be found");
  assert.match(commonSettingsRpc, /perform public\.payroll_assert_actor_v2\(p_actor_user_id\);/);
  const rpcIndex = sql.indexOf("create or replace function public.payroll_update_common_settings_v1");
  const beginIndex = sql.indexOf("begin;");
  const commitIndex = sql.lastIndexOf("commit;");
  assert.ok(beginIndex < rpcIndex && rpcIndex < commitIndex, "RPC must be created inside the single begin;/commit; block");
});

test("payroll_update_common_settings_v1 updates payroll_settings and only creates a new meal policy revision when the amount or effective date actually differ from the latest version", () => {
  assert.match(commonSettingsRpc, /update public\.payroll_settings\s*\n\s*set/);
  assert.match(commonSettingsRpc, /where id = 1\s*\n\s*returning \* into v_settings;/);
  assert.match(
    commonSettingsRpc,
    /if v_meal_current_amount is distinct from p_meal_daily_amount\s*\n\s*or v_meal_current_effective_from is distinct from p_meal_effective_from then/,
  );
  assert.match(commonSettingsRpc, /v_meal_changed := true;/);
});

test("payroll_update_common_settings_v1 treats p_meal_daily_amount/p_meal_effective_from as 둘 다 null(미변경) or 둘 다 채워짐 only, rejecting a half-filled pair", () => {
  assert.match(
    commonSettingsRpc,
    /if \(p_meal_daily_amount is null\) is distinct from \(p_meal_effective_from is null\) then\s*\n\s*raise exception 'INVALID_MEAL_ALLOWANCE_POLICY'/,
  );
});

test("payroll_update_common_settings_v1 does not touch payroll_contract_versions, payroll_insurance_setting_versions, or any payment/run table", () => {
  assert.doesNotMatch(commonSettingsRpc, /payroll_contract_versions|payroll_insurance_setting_versions|payroll_run_|payroll_payment_batches|payroll_employee_payments/);
});

test("payroll_update_common_settings_v1 execute grant is revoked from public/anon/authenticated and granted only to service_role", () => {
  assert.match(
    sql,
    /revoke all on function public\.payroll_update_common_settings_v1\(\s*\n\s*bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer, integer, numeric, date, text\s*\n\s*\) from public, anon, authenticated;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.payroll_update_common_settings_v1\(\s*\n\s*bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer, integer, numeric, date, text\s*\n\s*\) to service_role;/,
  );
});

test("payroll_update_common_settings_v1: payroll_settings.id=1 not found raises immediately, before any meal-allowance logic runs (guarantees rollback of the whole transaction)", () => {
  const updateIndex = commonSettingsRpc.indexOf("update public.payroll_settings");
  const notFoundIndex = commonSettingsRpc.indexOf("if not found then");
  const raiseIndex = commonSettingsRpc.indexOf("raise exception 'PAYROLL_SETTINGS_NOT_FOUND'", notFoundIndex);
  const mealBlockIndex = commonSettingsRpc.indexOf("if p_meal_daily_amount is not null then");
  assert.ok(updateIndex > -1 && notFoundIndex > -1 && raiseIndex > -1 && mealBlockIndex > -1);
  assert.ok(updateIndex < notFoundIndex, "the not-found check must come after the UPDATE");
  assert.ok(notFoundIndex < mealBlockIndex, "the not-found check must come before the meal-allowance block — a missing settings row must never let the meal policy insert run");
  assert.match(
    commonSettingsRpc,
    /returning \* into v_settings;\s*\n\s*\n(?:\s*--[^\n]*\n)*\s*if not found then\s*\n\s*raise exception 'PAYROLL_SETTINGS_NOT_FOUND' using errcode = 'P0002';\s*\n\s*end if;/,
  );
});

test("payroll_update_common_settings_v1: no 'success' JSON path can be reached when payroll_settings.id=1 is missing — the exception aborts the function before jsonb_build_object", () => {
  const notFoundIndex = commonSettingsRpc.indexOf("raise exception 'PAYROLL_SETTINGS_NOT_FOUND'");
  const returnIndex = commonSettingsRpc.indexOf("return jsonb_build_object(");
  assert.ok(notFoundIndex > -1 && returnIndex > notFoundIndex);
});

test("payroll_update_common_settings_v1: advisory lock is acquired BEFORE re-reading the latest meal policy version (prevents a race with the standalone POST RPC creating a duplicate/conflicting revision)", () => {
  const mealBlock = commonSettingsRpc.slice(
    commonSettingsRpc.indexOf("if p_meal_daily_amount is not null then"),
    commonSettingsRpc.indexOf("return jsonb_build_object("),
  );
  const lockIndex = mealBlock.indexOf("perform pg_advisory_xact_lock(hashtext('payroll_meal_allowance_policy_versions'));");
  const selectLatestIndex = mealBlock.indexOf("select daily_amount, effective_from");
  const compareIndex = mealBlock.indexOf("if v_meal_current_amount is distinct from p_meal_daily_amount");
  const revisionSelectIndex = mealBlock.indexOf("select coalesce(max(revision), 0) + 1");
  assert.ok(lockIndex > -1 && selectLatestIndex > -1 && compareIndex > -1 && revisionSelectIndex > -1);
  assert.ok(lockIndex < selectLatestIndex, "advisory lock must be acquired before reading the latest meal policy version");
  assert.ok(selectLatestIndex < compareIndex, "the re-read latest version must be compared against the input");
  assert.ok(compareIndex < revisionSelectIndex, "revision is computed only after the comparison decides a change occurred");
  assert.ok(lockIndex < revisionSelectIndex, "revision computation happens inside the locked section");
});

test("payroll_update_common_settings_v1 and the standalone payroll_create_meal_allowance_policy_version_v1 use the exact same advisory lock key string — they serialize against each other", () => {
  const legacyRpc = sql.slice(
    sql.indexOf("create or replace function public.payroll_create_meal_allowance_policy_version_v1"),
    sql.indexOf("revoke all on function public.payroll_create_meal_allowance_policy_version_v1"),
  );
  const legacyLockCalls = legacyRpc.match(/pg_advisory_xact_lock\(hashtext\('([^']+)'\)\)/g) ?? [];
  const commonSettingsLockCalls = commonSettingsRpc.match(/pg_advisory_xact_lock\(hashtext\('([^']+)'\)\)/g) ?? [];
  assert.equal(legacyLockCalls.length, 1);
  assert.equal(commonSettingsLockCalls.length, 1);
  assert.equal(legacyLockCalls[0], commonSettingsLockCalls[0]);
  assert.equal(legacyLockCalls[0], "pg_advisory_xact_lock(hashtext('payroll_meal_allowance_policy_versions'))");
});

test("existing payroll_create_meal_allowance_policy_version_v1 (legacy standalone save) is left completely untouched by this addition", () => {
  const legacyRpc = sql.slice(
    sql.indexOf("create or replace function public.payroll_create_meal_allowance_policy_version_v1"),
    sql.indexOf("revoke all on function public.payroll_create_meal_allowance_policy_version_v1"),
  );
  assert.match(legacyRpc, /perform public\.payroll_assert_actor_v2\(p_actor_user_id\);/);
  assert.match(legacyRpc, /insert into public\.payroll_meal_allowance_policy_versions/);
});

test("this migration's filename is unique and sorts in its expected position (no accidental ordering collision)", () => {
  // 이 파일이 유일한 202608070001_*임을 확인한다 — "항상 디렉터리의 마지막 파일"이라는
  // 검증은 이후 새 Migration(예: 202608070002_...)이 정당하게 추가되면 깨지는 취약한
  // 전제라 쓰지 않는다. 대신 파일명이 고유하고, 자기보다 이른 날짜의 모든 Migration
  // 뒤에 정렬됨을 확인한다.
  const files = readdirSync(join(process.cwd(), "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  const occurrences = files.filter((name) => name === "202608070001_add_payroll_meal_allowance.sql");
  assert.equal(occurrences.length, 1);
  const index = files.indexOf("202608070001_add_payroll_meal_allowance.sql");
  assert.ok(index > -1);
  for (const earlier of files.slice(0, index)) {
    assert.ok(earlier < "202608070001_add_payroll_meal_allowance.sql");
  }
});
