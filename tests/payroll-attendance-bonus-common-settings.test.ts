import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const ui = read("components/payroll/PayrollCommonSettings.tsx");
const route = read("app/api/admin/payroll/settings/route.ts");
const migration = read("supabase/migrations/20260811103600_integrate_attendance_bonus_common_settings.sql");

test("attendance bonus uses the shared common-settings section and single save button", () => {
  assert.match(ui, /<SettingsGroup title=\{`✨ \$\{vi \? "Thưởng chuyên cần" : "개근 보너스"\}`\}>/);
  assert.doesNotMatch(ui, /AttendanceBonusPolicySettings|정책 저장|Lưu chính sách/);
  assert.equal((ui.match(/공통 설정 저장/g) ?? []).length, 1);
  assert.equal((ui.match(/method: "PUT"/g) ?? []).length, 1);
  assert.match(ui, /변경 이력 \$\{bonusHistory\.length\}건/);
});

test("unchanged attendance bonus is omitted while a changed draft joins the common PUT", () => {
  assert.match(ui, /const bonusDirty = JSON\.stringify\(bonusDraft\) !== JSON\.stringify\(bonusSnapshot\)/);
  for (const field of [
    "attendanceBonusMinimumActualWorkdays",
    "attendanceBonusAllowedLateCount",
    "attendanceBonusAllowedEarlyLeaveCount",
    "attendanceBonusAmount",
    "attendanceBonusEffectiveMonth",
    "attendanceBonusNote",
  ]) assert.match(ui, new RegExp(`${field}: bonusDirty \\?`));
  assert.match(ui, /const dirty = settingsDirty \|\| mealDirty \|\| bonusDirty/);
});

test("route validates the complete bonus policy and calls only the atomic v2 RPC", () => {
  assert.match(route, /const bonusUntouched = bonusValues\.every/);
  assert.match(route, /const bonusComplete = bonusValues\.every/);
  assert.match(route, /bonusMinimumActualWorkdays! <= 0/);
  assert.match(route, /bonusAllowedLateCount! < 0/);
  assert.match(route, /bonusAllowedEarlyLeaveCount! < 0/);
  assert.match(route, /bonusAmount! <= 0/);
  assert.match(route, /rpc\("payroll_update_common_settings_v2", \{/);
  const put = route.slice(route.indexOf("export async function PUT"));
  assert.equal((put.match(/supabaseServer\.rpc\(/g) ?? []).length, 1);
});

test("v2 RPC is atomic and appends a bonus revision only when the latest policy differs", () => {
  assert.match(migration, /create function public\.payroll_update_common_settings_v2/);
  assert.match(migration, /v_result := public\.payroll_update_common_settings_v1\(/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtext\('payroll_attendance_bonus_policy_versions'\)\)/);
  assert.match(migration, /order by effective_month desc, revision desc/);
  assert.match(migration, /if not found[\s\S]*or v_bonus_current\.effective_month is distinct from p_bonus_effective_month[\s\S]*insert into public\.payroll_attendance_bonus_policy_versions/);
  assert.match(migration, /'attendanceBonusPolicyChanged', v_bonus_changed/);
  assert.match(migration, /now\(\) at time zone 'Asia\/Ho_Chi_Minh'/);
});

test("v2 RPC remains service-role-only", () => {
  assert.match(migration, /revoke all on function public\.payroll_update_common_settings_v2\([\s\S]*\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.payroll_update_common_settings_v2\([\s\S]*\) to service_role;/);
});
