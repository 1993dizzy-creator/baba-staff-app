import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const MIGRATION_PATH = "supabase/migrations/202608070006_flatten_employee_management_rpcs.sql";
const migration = read(MIGRATION_PATH);
const usersRoute = read("app/api/admin/users/route.ts");
const createRoute = read("app/api/admin/users/create/route.ts");

function section(name: string, nextName?: string) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  assert.ok(start > -1, `expected to find create or replace function public.${name}(`);
  const end = nextName ? migration.indexOf(`create or replace function public.${nextName}(`, start) : migration.length;
  return migration.slice(start, end === -1 ? migration.length : end);
}

const v9 = section("employee_update_profile_and_level_v9", "employee_create_with_schedule_v5");
const v5 = section("employee_create_with_schedule_v5", "employee_rehire_with_level_policy_v3");
const rehireV3 = section("employee_rehire_with_level_policy_v3");

// ---------------------------------------------------------------------------
// 0. migration 구조
// ---------------------------------------------------------------------------

test("migration file is transactional", () => {
  assert.match(migration, /^begin;$/m);
  assert.match(migration.trimEnd(), /commit;$/);
});

test("migration only uses CREATE OR REPLACE for these three — never DROP FUNCTION, so existing grants stay attached automatically (signatures unchanged)", () => {
  assert.doesNotMatch(migration, /drop function/i);
  assert.equal((migration.match(/create or replace function public\.employee_update_profile_and_level_v9\(/g) ?? []).length, 1);
  assert.equal((migration.match(/create or replace function public\.employee_create_with_schedule_v5\(/g) ?? []).length, 1);
  assert.equal((migration.match(/create or replace function public\.employee_rehire_with_level_policy_v3\(/g) ?? []).length, 1);
});

test("migration never drops or replaces any of the old versioned RPCs it flattens away from — they are left as-is for a later cleanup phase", () => {
  for (const name of [
    "employee_update_profile_and_level_v2", "employee_update_profile_and_level_v3",
    "employee_update_profile_and_level_v4", "employee_update_profile_and_level_v5",
    "employee_update_profile_and_level_v6", "employee_update_profile_and_level_v7",
    "employee_update_profile_and_level_v8",
    "employee_create_with_schedule_v1", "employee_create_with_schedule_v2",
    "employee_create_with_schedule_v3", "employee_create_with_schedule_v4",
    "employee_rehire_with_level_policy_v2", "employee_rehire_with_level_reset_v1",
  ]) {
    assert.doesNotMatch(migration, new RegExp(`(create|create or replace|drop)\\s+function\\s+public\\.${name}\\(`));
  }
});

test("migration signatures for v9/v5/rehire-v3 are byte-identical to their current production signatures (no arg added/removed/reordered)", () => {
  assert.match(v9, /employee_update_profile_and_level_v9\(\s*p_user_id bigint,\s*p_updates jsonb,\s*p_level_program_enabled boolean,\s*p_effective_from date,\s*p_base_date_mode text,\s*p_base_date_override date,\s*p_change_reason text,\s*p_actor_id bigint,\s*p_actor_username text\s*\)/);
  assert.match(v5, /employee_create_with_schedule_v5\(\s*p_employee jsonb,\s*p_level_program_enabled boolean,\s*p_change_reason text,\s*p_actor_id bigint,\s*p_actor_username text\s*\)/);
  assert.match(rehireV3, /employee_rehire_with_level_policy_v3\(\s*p_user_id bigint,\s*p_rehire_date date,\s*p_level_program_enabled boolean,\s*p_change_reason text,\s*p_actor_id bigint,\s*p_actor_username text,\s*p_previous_level smallint\s*\)/);
});

// ---------------------------------------------------------------------------
// 1. 각 entry가 구버전 RPC를 더 이상 호출하지 않는지(핵심 목표).
// ---------------------------------------------------------------------------

test("v9 body no longer calls v8 or v7 as actual function calls (only mentioned in explanatory comments)", () => {
  assert.doesNotMatch(v9, /public\.employee_update_profile_and_level_v8\(/);
  assert.doesNotMatch(v9, /public\.employee_update_profile_and_level_v7\(/);
});

test("v5 body no longer calls v4 (or v1/v2/v3) as actual function calls", () => {
  assert.doesNotMatch(v5, /public\.employee_create_with_schedule_v[1-4]\(/);
});

test("rehire v3 body no longer calls employee_rehire_with_level_reset_v1 (or v2) as actual function calls", () => {
  assert.doesNotMatch(rehireV3, /public\.employee_rehire_with_level_reset_v1\(/);
  assert.doesNotMatch(rehireV3, /public\.employee_rehire_with_level_policy_v2\(/);
});

test("none of the three flattened entries call any other versioned employee_* RPC at all (declaration header excluded — only the function body counts)", () => {
  const versionedCallPattern = /public\.employee_[a-z_]+_v\d\(/g;
  for (const [name, body] of [["v9", v9], ["v5", v5], ["rehire v3", rehireV3]] as const) {
    const bodyOnly = body.slice(body.indexOf("as $$"));
    const calls = [...bodyOnly.matchAll(versionedCallPattern)].map((m) => m[0]);
    assert.deepEqual(calls, [], `${name} should not call any versioned RPC, found: ${calls.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 정책 보존 검증 — exception 코드가 흡수 전/후 정확히 동일한 개수로 남아있는지.
// ---------------------------------------------------------------------------

test("v9: every validation from the old v9+v8+v7 chain is preserved (same exception codes, same or fewer redundant fetches)", () => {
  const codes = [...v9.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(codes, [
    "ATTENDANCE_OPEN_RECORD_EXISTS",
    "BASE_DATE_AFTER_TERMINATION_DATE", "BASE_DATE_AFTER_TERMINATION_DATE",
    "BASE_DATE_BEFORE_HIRE_DATE", "BASE_DATE_BEFORE_HIRE_DATE",
    "BASE_DATE_IN_FUTURE", "BASE_DATE_IN_FUTURE",
    "CHANGE_REASON_REQUIRED",
    "EMPLOYEE_NOT_FOUND",
    "FORBIDDEN",
    "HIRE_DATE_REQUIRED", "HIRE_DATE_REQUIRED",
    "INVALID_BASE_DATE_MODE",
    "INVALID_EMPLOYEE_UPDATES", "INVALID_EMPLOYEE_UPDATE_KEY",
    "INVALID_LEVEL_EFFECTIVE_MONTH",
    "SYSTEM_ACCOUNT_NOT_ELIGIBLE", "SYSTEM_ACCOUNT_NOT_ELIGIBLE", "SYSTEM_ACCOUNT_NOT_ELIGIBLE",
    "TERMINATED_EMPLOYEE_READ_ONLY", "TERMINATED_EMPLOYEE_READ_ONLY",
    "TERMINATION_DATE_BEFORE_HIRE_DATE",
    "WORK_SCHEDULE_FUTURE_VERSION_CONFLICT",
    "WORK_SCHEDULE_TIMES_REQUIRED",
  ].sort());
});

test("v9: specific critical policies survive verbatim — attendance-open-record guard, ATTENDANCE_TRACKING skip for schedule, meal-eligibility-adjacent attendance toggle path, master/system-account level restriction, position derived from role passthrough", () => {
  assert.match(v9, /if v_before\.attendance_tracking_enabled = true\s*\n\s*and v_next_attendance_tracking_enabled = false\s*\n\s*and exists \(/);
  assert.match(v9, /where user_id = p_user_id\s*\n\s*and check_in_at is not null\s*\n\s*and check_out_at is null\s*\n\s*\) then\s*\n\s*raise exception 'ATTENDANCE_OPEN_RECORD_EXISTS'/);
  assert.match(v9, /if coalesce\(v_after\.attendance_tracking_enabled, true\) then/);
  assert.match(v9, /position = case when p_updates \? 'position' then nullif\(btrim\(p_updates ->> 'position'\), ''\) else v_before\.position end/);
  assert.match(v9, /payroll_eligible_override = case/);
});

test("v5: every validation from the old v5+v4 chain is preserved, and the hire_date-based initial schedule effective_from policy survives verbatim", () => {
  const codes = [...v5.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(codes, [
    "CHANGE_REASON_REQUIRED", "FORBIDDEN", "HIRE_DATE_REQUIRED",
    "SYSTEM_ACCOUNT_NOT_ELIGIBLE", "WORK_SCHEDULE_TIMES_REQUIRED",
  ].sort());
  assert.match(v5, /v_schedule_effective_from := coalesce\(\s*v_hire_date,\s*\(now\(\) at time zone 'Asia\/Ho_Chi_Minh'\)::date\s*\);/);
  assert.match(v5, /if not v_attendance_tracking_enabled then\s*\n\s*v_start_time := null;\s*\n\s*v_end_time := null;/);
  assert.match(v5, /v_created\.id, p_level_program_enabled, v_effective_from, null, v_hire_date,\s*\n\s*case when v_created\.is_system_account then null else 'hire_date' end, 1,/);
});

test("rehire v3: every validation from the old v3+reset_v1 chain is preserved, and REHIRE_NOT_ALLOWED / history-preserving updates survive verbatim", () => {
  const codes = [...rehireV3.matchAll(/raise exception '([A-Z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(codes, [
    "CHANGE_REASON_REQUIRED", "EMPLOYEE_NOT_FOUND", "FORBIDDEN",
    "INVALID_REHIRE_DATE", "REHIRE_NOT_ALLOWED",
  ].sort());
  assert.match(rehireV3, /if v_before\.is_system_account or v_before\.is_active is distinct from false or v_before\.termination_date is null then/);
  assert.match(rehireV3, /'level_reset_on_rehire'/);
  assert.doesNotMatch(rehireV3, /delete from/i);
});

// ---------------------------------------------------------------------------
// 3. INSERT/UPDATE 대상 테이블 개수까지 원본과 정확히 동일한지(정책 누락/중복 방지).
// ---------------------------------------------------------------------------

function tableOpCounts(body: string) {
  const matches = [...body.matchAll(/(insert into|update) public\.([a-z_]+)/g)];
  const counts: Record<string, number> = {};
  for (const m of matches) {
    const key = `${m[1]} public.${m[2]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

test("v9 touches exactly the same tables the same number of times as the original v9+v8+v7 chain", () => {
  assert.deepEqual(tableOpCounts(v9), {
    "insert into public.employee_level_audit_logs": 2,
    "insert into public.employee_level_program_versions": 1,
    "insert into public.employee_work_schedule_versions": 1,
    "update public.employee_level_program_versions": 2,
    "update public.employee_work_schedule_versions": 1,
    "update public.users": 2,
  });
});

test("v5 touches exactly the same tables the same number of times as the original v5+v4 chain", () => {
  assert.deepEqual(tableOpCounts(v5), {
    "insert into public.users": 1,
    "insert into public.employee_work_schedule_versions": 1,
    "update public.users": 1,
    "insert into public.employee_level_program_versions": 1,
  });
});

test("rehire v3 touches exactly the same tables the same number of times as the original v3+reset_v1 chain", () => {
  assert.deepEqual(tableOpCounts(rehireV3), {
    "update public.users": 2,
    "insert into public.employee_level_audit_logs": 1,
    "update public.employee_level_program_versions": 2,
    "insert into public.employee_level_program_versions": 1,
  });
});

// ---------------------------------------------------------------------------
// 4. application 코드는 여전히 최신 3개만 호출(수정 없음).
// ---------------------------------------------------------------------------

test("application code still calls only the 3 latest entries, untouched by this migration", () => {
  assert.match(usersRoute, /\.rpc\(\s*\n?\s*"employee_update_profile_and_level_v9"/);
  assert.match(usersRoute, /\.rpc\("employee_rehire_with_level_policy_v3"/);
  assert.match(createRoute, /"employee_create_with_schedule_v5"/);
  for (const oldName of [
    "employee_update_profile_and_level_v8", "employee_update_profile_and_level_v7",
    "employee_create_with_schedule_v4", "employee_create_with_schedule_v3",
    "employee_rehire_with_level_reset_v1", "employee_rehire_with_level_policy_v2",
  ]) {
    assert.doesNotMatch(usersRoute, new RegExp(oldName));
    assert.doesNotMatch(createRoute, new RegExp(oldName));
  }
});
