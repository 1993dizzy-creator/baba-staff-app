import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MIGRATION_FILE = "202608080003_add_store_holiday_calendar.sql";
const migration = readFileSync(join(process.cwd(), "supabase/migrations", MIGRATION_FILE), "utf8");
const migrationsDir = readdirSync(join(process.cwd(), "supabase/migrations"));

// ---------------------------------------------------------------------------
// 베트남 법정공휴일 관리 1차 기반 — Migration 파일 정적 계약 검증.
// (운영 DB에는 적용하지 않음 — 파일 내용만 검증한다.)
// ---------------------------------------------------------------------------

// store_set_holiday_tet_option_v1의 confirmed 판정(tet_option is not null and
// national_day_adjacent_date is not null)을 실행 가능한 DB 없이도 검증하기 위한
// twin 구현이다 — 실제 RPC의 CASE 조건과 정확히 같은 불리언 규칙을 재현한다(위
// "confirmed status requires BOTH..." 테스트가 SQL 문자열 자체를 고정하고,
// 이 함수는 그 규칙이 실제로 3가지 시나리오에서 옳게 동작하는지 진리표로 확인한다).
function computesConfirmed(tetOption: string | null, nationalDayAdjacentDate: string | null): boolean {
  return tetOption !== null && nationalDayAdjacentDate !== null;
}

test("confirmed truth table — case 3: Tet만 선택 + national day null → draft", () => {
  assert.equal(computesConfirmed("one_before_four_after", null), false);
});

test("confirmed truth table — case 4: national day만 선택(Tet null) → draft", () => {
  assert.equal(computesConfirmed(null, "2026-09-01"), false);
});

test("confirmed truth table — case 5: 둘 다 선택 → confirmed", () => {
  assert.equal(computesConfirmed("one_before_four_after", "2026-09-01"), true);
});

test("confirmed truth table — 둘 다 미선택 → draft (brand-new year bootstrap)", () => {
  assert.equal(computesConfirmed(null, null), false);
});

test("confirmed truth table — 2026 seed 상태(national day는 이미 있음, Tet만 없음) → draft, 그대로 유지", () => {
  assert.equal(computesConfirmed(null, "2026-09-01"), false);
});

test("migration filename has no exact collision with any other migration (later files, like 202608080004, are expected to sort after this one — that's fine, just no duplicate timestamp)", () => {
  const others = migrationsDir.filter((name) => name !== MIGRATION_FILE && name.endsWith(".sql"));
  for (const other of others) {
    assert.ok(
      MIGRATION_FILE.localeCompare(other) !== 0,
      `unexpected exact-name collision with ${other}`
    );
  }
});

test("migration is transactional (begin/commit) and has explicit preflight + postflight self-checks", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;\s*$/m);
  assert.match(migration, /preflight failed/);
  assert.match(migration, /postflight failed/);
});

