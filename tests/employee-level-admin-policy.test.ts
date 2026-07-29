import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("admin users API exposes calculated level info through the shared calculator", () => {
  const route = read("app/api/admin/users/route.ts");
  assert.match(route, /requireRole\(\["owner", "master"\]\)/);
  assert.match(route, /level_base_date_override/);
  assert.match(route, /withEmployeeLevelInfo/);
  assert.match(route, /employee_update_profile_and_level_v3/);
  assert.match(route, /validateEmployeeLevelConfiguration/);
  for (const code of [
    "SYSTEM_ACCOUNT_NOT_ELIGIBLE", "HIRE_DATE_REQUIRED", "BASE_DATE_BEFORE_HIRE_DATE",
    "BASE_DATE_AFTER_TERMINATION_DATE", "BASE_DATE_IN_FUTURE",
  ]) assert.match(route, new RegExp(code));
  assert.doesNotMatch(route, /update_employee_level_policy/);
});

test("level policy and rehire mutations are atomic audited RPCs", () => {
  const sql = read("supabase/migrations/20260729114539_simplify_employee_level_profile_save.sql");
  assert.match(sql, /employee_update_profile_and_level_v2/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = pg_catalog, public/);
  assert.match(sql, /update public\.users[\s\S]*insert into public\.employee_level_audit_logs/);
  assert.match(sql, /level_base_date_override = p_base_date_override/);
  assert.match(sql, /is distinct from v_after\.level_base_date_override/);
  assert.match(sql, /employee_profile_save/);
  assert.match(sql, /p_user_id, v_action, null, null/);
  assert.doesNotMatch(sql, /set[\s\S]*level_program_enabled\s*=/);
  assert.doesNotMatch(sql, /update\s+public\.users\s+set\s+level_program_enabled/i);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
  assert.equal((sql.match(/insert into public\.employee_level_audit_logs/g) || []).length, 1);
});

test("system accounts may save profiles but cannot set a level base date", () => {
  const route = read("app/api/admin/users/route.ts");
  const sql = read("supabase/migrations/20260729114539_simplify_employee_level_profile_save.sql");

  assert.doesNotMatch(route, /if \(!target \|\| target\.is_system_account\)/);
  assert.match(route, /target\.is_system_account[\s\S]*target\.level_base_date_override !== levelBaseDateOverride[\s\S]*levelBaseDateOverride !== null/);
  assert.match(sql, /v_before\.is_system_account[\s\S]*level_base_date_override is distinct from p_base_date_override[\s\S]*p_base_date_override is not null/);
  assert.match(sql, /if not v_before\.is_system_account and v_hire_date is null/);
  assert.match(sql, /if not v_before\.is_system_account[\s\S]*insert into public\.employee_level_audit_logs/);
});

test("terminated employees may save unchanged profiles but base-date changes roll back", () => {
  const route = read("app/api/admin/users/route.ts");
  const sql = read("supabase/migrations/20260729114539_simplify_employee_level_profile_save.sql");

  assert.match(route, /target\.termination_date[\s\S]*target\.level_base_date_override !== levelBaseDateOverride[\s\S]*TERMINATED_EMPLOYEE_READ_ONLY/);
  assert.match(sql, /v_before\.termination_date is not null[\s\S]*level_base_date_override is distinct from p_base_date_override[\s\S]*TERMINATED_EMPLOYEE_READ_ONLY/);
  assert.match(sql, /begin;[\s\S]*TERMINATED_EMPLOYEE_READ_ONLY[\s\S]*update public\.users[\s\S]*commit;/);
});

test("level audit is exactly conditional on a real allowed base-date change", () => {
  const sql = read("supabase/migrations/20260729114539_simplify_employee_level_profile_save.sql");
  const inserts = sql.match(/insert into public\.employee_level_audit_logs/g) || [];

  assert.equal(inserts.length, 1);
  assert.match(sql, /level_base_date_override is distinct from v_after\.level_base_date_override then[\s\S]*insert into public\.employee_level_audit_logs/);
  assert.match(sql, /employee_profile_save/);
});

