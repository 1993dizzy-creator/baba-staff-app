import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/202608060001_add_employee_attendance_and_login_flags.sql"
);

test("adds both flag columns as not null default true (no behavior change for existing rows)", () => {
  assert.match(
    migration,
    /add column if not exists attendance_tracking_enabled boolean not null default true/
  );
  assert.match(
    migration,
    /add column if not exists app_login_enabled boolean not null default true/
  );
});

test("the work-time integrity constraint is added NOT VALID and validation is left as a separate manual step", () => {
  assert.match(
    migration,
    /add constraint users_attendance_tracking_requires_work_time\s*\n\s*check \(\s*\n\s*attendance_tracking_enabled = false\s*\n\s*or \(work_start_time is not null and work_end_time is not null\)\s*\n\s*\) not valid/
  );
  assert.match(migration, /-- alter table public\.users validate constraint users_attendance_tracking_requires_work_time;/);
  // NOT VALID로 추가했으므로 같은 트랜잭션에서 즉시 validate하지 않는다(운영 데이터 확인 후 별도 실행).
  const validateActiveCount = (migration.match(/^alter table public\.users validate constraint/gm) ?? []).length;
  assert.equal(validateActiveCount, 0);
});

test("new employee-create RPC chain (v4 base, v5 wrapper) never deletes or replaces v1/v3", () => {
  assert.match(migration, /create or replace function public\.employee_create_with_schedule_v4\(/);
  assert.match(migration, /create or replace function public\.employee_create_with_schedule_v5\(/);
  assert.doesNotMatch(migration, /create or replace function public\.employee_create_with_schedule_v1\(/);
  assert.doesNotMatch(migration, /create or replace function public\.employee_create_with_schedule_v3\(/);
  assert.doesNotMatch(migration, /drop function public\.employee_create_with_schedule/);
  // v5는 v1이 아니라 v4를 호출한다.
  assert.match(migration, /public\.employee_create_with_schedule_v4\(p_employee, p_actor_id, p_actor_username\)/);
});

test("employee-create v4 only requires work times and creates a schedule version when attendance tracking is enabled", () => {
  const start = migration.indexOf("create or replace function public.employee_create_with_schedule_v4(");
  const end = migration.indexOf("create or replace function public.employee_create_with_schedule_v5(");
  const v4Source = migration.slice(start, end);
  assert.match(v4Source, /if v_attendance_tracking_enabled and \(v_start_time is null or v_end_time is null\) then/);
  assert.match(v4Source, /if v_attendance_tracking_enabled then\s*\n\s*insert into public\.employee_work_schedule_versions/);
  assert.match(v4Source, /attendance_tracking_enabled, app_login_enabled/);
});

test("new employee-update RPC chain (v7/v8/v9) never deletes or replaces v2/v3/v4/v5/v6", () => {
  for (const version of ["v7", "v8", "v9"]) {
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.employee_update_profile_and_level_${version}\\(`)
    );
  }
  for (const version of ["v2", "v3", "v4", "v5", "v6"]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`create or replace function public\\.employee_update_profile_and_level_${version}\\(`)
    );
  }
  assert.doesNotMatch(migration, /drop function public\.employee_update_profile_and_level/);
});

test("employee-update v7 accepts the two new flags as allowed update keys", () => {
  const start = migration.indexOf("create or replace function public.employee_update_profile_and_level_v7(");
  const end = migration.indexOf("create or replace function public.employee_update_profile_and_level_v8(");
  const v7Source = migration.slice(start, end);
  assert.match(v7Source, /'attendance_tracking_enabled', 'app_login_enabled'/);
  assert.match(v7Source, /attendance_tracking_enabled = v_next_attendance_tracking_enabled/);
  assert.match(v7Source, /app_login_enabled = case/);
});

test("employee-update v7 blocks turning attendance tracking off while an open check-in exists, before the update runs", () => {
  const start = migration.indexOf("create or replace function public.employee_update_profile_and_level_v7(");
  const end = migration.indexOf("create or replace function public.employee_update_profile_and_level_v8(");
  const v7Source = migration.slice(start, end);

  const guardIndex = v7Source.indexOf("ATTENDANCE_OPEN_RECORD_EXISTS");
  const updateIndex = v7Source.indexOf("update public.users\n  set");
  assert.ok(guardIndex >= 0, "guard must exist");
  assert.ok(updateIndex > guardIndex, "guard must run before the users update");

  assert.match(
    v7Source,
    /v_before\.attendance_tracking_enabled = true\s*\n\s*and v_next_attendance_tracking_enabled = false\s*\n\s*and exists \(/
  );
  assert.match(
    v7Source,
    /from public\.attendance_records\s*\n\s*where user_id = p_user_id\s*\n\s*and check_in_at is not null\s*\n\s*and check_out_at is null/
  );
  assert.match(v7Source, /raise exception 'ATTENDANCE_OPEN_RECORD_EXISTS' using errcode = '55000';/);

  // 대상 users 행은 이미 FOR UPDATE로 잠겨 있어야 동시 요청에 안전하다.
  const lockIndex = v7Source.indexOf("for update;");
  assert.ok(lockIndex >= 0 && lockIndex < guardIndex);
});

test("employee-update v8 skips the work-time requirement and schedule mutation when attendance tracking resolves false", () => {
  const start = migration.indexOf("create or replace function public.employee_update_profile_and_level_v8(");
  const end = migration.indexOf("create or replace function public.employee_update_profile_and_level_v9(");
  const v8Source = migration.slice(start, end);
  assert.match(v8Source, /public\.employee_update_profile_and_level_v7\(/);
  assert.match(v8Source, /if not v_attendance_tracking_enabled then/);
  const earlyReturnIndex = v8Source.indexOf("if not v_attendance_tracking_enabled then");
  const scheduleInsertIndex = v8Source.indexOf("insert into public.employee_work_schedule_versions");
  assert.ok(earlyReturnIndex >= 0 && scheduleInsertIndex > earlyReturnIndex);
});

test("employee-update v9 calls v8 (not v4) and keeps the same level-policy behavior as v6", () => {
  const start = migration.indexOf("create or replace function public.employee_update_profile_and_level_v9(");
  const v9Source = migration.slice(start);
  assert.match(v9Source, /public\.employee_update_profile_and_level_v8\(/);
  assert.match(v9Source, /p_effective_from is null then return to_jsonb\(v_after\) - 'password'/);
});

test("every new RPC is revoked from public/anon/authenticated and granted only to service_role with a fixed search_path", () => {
  for (const fn of [
    "employee_create_with_schedule_v4",
    "employee_create_with_schedule_v5",
    "employee_update_profile_and_level_v7",
    "employee_update_profile_and_level_v8",
    "employee_update_profile_and_level_v9",
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s*\\n\\s*from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*\\n\\s*to service_role;`));
  }
  const setSearchPathCount = (migration.match(/set search_path = pg_catalog, public/g) ?? []).length;
  // v4, v5, v7, v8, v9 + 동시성 보완 trigger function 하나(attendance_records_block_
  // new_check_in_when_tracking_disabled) 총 6개.
  assert.equal(setSearchPathCount, 6);
});

test("POS/system account values are not touched by this migration", () => {
  assert.doesNotMatch(migration, /username\s*=\s*'pos'/);
  assert.doesNotMatch(migration, /is_system_account\s*=\s*(true|false)\s*where/);
});
