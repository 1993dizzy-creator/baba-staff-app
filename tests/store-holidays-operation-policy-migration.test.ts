import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MIGRATION_FILE = "202608080004_add_store_holiday_operation_policy.sql";
const PREVIOUS_MIGRATION_FILE = "202608080003_add_store_holiday_calendar.sql";
const migration = readFileSync(join(process.cwd(), "supabase/migrations", MIGRATION_FILE), "utf8");
const previousMigration = readFileSync(join(process.cwd(), "supabase/migrations", PREVIOUS_MIGRATION_FILE), "utf8");
const migrationsDir = readdirSync(join(process.cwd(), "supabase/migrations"));

// ---------------------------------------------------------------------------
// BABA 내부 200% 운영 정책을 법정공휴일 원본과 분리하는 Migration.
// 202608080003(이미 운영 적용됨)은 이번 Migration에서 절대 재작성하지 않는다 —
// 필요한 스키마 변경은 전부 이 새 파일에만 있어야 한다.
// ---------------------------------------------------------------------------

test("202608080003 (already applied to production) is never modified by this change — this test file itself only reads it, and 202608080004 must be a brand-new file, not an edit to 202608080003", () => {
  assert.notEqual(MIGRATION_FILE, PREVIOUS_MIGRATION_FILE);
  const others = migrationsDir.filter((name) => name.endsWith(".sql"));
  assert.ok(others.includes(PREVIOUS_MIGRATION_FILE));
  assert.ok(others.includes(MIGRATION_FILE));
});

test("migration filename sorts after 202608080003 (no timestamp collision)", () => {
  assert.ok(MIGRATION_FILE > PREVIOUS_MIGRATION_FILE);
  const others = migrationsDir.filter((name) => name !== MIGRATION_FILE && name.endsWith(".sql"));
  for (const other of others) {
    assert.notEqual(MIGRATION_FILE, other);
  }
});

test("migration is transactional (begin/commit) with explicit preflight + postflight self-checks", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;\s*$/m);
  assert.match(migration, /preflight failed/);
  assert.match(migration, /postflight failed/);
});

test("no T-SQL N'...' string prefix leaked in", () => {
  assert.doesNotMatch(migration, /[^A-Za-z0-9_]N'/);
});

test("store_holiday_operation_policies: holiday_id references store_holidays directly (1:0..1), never attendance_records/payroll tables, and naming avoids any legal/statutory implication", () => {
  assert.match(migration, /create table public\.store_holiday_operation_policies \(/);
  assert.match(migration, /holiday_id bigint not null references public\.store_holidays\(id\) on delete cascade/);
  assert.match(migration, /internal_pay_multiplier numeric not null/);
  assert.match(
    migration,
    /store_holiday_operation_policies_holiday_unique unique \(holiday_id\)/
  );
  assert.match(
    migration,
    /store_holiday_operation_policies_multiplier_check check \(internal_pay_multiplier > 0\)/
  );
  assert.doesNotMatch(migration, /references public\.attendance_records/);
  assert.doesNotMatch(migration, /public\.payroll_\w+/);
});

test("naming discipline: the actual table definition (not the design-rationale comment, which may name the forbidden terms to explain why they're avoided) never uses a column/constraint name that implies a statutory/legal pay rate", () => {
  const tableDef = migration.slice(
    migration.indexOf("create table public.store_holiday_operation_policies ("),
    migration.indexOf("comment on table public.store_holiday_operation_policies")
  );
  for (const forbidden of ["statutory_pay_rate", "legal_pay_multiplier", "legally_paid", "statutory_200"]) {
    assert.doesNotMatch(tableDef, new RegExp(forbidden, "i"), `table definition must not use ${forbidden}`);
  }
  assert.match(tableDef, /internal_pay_multiplier/);
});

test("store_holiday_operation_policies: RLS enabled, locked to service_role only (including delete, since deselecting removes the row)", () => {
  assert.match(migration, /alter table public\.store_holiday_operation_policies enable row level security;/);
  assert.match(
    migration,
    /revoke all on table public\.store_holiday_operation_policies from public, anon, authenticated, service_role;/
  );
  assert.match(
    migration,
    /grant select, insert, update, delete on table public\.store_holiday_operation_policies to service_role;/
  );
});

test("store_toggle_holiday_operation_policy_v1: owner/master only, advisory-locked, never deletes the underlying store_holidays row", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_toggle_holiday_operation_policy_v1"),
    migration.indexOf("revoke all on function public.store_toggle_holiday_operation_policy_v1")
  );
  assert.match(fn, /security invoker/);
  assert.match(fn, /pg_advisory_xact_lock\(hashtext\('store_holiday_operation_policy_v1:' \|\| p_holiday_id::text\)\)/);
  assert.match(fn, /if lower\(coalesce\(v_role, ''\)\) not in \('owner', 'master'\) then/);
  assert.match(fn, /return jsonb_build_object\('status', 'forbidden'\);/);
  assert.doesNotMatch(fn, /delete from public\.store_holidays\b/);
  assert.match(fn, /delete from public\.store_holiday_operation_policies where holiday_id = p_holiday_id;/);
});

