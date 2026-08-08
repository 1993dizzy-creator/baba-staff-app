import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MIGRATION_FILE = "202608090001_add_store_prepare_holiday_calendar_rpc.sql";
const migration = readFileSync(join(process.cwd(), "supabase/migrations", MIGRATION_FILE), "utf8");
const migrationsDir = readdirSync(join(process.cwd(), "supabase/migrations"));
const previous3 = readFileSync(
  join(process.cwd(), "supabase/migrations", "202608080003_add_store_holiday_calendar.sql"),
  "utf8"
);
const previous4 = readFileSync(
  join(process.cwd(), "supabase/migrations", "202608080004_add_store_holiday_operation_policy.sql"),
  "utf8"
);

// ---------------------------------------------------------------------------
// 다음 연도 법정공휴일을 owner/master가 앱에서 직접 준비할 수 있게 하는
// store_prepare_holiday_calendar_v1 RPC — 202608080003/202608080004는 이미
// 운영 반영되었으므로 이 Migration은 절대 그 두 파일을 재작성하지 않는다.
// ---------------------------------------------------------------------------

test("migration filename has no exact collision and sorts after 202608080004", () => {
  const others = migrationsDir.filter((name) => name !== MIGRATION_FILE && name.endsWith(".sql"));
  for (const other of others) {
    assert.notEqual(MIGRATION_FILE, other);
  }
  assert.ok(MIGRATION_FILE > "202608080004_add_store_holiday_operation_policy.sql");
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

test("202608080003/202608080004 (already applied to production) are never rewritten — this migration only reads them for cross-checks, never edits them, and 202608090001 is a brand-new file", () => {
  assert.match(previous3, /create table public\.store_holiday_calendars \(/);
  assert.match(previous4, /create table public\.store_holiday_operation_policies \(/);
  assert.notEqual(MIGRATION_FILE, "202608080003_add_store_holiday_calendar.sql");
  assert.notEqual(MIGRATION_FILE, "202608080004_add_store_holiday_operation_policy.sql");
});

test("this migration never touches store_holiday_calendars/store_holidays/store_holiday_operation_policies DDL, or any other unrelated store-settings object — it only adds one new function", () => {
  for (const objectName of [
    "store_setting_versions",
    "store_get_settings_overview_v1",
    "store_schedule_settings_v1",
    "store_attendance_policies",
    "store_business_hours",
    "store_holidays",
    "store_holiday_calendars",
    "store_holiday_operation_policies",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(create table|create( or replace)? function|alter table|drop (table|function)) public\\.${objectName}\\b`)
    );
  }
});

test("store_prepare_holiday_calendar_v1: owner/master only, advisory-locked, year-scoped", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  assert.match(fn, /security invoker/);
  assert.match(fn, /pg_advisory_xact_lock\(hashtext\('store_holiday_calendar_prep_v1:' \|\| p_year::text\)\)/);
  assert.match(fn, /if lower\(coalesce\(v_role, ''\)\) not in \('owner', 'master'\) then/);
  assert.match(fn, /return jsonb_build_object\('status', 'forbidden'\);/);
});

test("store_prepare_holiday_calendar_v1: never overwrites an existing year — checks existence first and returns year_already_exists before any insert", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  const existsCheckIdx = fn.indexOf("year_already_exists");
  const firstInsertIdx = fn.indexOf("insert into public.store_holiday_calendars");
  assert.ok(existsCheckIdx > -1 && firstInsertIdx > -1);
  assert.ok(existsCheckIdx < firstInsertIdx, "existence check must run before any insert");
  assert.match(
    fn,
    /if exists \(select 1 from public\.store_holiday_calendars where year = p_year\) then\s*\n\s*return jsonb_build_object\('status', 'year_already_exists'\);/
  );
});

test("store_prepare_holiday_calendar_v1: validates year range, Hung Kings/Tet dates all fall within the target year, Tet is exactly 5 dates, and the national day adjacent date is exactly year-09-01 or year-09-03", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  assert.match(fn, /if p_year is null or p_year not between 2020 and 2100 then/);
  assert.match(fn, /return jsonb_build_object\('status', 'invalid_year'\);/);
  assert.match(
    fn,
    /if p_national_day_adjacent_date is distinct from make_date\(p_year, 9, 1\)\s*\n\s*and p_national_day_adjacent_date is distinct from make_date\(p_year, 9, 3\)/
  );
  assert.match(fn, /return jsonb_build_object\('status', 'invalid_national_day_adjacent'\);/);
  assert.match(fn, /if p_hung_kings_date is null or extract\(year from p_hung_kings_date\)::integer <> p_year then/);
  assert.match(fn, /if p_tet_dates is null or array_length\(p_tet_dates, 1\) <> 5 then/);
  assert.match(fn, /foreach v_date in array p_tet_dates loop/);
});

test("store_prepare_holiday_calendar_v1: rejects any duplicate date across the full inserted set (fixed holidays + Hung Kings + national day pair + Tet 5 days combined)", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  assert.match(
    fn,
    /v_all_dates := array\[\s*\n\s*v_new_year_date, p_hung_kings_date, v_reunification_date, v_labor_date,\s*\n\s*v_national_day_date, p_national_day_adjacent_date\s*\n\s*\] \|\| p_tet_dates;/
  );
  assert.match(
    fn,
    /if array_length\(v_all_dates, 1\) <> \(select count\(distinct d\) from unnest\(v_all_dates\) d\) then/
  );
});

test("store_prepare_holiday_calendar_v1: inserts exactly one store_holiday_calendars row (status stays draft, no confirmed_by/confirmed_at, tet_option untouched) with the national_day_adjacent_date/source metadata actually stored", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  assert.match(
    fn,
    /insert into public\.store_holiday_calendars \(\s*\n\s*year, country_code, status, national_day_adjacent_date, source_url, source_published_at,\s*\n\s*created_source, created_by, updated_by, updated_at\s*\n\s*\)/
  );
  assert.match(fn, /p_year, 'VN', 'draft', p_national_day_adjacent_date, p_source_url, p_source_published_at,/);
  assert.doesNotMatch(fn, /tet_option/);
  assert.doesNotMatch(fn, /confirmed_by|confirmed_at/);
});

test("store_prepare_holiday_calendar_v1: inserts the 4 fixed holidays (NEW_YEAR/HUNG_KINGS/REUNIFICATION_DAY/LABOR_DAY) + 2 NATIONAL_DAY rows + 5 TET rows, using the exact same name_ko/name_vi literals as the 2026 seed (202608080003)", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  for (const literal of [
    "'신정', 'Tết Dương lịch'",
    "'흥왕기념일', 'Giỗ Tổ Hùng Vương'",
    "'통일기념일', 'Ngày Giải phóng miền Nam, thống nhất đất nước'",
    "'노동절', 'Ngày Quốc tế Lao động'",
    "'베트남 국경일', 'Quốc khánh Việt Nam'",
    "'국경일 추가 휴일', 'Nghỉ lễ Quốc khánh'",
    "'음력설 연휴', 'Nghỉ Tết Nguyên Đán'",
  ]) {
    assert.ok(fn.includes(literal), `missing literal: ${literal}`);
    assert.ok(previous3.includes(literal), `literal diverges from 202608080003 seed: ${literal}`);
  }
  assert.match(fn, /select p_year, d, 'TET', '음력설 연휴', 'Nghỉ Tết Nguyên Đán', 'TET', true, false\s*\n\s*from unnest\(p_tet_dates\) d;/);
});

test("store_prepare_holiday_calendar_v1: never creates a store_holiday_operation_policies row — multi-day groups start fully unselected", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  assert.doesNotMatch(fn, /store_holiday_operation_policies/);
});

test("store_prepare_holiday_calendar_v1 grants: revoked from public/anon/authenticated, granted only to service_role", () => {
  const signature = "(integer, date, date[], date, text, date, bigint)";
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.store_prepare_holiday_calendar_v1${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from public;`)
  );
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.store_prepare_holiday_calendar_v1${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from anon;`)
  );
  assert.match(
    migration,
    new RegExp(`revoke all on function public\\.store_prepare_holiday_calendar_v1${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from authenticated;`)
  );
  assert.match(
    migration,
    new RegExp(`grant execute on function public\\.store_prepare_holiday_calendar_v1${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} to service_role;`)
  );
});

test("naming discipline: the function definition never uses a statutory/legal-sounding identifier for the 200% concept (this RPC does not even reference the premium — it only creates source data — but guard against future drift)", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_prepare_holiday_calendar_v1"),
    migration.indexOf("revoke all on function public.store_prepare_holiday_calendar_v1")
  );
  for (const forbidden of ["statutory_pay_rate", "legal_pay_multiplier", "legally_paid", "statutory_200"]) {
    assert.doesNotMatch(fn, new RegExp(forbidden, "i"));
  }
});

test("postflight only verifies the function was created exactly once — it does not create or touch any year's data itself", () => {
  const postflight = migration.slice(migration.indexOf("-- 2. Postflight"));
  assert.match(postflight, /store_prepare_holiday_calendar_v1/);
  assert.doesNotMatch(postflight, /insert into|update |delete from/i);
});
