import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { attendanceDisableBlockCode } from "../lib/employee/attendance-disable-block.ts";
import { adminUsersText } from "../lib/text/admin-users.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/users/page.tsx");
const route = read("app/api/admin/users/route.ts");

test("5차 B-3: attendance-OFF block codes are recognised only from the exact server code (code or error)", () => {
  assert.equal(attendanceDisableBlockCode({ error: "Failed to atomically update user: ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE" }), "ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE");
  assert.equal(attendanceDisableBlockCode({ error: "Failed to atomically update user: MEAL_ALLOWANCE_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE" }), "MEAL_ALLOWANCE_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE");
  assert.equal(attendanceDisableBlockCode({ code: "ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE" }), "ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE");
  for (const other of [{ code: "ATTENDANCE_OPEN_RECORD_EXISTS", error: "..." }, { error: "Failed to atomically update user: SOMETHING_ELSE" },
    { error: "X_ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE_Y" }, { error: "attendance bonus" }, {}, null]) {
    assert.equal(attendanceDisableBlockCode(other), null, JSON.stringify(other));
  }
  // the API is unchanged: the trigger codes still arrive inside the generic error; the open-record code keeps its own branch
  assert.match(route, /throw new Error\(`Failed to atomically update user: \$\{error\.message\}`\);/);
  assert.match(route, /code: "ATTENDANCE_OPEN_RECORD_EXISTS",/);
});

test("detail saves preserve attendance: no independent switch, mutation or disable instructions", () => {
  assert.doesNotMatch(page, /<Toggle label=\{text\.attendanceTracking\}/);
  assert.doesNotMatch(page, /update\("attendance_tracking_enabled"/);
  const updates = page.slice(page.indexOf("const updates: Record<string, unknown>"), page.indexOf('if (original.role === "owner")',page.indexOf("const updates: Record<string, unknown>")));
  assert.doesNotMatch(updates, /attendance_tracking_enabled/);
  assert.match(updates, /app_login_enabled/);
  assert.match(page, /draft\.attendance_tracking_enabled !== false \? \(/);
  assert.match(page, /if \(savePending\.current \|\| isSaving \|\| levelModalOpen\) return;/);
  assert.doesNotMatch(page, /attendanceDisableBlockCode|attendanceOffNeedsFixedMonthly/);
});

test("obsolete independent attendance guidance is removed in both languages; detail login management remains", () => {
  for (const lang of [adminUsersText.ko, adminUsersText.vi] as Record<string, unknown>[]) {
    for (const key of ["appLoginAllowedHelp", "attendancePayrollHelp", "payrollContractMismatch", "contractBasisAttendance", "contractBasisNoAttendance", "bonusSwitchHelp",
      "attendanceOffRequiresFixedMonthly", "attendanceDisableBlockedBonus", "attendanceDisableBlockedMeal"]) assert.equal(lang[key], undefined, key);
  }
  assert.match(page, /<Toggle label=\{text\.appLoginAllowed\}/);
});

test("5차 C: contract summary = type · current combined salary from the payroll engine and the shared formatter", () => {
  assert.match(page, /import \{ formatContractRate \} from "@\/lib\/payroll\/payroll-page-money";/);
  const helper = page.slice(page.indexOf("function currentContractAmount("), page.indexOf("// 급여설정 직원 목록"));
  assert.match(helper, /calculateCombinedSalary\(\{ \.\.\.contract, payType \}, levelInfo\)\.combinedSalary/);
  assert.match(helper, /formatContractRate\(combined, payType, lang\)/);
  // the summary uses the current contract only; the scheduled one stays a separate line
  assert.match(page, /const amount = current \? currentContractAmount\(current, user\.levelInfo, lang\) : null;/);
  assert.match(page, /\{ready && contracts\.scheduled \? <span style=\{styles\.modalMuted\}>\{text\.payrollContractScheduled\}/);
});

test("5차 D (switch restore): five tiles with a real switch each, opening the existing setting modals (never saving)", () => {
  const block = page.slice(page.indexOf("<div style={styles.benefitGrid}>"), page.indexOf("{/* 급여 대상 예외"));
  assert.equal((block.match(/<BenefitTile/g) ?? []).length, 2, "level tile + mapped 4");
  assert.match(block, /wide\n\s+emoji="📈"/);
  assert.match(block, /onSwitch=\{openLevelModal\}\n\s+onDetail=\{openLevelModal\}/);
  assert.match(block, /switchDisabled=\{needsAttendance\}/);
  assert.match(block, /stateLabel=\{director \? text\.benefitCommonManaged : benefitUnsetLabel\(row\.key, status, text\)\}/);
  assert.doesNotMatch(block, /bonusSwitchHelp|requiresAttendance|detailSettings|levelBaseMonth/);
  assert.match(page, /benefitGrid: \{ display: "grid", gridTemplateColumns: "repeat\(2, minmax\(0, 1fr\)\)"/);
  assert.match(page, /benefitTileWide: \{ gridColumn: "1 \/ -1",/);
  // no nested buttons: the switch and the name button are siblings inside a <div>
  const tile = page.slice(page.indexOf("function BenefitTile("), page.indexOf("/** 둥근 트랙과 원형 손잡이"));
  assert.equal((tile.match(/<button/g) ?? []).length, 3, "name, retry, switch (retry and switch are alternatives)");
  assert.equal((tile.match(/<\/button>/g) ?? []).length, 3);
});