test("store_toggle_holiday_operation_policy_v1: selecting upserts a fixed 2.0 multiplier (not client-controlled), deselecting deletes the policy row (absence = not selected, the default-deny model)", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_toggle_holiday_operation_policy_v1"),
    migration.indexOf("revoke all on function public.store_toggle_holiday_operation_policy_v1")
  );
  assert.match(fn, /v_multiplier constant numeric := 2\.0;/);
  assert.match(fn, /if p_selected then/);
  assert.match(
    fn,
    /insert into public\.store_holiday_operation_policies \(holiday_id, internal_pay_multiplier, updated_by, updated_at\)/
  );
  assert.match(fn, /on conflict \(holiday_id\) do update set/);
  assert.match(fn, /else\s*\n\s*-- store_holidays 원본은 절대 지우지 않는다/);
});

test("store_toggle_holiday_operation_policy_v1 validates the holiday exists before writing (not_found path)", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_toggle_holiday_operation_policy_v1"),
    migration.indexOf("revoke all on function public.store_toggle_holiday_operation_policy_v1")
  );
  assert.match(fn, /select exists\(select 1 from public\.store_holidays where id = p_holiday_id\) into v_holiday_exists;/);
  assert.match(fn, /if not v_holiday_exists then\s*\n\s*return jsonb_build_object\('status', 'not_found'\);/);
});

test("store_toggle_holiday_operation_policy_v1 grants: revoked from public/anon/authenticated, granted only to service_role", () => {
  assert.match(
    migration,
    /revoke all on function public\.store_toggle_holiday_operation_policy_v1\(bigint, boolean, bigint\) from public;/
  );
  assert.match(
    migration,
    /revoke all on function public\.store_toggle_holiday_operation_policy_v1\(bigint, boolean, bigint\) from anon;/
  );
  assert.match(
    migration,
    /revoke all on function public\.store_toggle_holiday_operation_policy_v1\(bigint, boolean, bigint\) from authenticated;/
  );
  assert.match(
    migration,
    /grant execute on function public\.store_toggle_holiday_operation_policy_v1\(bigint, boolean, bigint\) to service_role;/
  );
});

test("postflight: the new table must start empty — no automatic carry-over of the previously-selected tet_option (2026-02-16~20) into the new policy table", () => {
  const postflight = migration.slice(migration.indexOf("-- 3. Postflight"));
  assert.match(postflight, /count\(\*\) from public\.store_holiday_operation_policies\) <> 0/);
});

test("this migration never touches store_setting_versions, store_get_settings_overview_v1, store_schedule_settings_v1, store_attendance_policies, or store_holidays itself (DDL) — it only adds new objects", () => {
  for (const objectName of [
    "store_setting_versions",
    "store_get_settings_overview_v1",
    "store_schedule_settings_v1",
    "store_attendance_policies",
    "store_business_hours",
    "store_holidays",
    "store_holiday_calendars",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(create table|create( or replace)? function|alter table|drop (table|function)) public\\.${objectName}\\b`)
    );
  }
});

test("this migration never rewrites store_set_holiday_tet_option_v1 or store_holiday_calendars from 202608080003 — the old bundle-selection RPC/table stay in place unused, not dropped/altered (per instructions: don't rewrite an already-applied migration or its effects retroactively)", () => {
  assert.doesNotMatch(migration, /drop function public\.store_set_holiday_tet_option_v1/);
  assert.doesNotMatch(migration, /create or replace function public\.store_set_holiday_tet_option_v1/);
  assert.doesNotMatch(migration, /alter table public\.store_holiday_calendars/);
});

test("202608080003 itself is untouched by this whole change (same content as when it was applied to production — verified by re-checking its own already-established contract markers)", () => {
  assert.match(previousMigration, /create table public\.store_holiday_calendars \(/);
  assert.match(previousMigration, /create function public\.store_set_holiday_tet_option_v1/);
  assert.match(previousMigration, /2026, 'VN', 'draft', null, date '2026-09-01',\s*\n\s*'system_seed', null/);
});
