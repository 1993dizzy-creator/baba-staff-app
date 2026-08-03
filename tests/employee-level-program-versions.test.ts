import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("level program history is effective-dated, non-overlapping, private, and audited", () => {
  const migration = read("supabase/migrations/202608030001_add_employee_level_program_versions.sql");
  assert.match(migration, /create table public\.employee_level_program_versions/);
  assert.match(migration, /extract\(day from effective_from\) = 1/);
  assert.match(migration, /exclude using gist/);
  assert.match(migration, /daterange\(effective_from, coalesce\(effective_to, 'infinity'::date\), '\[\)'\) with &&/);
  assert.match(migration, /change_reason text not null/);
  assert.match(migration, /created_by_username text not null/);
  assert.match(migration, /revoke all on table public\.employee_level_program_versions from public, anon, authenticated, service_role/);
  assert.match(migration, /grant select on table public\.employee_level_program_versions to service_role/);
  assert.match(migration, /employee_update_profile_and_level_v5/);
  assert.match(migration, /employee_create_with_schedule_v2/);
  assert.match(migration, /employee_rehire_with_level_policy_v2/);
});

test("backfill preserves automatic roles and does not reinterpret legacy false", () => {
  const migration = read("supabase/migrations/202608030001_add_employee_level_program_versions.sql");
  assert.match(migration, /when u\.role in \('manager', 'leader', 'staff'\) then true/);
  assert.match(migration, /when u\.role in \('owner', 'master'\) then u\.level_program_enabled is true/);
  assert.match(migration, /when u\.is_system_account then false/);
});

test("payroll month loading uses and snapshots the version effective for that month", () => {
  const source = read("lib/payroll/monthly-run.ts");
  assert.match(source, /from\("employee_level_program_versions"\)/);
  assert.match(source, /\.lte\("effective_from",start\)/);
  assert.match(source, /levelProgramEnabled/);
  assert.match(source, /levelProgramVersionId/);
  assert.match(source, /levelProgramRevision/);
  assert.match(source, /levelProgramEffectiveFrom/);
  assert.match(source, /levelProgramVersions/);
});

test("future reservations are compared at their target month and later choices cancel overlapping schedules", () => {
  const route = read("app/api/admin/users/route.ts");
  const page = read("app/(protected)/admin/users/page.tsx");
  const migration = read("supabase/migrations/202608030001_add_employee_level_program_versions.sql");
  assert.match(route, /loadEmployeeLevelProgramVersions\(\[Number\(id\)\], requestedEffectiveFrom\)/);
  assert.match(route, /comparisonEnabled !== levelProgramEnabled/);
  assert.match(route, /nextVersions/);
  assert.match(page, /levelProgramPolicy\?\.nextEnabled/);
  assert.match(page, /policyEnabledForMonth/);
  assert.match(migration, /else effective_from[\s\S]*or effective_from >= p_effective_from/);
});

test("current and next month ranges use half-open boundaries without an active duplicate", () => {
  type Version = { enabled: boolean; from: string; to: string | null };
  const choose = (rows: Version[], enabled: boolean, from: string) => [
    ...rows.map((row) => row.from <= from && (!row.to || row.to > from) || row.from >= from
      ? { ...row, to: row.from < from ? from : row.from }
      : row),
    { enabled, from, to: null },
  ];
  const active = (rows: Version[], date: string) => rows.filter((row) =>
    row.from <= date && (!row.to || row.to > date));

  let rows: Version[] = [{ enabled: true, from: "2026-08-01", to: null }];
  rows = choose(rows, false, "2026-09-01");
  assert.deepEqual(active(rows, "2026-08-31").map((row) => row.enabled), [true]);
  assert.deepEqual(active(rows, "2026-09-01").map((row) => row.enabled), [false]);
  rows = choose(rows, true, "2026-09-01");
  rows = choose(rows, false, "2026-09-01");
  assert.deepEqual(active(rows, "2026-08-31").map((row) => row.enabled), [true]);
  assert.deepEqual(active(rows, "2026-09-01").map((row) => row.enabled), [false]);
  assert.equal(active(rows, "2026-09-01").length, 1);
});

test("past hires and mid-month rehires keep distinct effective and base dates", () => {
  const migration = read("supabase/migrations/202608030001_add_employee_level_program_versions.sql");
  assert.match(migration, /v_effective_from := coalesce\(date_trunc\('month', v_hire_date\)::date/);
  assert.match(migration, /v_effective_from date := date_trunc\('month', p_rehire_date\)::date/);
  assert.match(migration, /v_base_date date := case when p_level_program_enabled then p_rehire_date else null end/);
});

test("monthly attendance badges resolve level policy at the selected month", () => {
  const route = read("app/api/attendance/users/route.ts");
  assert.match(route, /withLevels\([\s\S]*, last\)/);
});

test("user mutation APIs call the versioned transactional RPCs", () => {
  assert.match(read("app/api/admin/users/route.ts"), /employee_update_profile_and_level_v5/);
  assert.match(read("app/api/admin/users/route.ts"), /employee_rehire_with_level_policy_v2/);
  assert.match(read("app/api/admin/users/create/route.ts"), /employee_create_with_schedule_v2/);
});