test("owner and master inclusion is stored atomically by the follow-up RPC", () => {
  const route = read("app/api/admin/users/route.ts");
  const sql = read("supabase/migrations/20260729222342_add_manual_owner_levels_and_zero_based_audit.sql");
  assert.match(route, /employee_update_profile_and_level_v3/);
  assert.match(route, /p_level_program_enabled: levelProgramEnabled/);
  assert.match(sql, /employee_update_profile_and_level_v3/);
  assert.match(sql, /v_role in \('owner', 'master'\)/);
  assert.match(sql, /level_program_enabled = v_level_program_enabled/);
  assert.match(sql, /v_level_program_enabled is distinct from true then null[\s\S]*else p_base_date_override/);
  assert.match(sql, /level_base_date_override = v_base_date_override/);
  assert.match(sql, /else v_before\.level_program_enabled/);
  assert.match(sql, /level_program_enabled is distinct from v_after\.level_program_enabled/);
  assert.match(sql, /v_before\.termination_date is not null[\s\S]*level_program_enabled is distinct from v_level_program_enabled/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
});

test("employee cards use the shared theme badge and preserve compact mobile layout", () => {
  const page = read("app/(protected)/admin/users/page.tsx");
  const route = read("app/api/admin/users/route.ts");
  const badge = read("components/employee/EmployeeLevelBadge.tsx");
  assert.match(page, /EmployeeLevelBadge/);
  assert.match(page, /isEmployeeLevelEligibleRole\(user\.role, user\.level_program_enabled\)/);
  assert.match(route, /isEmployeeLevelEligibleRole\(resultingRole, levelProgramEnabled\)/);
  assert.match(page, /baseDateMode: "hire_date" \| "override"/);
  assert.match(page, /levelBaseDateOverride:[\s\S]*levelDraft\.baseDateMode === "override"/);
  assert.match(page, /setUsers\(\(current\) =>[\s\S]*current\.map/);
  assert.doesNotMatch(page, /saveLevelPolicy/);
  assert.doesNotMatch(page, /changeReason/);
  assert.match(page, /levelProgramInclude/);
  assert.match(page, /isEmployeeLevelManualRole\(draft\.role\)/);
  assert.match(page, /levelProgramEnabled: levelDraft\.included/);
  assert.match(page, /isEmployeeLevelManualRole\(draft\.role\) && !levelDraft\.included[\s\S]*\? null/);
  assert.match(route, /levelProgramEnabled !== true[\s\S]*levelBaseDateOverride = null/);
  assert.match(page, /user\.levelInfo\.level !== null/);
  assert.match(badge, /EMPLOYEE_LEVEL_THEME\[level\]/);
  assert.match(badge, /minWidth: 16/);
  assert.match(badge, /height: 16/);
  assert.match(badge, /linear-gradient/);
  assert.match(badge, /fontSize: 9/);
  assert.match(badge, /flexShrink: 0/);
  assert.match(badge, /negotiationEligible/);
  assert.match(page, /textOverflow: "ellipsis"/);
  assert.match(page, /text\.directBaseShort/);
  assert.match(page, /text\.nextLevelShort/);
  assert.match(page, /text\.highestLevel/);
  assert.doesNotMatch(page, /info\.cumulativeRaiseAmount/);
});

test("Korean and Vietnamese employee-level copy is present", () => {
  const text = read("lib/text/admin-users.ts");
  for (const phrase of [
    "직원 레벨", "입사일 기준", "직접 설정", "급여 협상 가능",
    "Cấp nhân viên", "Theo ngày vào làm", "Ngày thiết lập riêng", "Có thể thương lượng lương",
  ]) assert.match(text, new RegExp(phrase));
});
