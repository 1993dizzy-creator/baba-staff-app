import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("admin users API exposes calculated level info through the shared calculator", () => {
  const route = read("app/api/admin/users/route.ts");
  assert.match(route, /requireRole\(\["owner", "master"\]\)/);
  assert.match(route, /level_program_enabled/);
  assert.match(route, /level_base_date_override/);
  assert.match(route, /withEmployeeLevelInfo/);
  assert.match(route, /action === "update_employee_level_policy"/);
  assert.match(route, /validateEmployeeLevelConfiguration/);
  for (const code of [
    "SYSTEM_ACCOUNT_NOT_ELIGIBLE", "HIRE_DATE_REQUIRED", "BASE_DATE_BEFORE_HIRE_DATE",
    "BASE_DATE_AFTER_TERMINATION_DATE", "BASE_DATE_IN_FUTURE", "CHANGE_REASON_REQUIRED", "NO_CHANGES",
  ]) assert.match(route, new RegExp(code));
});

test("level policy and rehire mutations are atomic audited RPCs", () => {
  const sql = read("supabase/migrations/202607290002_add_employee_level_policy_rpcs.sql");
  assert.match(sql, /employee_update_level_policy_v1/);
  assert.match(sql, /employee_rehire_with_level_reset_v1/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = pg_catalog, public/);
  assert.match(sql, /update public\.users[\s\S]*insert into public\.employee_level_audit_logs/);
  assert.match(sql, /level_program_enabled = null/);
  assert.match(sql, /level_base_date_override = null/);
  assert.match(sql, /level_reset_on_rehire/);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute[\s\S]*to service_role/);
});

test("employee cards use the shared theme badge and preserve compact mobile layout", () => {
  const page = read("app/(protected)/admin/users/page.tsx");
  const badge = read("components/employee/EmployeeLevelBadge.tsx");
  assert.match(page, /EmployeeLevelBadge/);
  assert.match(page, /level_program_enabled === true/);
  assert.match(page, /status: "unset" \| "enabled" \| "disabled"/);
  assert.match(page, /baseDateMode: "hire_date" \| "override"/);
  assert.match(page, /levelDraft\.changeReason\.trim\(\)\.length < 2/);
  assert.match(page, /setUsers\(\(current\) => current\.map/);
  assert.match(badge, /EMPLOYEE_LEVEL_THEME\[level\]/);
  assert.match(badge, /width: 24/);
  assert.match(badge, /height: 24/);
  assert.match(badge, /flexShrink: 0/);
  assert.match(badge, /negotiationEligible/);
  assert.match(page, /textOverflow: "ellipsis"/);
});

test("Korean and Vietnamese employee-level copy is present", () => {
  const text = read("lib/text/admin-users.ts");
  for (const phrase of [
    "직원 레벨", "레벨 미설정", "급여 협상 가능", "변경 사유",
    "Cấp nhân viên", "Chưa thiết lập cấp", "Có thể thương lượng lương", "Lý do thay đổi",
  ]) assert.match(text, new RegExp(phrase));
});
