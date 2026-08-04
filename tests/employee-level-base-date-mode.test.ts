import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path: string) => fs.readFileSync(path, "utf8");
const migration = read("supabase/migrations/202608040001_restore_employee_level_base_date_modes.sql");
const route = read("app/api/admin/users/route.ts");
const page = read("app/(protected)/admin/users/page.tsx");
const server = read("lib/employee-level/server.ts");
const payroll = read("lib/payroll/monthly-run.ts");
const preflight = read("supabase/employee_level_base_mode_preflight.sql");
const postflight = read("supabase/employee_level_base_mode_postflight.sql");

test("version history stores an explicit calculation basis and preserves it while disabled", () => {
  assert.match(migration, /add column base_date_mode text null/);
  assert.match(migration, /base_date_mode = 'hire_date'/);
  assert.match(migration, /base_date_mode = 'override'/);
  assert.match(migration, /base_date_mode is null and base_date is null/);
  assert.match(migration, /base_date_mode = 'hire_date' and base_date is not null/);
  assert.match(migration, /base_date_mode = 'override' and base_date is not null/);
  for (const guard of [
    "LEVEL_BASE_MODE_NULL_WITH_DATE",
    "LEVEL_BASE_MODE_WITHOUT_DATE",
    "REGULAR_EMPLOYEE_BASE_PAIR_NULL",
    "REGULAR_EMPLOYEE_CURRENT_MODE_NULL",
    "SYSTEM_ACCOUNT_BASE_MODE_NOT_NULL",
  ]) assert.match(migration, new RegExp(guard));
  const dropIndex = migration.indexOf("drop constraint if exists employee_level_program_versions_base_check");
  const repairIndex = migration.indexOf("update public.employee_level_program_versions v");
  const addIndex = migration.indexOf("add constraint employee_level_program_versions_base_check");
  assert.ok(dropIndex >= 0 && dropIndex < repairIndex && repairIndex < addIndex,
    "the legacy constraint must be dropped before disabled rows are repaired and re-added strictly afterward");
  assert.match(migration, /coalesce\(v\.base_date, prior\.base_date/);
  assert.doesNotMatch(migration, /enabled or base_date is null/);
  assert.match(migration, /p_base_date_mode text/);
  assert.match(migration, /v_base_date := case when p_base_date_mode = 'hire_date' then v_after\.hire_date else p_base_date_override end/);
  assert.doesNotMatch(migration, /p_level_program_enabled then p_effective_from/);
});

test("basis-mode audit records preserve semantic changes even when dates match", () => {
  assert.match(migration, /add column previous_base_date_mode text null/);
  assert.match(migration, /add column next_base_date_mode text null/);
  assert.match(migration, /previous_base_date_mode, next_base_date_mode/);
  assert.match(migration, /v_target\.base_date_mode, p_base_date_mode/);
  assert.match(migration, /actor_id, actor_username, change_reason, created_at/);
  assert.match(migration, /p_actor_id, p_actor_username, btrim\(p_change_reason\)/);
  assert.match(migration, /, now\(\)\s*\n\s*\);/);
});

test("preflight and postflight report every invalid mode/date combination", () => {
  for (const sql of [preflight, postflight]) {
    assert.match(sql, /null_mode_with_base_date/);
    assert.match(sql, /mode_without_base_date/);
    assert.match(sql, /invalid_mode/);
    assert.match(sql, /current_regular_employee_null_mode/);
  }
  assert.match(postflight, /previous_base_date_mode/);
  assert.match(postflight, /next_base_date_mode/);
});