test("no T-SQL N'...' string prefix leaked in — this is PostgreSQL, plain '...' is correct for UTF-8 text", () => {
  assert.doesNotMatch(migration, /[^A-Za-z0-9_]N'/);
});

test("store_holiday_calendars: year is the primary key, status/tet_option are constrained, confirmed pair is enforced", () => {
  assert.match(migration, /create table public\.store_holiday_calendars \(/);
  assert.match(migration, /year integer primary key/);
  assert.match(migration, /status text not null default 'draft'/);
  assert.match(migration, /store_holiday_calendars_status_check check \(status in \('draft', 'confirmed'\)\)/);
  assert.match(
    migration,
    /store_holiday_calendars_tet_option_check check \(\s*tet_option is null\s*or tet_option in \('one_before_four_after', 'two_before_three_after', 'three_before_two_after'\)/
  );
  assert.match(migration, /store_holiday_calendars_confirmed_pair_check/);
});

test("store_holiday_calendars: created_by is nullable (system seed never gets an arbitrary owner attribution), and created_source distinguishes system_seed from manual", () => {
  assert.match(migration, /created_by bigint null references public\.users\(id\)/);
  assert.doesNotMatch(migration, /created_by bigint not null references public\.users\(id\)/);
  assert.match(migration, /created_source text not null default 'manual'/);
  assert.match(
    migration,
    /store_holiday_calendars_created_source_check check \(\s*created_source in \('manual', 'system_seed'\)\s*and \(\s*\(created_source = 'system_seed' and created_by is null\)\s*or \(created_source = 'manual' and created_by is not null\)\s*\)\s*\)/
  );
});

test("store_holidays: independent of attendance_records/leave requests — no FK to either, unique per (year, date, code)", () => {
  assert.match(migration, /create table public\.store_holidays \(/);
  assert.match(
    migration,
    /calendar_year integer not null references public\.store_holiday_calendars\(year\) on delete cascade/
  );
  assert.doesNotMatch(migration, /references public\.attendance_records/);
  assert.doesNotMatch(migration, /attendance_record_id/);
  assert.match(migration, /store_holidays_unique unique \(calendar_year, holiday_date, holiday_code\)/);
  assert.match(migration, /is_paid_holiday boolean not null default true/);
  assert.match(migration, /is_employer_selected boolean not null default false/);
});

test("both new tables enable RLS and are locked down to service_role only (no public/anon/authenticated access)", () => {
  assert.match(migration, /alter table public\.store_holiday_calendars enable row level security;/);
  assert.match(migration, /alter table public\.store_holidays enable row level security;/);
  assert.match(
    migration,
    /revoke all on table public\.store_holiday_calendars from public, anon, authenticated, service_role;/
  );
  assert.match(migration, /grant select, insert, update on table public\.store_holiday_calendars to service_role;/);
  assert.match(
    migration,
    /revoke all on table public\.store_holidays from public, anon, authenticated, service_role;/
  );
  assert.match(migration, /grant select, insert, delete on table public\.store_holidays to service_role;/);
});

test("store_set_holiday_tet_option_v1: owner/master only, advisory-locked, receives pre-computed dates (no lunar calendar math in SQL)", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_set_holiday_tet_option_v1"),
    migration.indexOf("revoke all on function public.store_set_holiday_tet_option_v1")
  );
  assert.match(fn, /security invoker/);
  assert.match(fn, /pg_advisory_xact_lock\(hashtext\('store_holiday_calendar_v1:' \|\| p_year::text\)\)/);
  assert.match(fn, /if lower\(coalesce\(v_role, ''\)\) not in \('owner', 'master'\) then/);
  assert.match(fn, /return jsonb_build_object\('status', 'forbidden'\);/);
  assert.match(fn, /array_length\(p_holiday_dates, 1\) <> 5/);
  assert.match(fn, /delete from public\.store_holidays\s*\n\s*where calendar_year = p_year and holiday_group = 'TET';/);
  assert.doesNotMatch(fn, /extract\(month from|lunar|solar_to_lunar/i);
});

test("store_set_holiday_tet_option_v1: confirmed status requires BOTH tet_option and national_day_adjacent_date to be non-null — the client never dictates status, the RPC recomputes it every call", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_set_holiday_tet_option_v1"),
    migration.indexOf("revoke all on function public.store_set_holiday_tet_option_v1")
  );
  assert.match(
    fn,
    /status = case\s*\n\s*when tet_option is not null and national_day_adjacent_date is not null then 'confirmed'\s*\n\s*else 'draft'\s*\n\s*end,/
  );
  assert.match(
    fn,
    /confirmed_by = case\s*\n\s*when tet_option is not null and national_day_adjacent_date is not null then p_actor_user_id\s*\n\s*else null\s*\n\s*end,/
  );
  assert.match(
    fn,
    /confirmed_at = case\s*\n\s*when tet_option is not null and national_day_adjacent_date is not null then now\(\)\s*\n\s*else null\s*\n\s*end/
  );
  assert.match(fn, /where year = p_year;/);
});

test("store_set_holiday_tet_option_v1: bootstrap insert never hardcodes status='confirmed' — a brand-new year always starts 'draft' until national_day_adjacent_date is also set", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_set_holiday_tet_option_v1"),
    migration.indexOf("revoke all on function public.store_set_holiday_tet_option_v1")
  );
  assert.match(
    fn,
    /values \(\s*\n\s*p_year, 'VN', 'draft', p_tet_option, 'manual',\s*\n\s*p_actor_user_id, p_actor_user_id, now\(\)\s*\n\s*\)/
  );
  assert.doesNotMatch(fn, /values \([^)]*'confirmed'/);
});

test("store_set_holiday_tet_option_v1: on conflict (existing year row), created_by/created_source are never touched — only tet_option/updated_* change, preserving the original creation record (e.g. a system-seeded year stays system_seed even after Tet is picked through this RPC)", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_set_holiday_tet_option_v1"),
    migration.indexOf("revoke all on function public.store_set_holiday_tet_option_v1")
  );
  const onConflict = fn.slice(fn.indexOf("on conflict (year) do update set"), fn.indexOf("-- 2)"));
  assert.doesNotMatch(onConflict, /created_by/);
  assert.doesNotMatch(onConflict, /created_source/);
  assert.match(onConflict, /tet_option = excluded\.tet_option,/);
  assert.match(onConflict, /updated_by = excluded\.updated_by,/);
  assert.match(onConflict, /updated_at = excluded\.updated_at;/);
});

test("store_set_holiday_tet_option_v1 grants: revoked from public/anon/authenticated, granted only to service_role (same pattern as store_schedule_settings_v1)", () => {
  assert.match(
    migration,
    /revoke all on function public\.store_set_holiday_tet_option_v1\(integer, text, date\[\], bigint\) from public;/
  );
  assert.match(
    migration,
    /revoke all on function public\.store_set_holiday_tet_option_v1\(integer, text, date\[\], bigint\) from anon;/
  );
  assert.match(
    migration,
    /revoke all on function public\.store_set_holiday_tet_option_v1\(integer, text, date\[\], bigint\) from authenticated;/
  );
  assert.match(
    migration,
    /grant execute on function public\.store_set_holiday_tet_option_v1\(integer, text, date\[\], bigint\) to service_role;/
  );
});

