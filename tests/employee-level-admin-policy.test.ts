import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { sanitizePublicEmployeeUser } from "../lib/employee-level/public-user.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("admin users API exposes calculated level info through the shared calculator", () => {
  const route = read("app/api/admin/users/route.ts");
  assert.match(route, /requireRole\(\["owner", "master"\]\)/);
  assert.match(route, /level_base_date_override/);
  assert.match(route, /withEmployeeLevelInfo/);
  assert.match(route, /employee_update_profile_and_level_v6/);
  assert.match(route, /loadEmployeeLevelProgramVersions/);
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
  assert.match(route, /target\.is_system_account && levelProgramEnabled === true/);
  assert.match(sql, /v_before\.is_system_account[\s\S]*level_base_date_override is distinct from p_base_date_override[\s\S]*p_base_date_override is not null/);
  assert.match(sql, /if not v_before\.is_system_account and v_hire_date is null/);
  assert.match(sql, /if not v_before\.is_system_account[\s\S]*insert into public\.employee_level_audit_logs/);
});

test("terminated employees may save unchanged profiles but base-date changes roll back", () => {
  const route = read("app/api/admin/users/route.ts");
  const sql = read("supabase/migrations/20260729114539_simplify_employee_level_profile_save.sql");

  assert.match(route, /target\.termination_date && levelPolicyChanged[\s\S]*TERMINATED_EMPLOYEE_READ_ONLY/);
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

test("all employee roles store effective-dated level policy atomically", () => {
  const route = read("app/api/admin/users/route.ts");
  const sql = read("supabase/migrations/202608040001_restore_employee_level_base_date_modes.sql");
  assert.match(route, /employee_update_profile_and_level_v6/);
  assert.match(route, /p_level_program_enabled: levelProgramEnabled/);
  assert.match(sql, /employee_update_profile_and_level_v6/);
  assert.match(sql, /employee_level_program_versions/);
  assert.match(sql, /where id = v_target\.id and v_target\.effective_from < p_effective_from/);
  assert.match(sql, /v_target\.enabled is not distinct from p_level_program_enabled/);
  assert.match(sql, /level_program_enabled = v_active\.enabled/);
  assert.match(sql, /TERMINATED_EMPLOYEE_READ_ONLY/);
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
});

test("v3 work-time hotfix preserves the function except for text-compatible assignments", () => {
  const original = read("supabase/migrations/20260729160628_add_manual_owner_levels_and_zero_based_audit.sql");
  const hotfix = read("supabase/migrations/20260729162803_fix_employee_profile_v3_text_work_times.sql");
  const functionSql = (sql: string) => {
    const start = sql.indexOf("create or replace function public.employee_update_profile_and_level_v3");
    const end = sql.indexOf("\n$$;", start) + 4;
    return sql.slice(start, end);
  };
  const expected = functionSql(original)
    .replace("nullif(p_updates ->> 'work_start_time', '')::time", "nullif(p_updates ->> 'work_start_time', '')")
    .replace("nullif(p_updates ->> 'work_end_time', '')::time", "nullif(p_updates ->> 'work_end_time', '')");

  assert.equal(functionSql(hotfix), expected);
  assert.doesNotMatch(hotfix, /work_(?:start|end)_time[\s\S]{0,100}::time/);
  assert.match(hotfix, /security definer/);
  assert.match(hotfix, /set search_path = pg_catalog, public/);
  assert.match(hotfix, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(hotfix, /grant execute[\s\S]*to service_role/);
});

test("v3 security hotfix only removes password from the RPC return", () => {
  const workTimeHotfix = read("supabase/migrations/20260729162803_fix_employee_profile_v3_text_work_times.sql");
  const securityHotfix = read("supabase/migrations/20260729163753_remove_password_from_employee_profile_v3.sql");
  const functionSql = (sql: string) => {
    const start = sql.indexOf("create or replace function public.employee_update_profile_and_level_v3");
    const end = sql.indexOf("\n$$;", start) + 4;
    return sql.slice(start, end);
  };

  assert.equal(
    functionSql(securityHotfix),
    functionSql(workTimeHotfix).replace(
      "return to_jsonb(v_after);",
      "return to_jsonb(v_after) - 'password';"
    )
  );
  assert.match(securityHotfix, /security definer/);
  assert.match(securityHotfix, /set search_path = pg_catalog, public/);
  assert.match(securityHotfix, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(securityHotfix, /grant execute[\s\S]*to service_role/);
});

test("admin user response sanitizer drops password and every unexpected field", () => {
  const safe = sanitizePublicEmployeeUser({
    id: 7,
    username: "employee",
    name: "Employee",
    full_name: null,
    role: "staff",
    part: "hall",
    position: "staff",
    gender: null,
    birth_date: null,
    hire_date: "2026-01-01",
    termination_date: null,
    work_start_time: "09:00",
    work_end_time: "18:00",
    is_active: true,
    is_system_account: false,
    payroll_eligible_override: null,
    level_program_enabled: null,
    level_base_date_override: null,
    password: "must-not-leak",
    private_token: "must-not-leak-either",
  });

  assert.equal(safe.username, "employee");
  assert.equal(safe.hire_date, "2026-01-01");
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "password"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(safe, "private_token"), false);

  const route = read("app/api/admin/users/route.ts");
  assert.match(route, /const USER_SELECT = `/);
  assert.match(route, /sanitizePublicEmployeeUser\(data\)/);
  assert.doesNotMatch(route, /withEmployeeLevelInfo\(data as UserRow/);
});

test("employee cards use the shared theme badge and preserve compact mobile layout", () => {
  const page = read("app/(protected)/admin/users/page.tsx");
  const route = read("app/api/admin/users/route.ts");
  const badge = read("components/employee/EmployeeLevelBadge.tsx");
  const nameWithLevel = read("components/employee/EmployeeNameWithLevel.tsx");
  assert.match(page, /EmployeeNameWithLevel/);
  assert.match(nameWithLevel, /EmployeeLevelBadge/);
  assert.match(page, /levelProgramPolicy\?\.currentEnabled/);
  assert.match(route, /levelPolicyChanged/);
  assert.match(page, /effectiveMonth: "current" \| "next"/);
  assert.match(page, /levelEffectiveFrom/);
  assert.match(page, /setUsers\(\(current\) =>[\s\S]*current\.map/);
  assert.doesNotMatch(page, /saveLevelPolicy/);
  assert.doesNotMatch(page, /changeReason|levelChangeReason|rehireReason/);
  assert.match(page, /levelPolicyHelp/);
  assert.match(page, /levelProgramEnabled: levelDraft\.included/);
  assert.match(page, /levelStateChanged/);
  assert.match(route, /comparisonBaseDateMode/);
  assert.match(nameWithLevel, /levelInfo\?\.eligible === true && levelInfo\.level !== null/);
  assert.match(nameWithLevel, /PROGRAM_DISABLED/);
  assert.match(badge, /disabled \? "X"/);
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

test("level policy mutations use server-owned stable audit reason codes", () => {
  const page = read("app/(protected)/admin/users/page.tsx");
  const createPage = read("app/(protected)/admin/users/create/page.tsx");
  const route = read("app/api/admin/users/route.ts");
  const createRoute = read("app/api/admin/users/create/route.ts");
  const text = read("lib/text/admin-users.ts");

  assert.match(route, /"admin_level_enabled"/);
  assert.match(route, /"admin_level_disabled"/);
  assert.match(route, /"employee_rehired_level_enabled"/);
  assert.match(route, /"employee_rehired_level_disabled"/);
  assert.doesNotMatch(route, /body\.levelChangeReason|body\.changeReason/);
  assert.match(createRoute, /"employee_created_level_enabled"/);
  assert.match(createRoute, /"employee_created_level_disabled"/);
  assert.doesNotMatch(createRoute, /body\.level_change_reason/);
  assert.doesNotMatch(page, /levelStateChanged && !levelDraft/);
  assert.match(page, /disabled=\{isSaving\}/);
  assert.match(page, /disabled=\{!rehireDate\|\|isSaving\}/);
  assert.doesNotMatch(createPage, /level_change_reason|levelChangeReason/);
  assert.doesNotMatch(text, /levelChangeReason/);
});

test("Korean and Vietnamese employee-level copy is present", () => {
  const text = read("lib/text/admin-users.ts");
  for (const phrase of [
    "장기근무 레벨", "레벨 미적용", "레벨 설정 필요", "급여 협상 가능",
    "레벨 계산 기준", "입사일 기준", "직접 기준",
    "Cấp làm việc lâu dài", "Không áp dụng cấp", "Cần thiết lập cấp", "Có thể thương lượng lương",
    "Mốc tính cấp", "Theo ngày vào làm", "Ngày chỉ định",
  ]) assert.match(text, new RegExp(phrase));
});