test("legacy repair uses the current effective policy instead of any historical override audit", () => {
  assert.match(migration, /with current_policy as/);
  assert.match(migration, /cp\.current_base_date is not null and cp\.current_base_date is distinct from u\.hire_date then 'override'/);
  assert.doesNotMatch(migration, /explicit_override|has_explicit_override|next_base_date_override is not null/);
  assert.match(migration, /when u\.hire_date is not null then 'hire_date'/);
  assert.match(migration, /when u\.is_system_account then null/);
  assert.match(migration, /when cp\.current_base_date is not null and cp\.current_base_date is distinct from u\.hire_date\s*\n\s*then cp\.current_base_date\s*\n\s*else coalesce\(v\.base_date, prior\.base_date, u\.hire_date\)/);
  assert.match(migration, /level_base_date_override = case when v\.base_date_mode = 'override' then v\.base_date else null end/);
  const dryRun = read("supabase/employee_level_base_mode_dry_run.sql");
  assert.match(dryRun, /repaired_version_base_date/);
  assert.match(dryRun, /disabled_owner_default_hire_date/);
  assert.match(dryRun, /inherited_from_previous_version/);
  assert.match(dryRun, /current_policy_base_date_differs_from_hire_date/);
  assert.match(dryRun, /u\.is_system_account or u\.hire_date is null as manual_review/);
  assert.doesNotMatch(dryRun, /explicit_override_audit/);
});

test("v6 changes participation and basis independently without empty periods", () => {
  assert.match(route, /employee_update_profile_and_level_v6/);
  assert.match(route, /comparisonEnabled !== levelProgramEnabled/);
  assert.match(route, /comparisonBaseDateMode !== requestedBaseDateMode/);
  assert.match(route, /p_base_date_mode: requestedBaseDateMode/);
  assert.match(route, /p_base_date_override: requestedBaseDateOverride/);
  assert.match(migration, /if p_effective_from is null then return/);
  assert.match(migration, /v_target\.effective_from = p_effective_from/);
  assert.match(migration, /v_next_effective_from/);
  assert.doesNotMatch(migration, /effective_to\s*=\s*effective_from/);
});

test("admin UI restores independent bilingual basis controls and reset-on-cancel", () => {
  for (const copy of ["레벨 계산 기준", "입사일 기준", "직접 기준", "Mốc tính cấp", "Theo ngày vào làm", "Ngày chỉ định"]) {
    assert.match(read("lib/text/admin-users.ts"), new RegExp(copy));
  }
  assert.match(page, /baseDateMode: "hire_date" \| "override"/);
  assert.match(page, /levelDraft\.baseDateMode === "hire_date"/);
  assert.match(page, /levelDraft\.baseDateOverride/);
  assert.match(page, /setLevelDraft\(initialLevelPolicyDraft\(user\)\)/);
  assert.match(page, /levelStateChanged \? <>/);
  assert.match(page, /minWidth: 0/);
});

test("level and payroll loaders map hire-date versions to a null override", () => {
  assert.match(server, /base_date_mode/);
  assert.match(server, /version\.baseDateMode === "override" \? version\.baseDate : null/);
  assert.match(payroll, /base_date_mode/);
  assert.match(payroll, /version\.baseDateMode==="override"\?version\.baseDate:null/);
  assert.match(payroll, /levelProgramVersion/);
  assert.match(payroll, /contractSnapshot:contracts/);
});

test("legacy RPCs and finalized payroll snapshots remain untouched", () => {
  assert.doesNotMatch(migration, /drop function public\.employee_update_profile_and_level_v5/);
  assert.doesNotMatch(migration, /update public\.payroll_runs|update public\.payroll_run_employees/);
  assert.doesNotMatch(migration, /delete from public\.employee_level_audit_logs/);
});

test("strict mode/date constraint is never crossed by create or rehire RPCs", () => {
  assert.match(migration, /v_hire_date,\s*\n\s*case when v_created\.is_system_account then null else 'hire_date' end/);
  assert.match(migration, /p_rehire_date, 'hire_date'/);
  assert.match(migration, /select public\.employee_create_with_schedule_v3/);
  assert.match(migration, /select public\.employee_rehire_with_level_policy_v3/);
});