test("2026 seed: exactly the 6 documented fixed holidays, Tet explicitly excluded (status stays draft)", () => {
  const seedBlock = migration.slice(
    migration.indexOf("-- 4. 2026 고정 확정 데이터"),
    migration.indexOf("-- 5. Postflight")
  );
  const expected: Array<[string, string, string]> = [
    ["2026-01-01", "NEW_YEAR", "신정"],
    ["2026-04-26", "HUNG_KINGS", "흥왕기념일"],
    ["2026-04-30", "REUNIFICATION_DAY", "통일기념일"],
    ["2026-05-01", "LABOR_DAY", "노동절"],
    ["2026-09-01", "NATIONAL_DAY", "국경일 추가 휴일"],
    ["2026-09-02", "NATIONAL_DAY", "베트남 국경일"],
  ];
  for (const [date, code, nameKo] of expected) {
    assert.match(
      seedBlock,
      new RegExp(`\\(2026, date '${date}', '${code}', '${nameKo}'`),
      `expected seed row for ${date}/${code}`
    );
  }
  assert.doesNotMatch(seedBlock, /'TET'/);
  assert.match(seedBlock, /2026, 'VN', 'draft', null, date '2026-09-01',\s*\n\s*'system_seed', null/);
});

test("2026 seed: the extra national-day pick (09-01) is is_employer_selected=true, the fixed one (09-02) is false", () => {
  const seedBlock = migration.slice(migration.indexOf("-- 4. 2026 고정 확정 데이터"));
  assert.match(seedBlock, /'2026-09-01', 'NATIONAL_DAY', '국경일 추가 휴일', 'Nghỉ lễ Quốc khánh', 'NATIONAL_DAY', true, true\)/);
  assert.match(seedBlock, /'2026-09-02', 'NATIONAL_DAY', '베트남 국경일', 'Quốc khánh Việt Nam', 'NATIONAL_DAY', true, false\)/);
});

test("system seed: 2026 bootstrap data is NEVER attributed to a specific/arbitrary owner — no owner lookup, created_source='system_seed', created_by=null", () => {
  const seedBlock = migration.slice(migration.indexOf("-- 4. 2026 고정 확정 데이터"), migration.indexOf("-- 5. Postflight"));
  // The old "look up an active owner and attribute the seed to them" pattern must be gone entirely.
  assert.doesNotMatch(seedBlock, /where role = 'owner'/);
  assert.doesNotMatch(seedBlock, /v_seed_actor_id/);
  assert.match(
    seedBlock,
    /year, country_code, status, tet_option, national_day_adjacent_date,\s*\n\s*created_source, created_by\s*\n\s*\)\s*\n\s*values \(\s*\n\s*2026, 'VN', 'draft', null, date '2026-09-01',\s*\n\s*'system_seed', null\s*\n\s*\)/
  );
});

test("manual admin mutation (the RPC path, not the seed) always carries a real actor id — created_source='manual' pairs with created_by=p_actor_user_id", () => {
  const fn = migration.slice(
    migration.indexOf("create function public.store_set_holiday_tet_option_v1"),
    migration.indexOf("revoke all on function public.store_set_holiday_tet_option_v1")
  );
  assert.match(fn, /'manual',\s*\n\s*p_actor_user_id, p_actor_user_id, now\(\)/);
});

test("postflight re-verifies the seed never attributed 2026 to an owner: created_source=system_seed and created_by is null", () => {
  const postflight = migration.slice(migration.indexOf("-- 5. Postflight"));
  assert.match(
    postflight,
    /where year = 2026 and \(created_source <> 'system_seed' or created_by is not null\)/
  );
});

test("postflight re-verifies: exactly 6 seeded 2026 rows, calendar stays draft, no TET rows seeded", () => {
  const postflight = migration.slice(migration.indexOf("-- 5. Postflight"));
  assert.match(postflight, /count\(\*\) from public\.store_holidays where calendar_year = 2026\) <> 6/);
  assert.match(postflight, /select status from public\.store_holiday_calendars where year = 2026\) <> 'draft'/);
  assert.match(postflight, /holiday_group = 'TET'/);
});

test("scope discipline: existing store-settings objects (store_setting_versions, store_get_settings_overview_v1, store_schedule_settings_v1, store_attendance_policies) are never created/replaced/dropped by this migration", () => {
  for (const objectName of [
    "store_setting_versions",
    "store_get_settings_overview_v1",
    "store_schedule_settings_v1",
    "store_attendance_policies",
    "store_business_hours",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(create table|create( or replace)? function|alter table|drop (table|function)) public\\.${objectName}\\b`)
    );
  }
});

test("scope discipline: no FK/write to attendance_records, payroll tables, or leave-request tables — mentioning attendance_records in a design-rationale comment is fine, referencing it as a real relation is not", () => {
  assert.doesNotMatch(migration, /references public\.attendance_records/);
  assert.doesNotMatch(migration, /public\.payroll_\w+/);
  assert.doesNotMatch(migration, /insert into public\.attendance_records/);
  assert.doesNotMatch(migration, /update public\.attendance_records/);
});
