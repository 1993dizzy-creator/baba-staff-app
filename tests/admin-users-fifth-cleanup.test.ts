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

test("5차 B-3: the page shows the localized message, keeps the detail and draft, and never reports success", () => {
  const save = page.slice(page.indexOf("if (!res.ok || !result.ok || !result.user) {"), page.indexOf("setUsers((current) =>\n        current.map((user) => (user.id === original.id"));
  assert.match(save, /if \(result\.code === "ATTENDANCE_OPEN_RECORD_EXISTS"\) \{[\s\S]*?window\.alert\(result\.error \|\| text\.saveFailed\);\n\s+return false;/);
  assert.match(save, /const blocked = attendanceDisableBlockCode\(result\);\n\s+if \(blocked\) \{\n\s+window\.alert\(blocked === "ATTENDANCE_BONUS_ELIGIBLE_BLOCKS_ATTENDANCE_TRACKING_DISABLE" \? text\.attendanceDisableBlockedBonus : text\.attendanceDisableBlockedMeal\);\n\s+return false;\n\s+\}/);
  assert.doesNotMatch(save, /saveSuccess/);
  // the save button still blocks duplicate requests
  assert.match(page, /if \(savePending\.current \|\| isSaving \|\| levelModalOpen\) return;\n\s+savePending\.current = true;/);
  const { ko, vi } = adminUsersText;
  assert.equal(ko.attendanceDisableBlockedBonus, "개근 보너스 대상자로 설정되어 있어 근태 기록을 중지할 수 없습니다. 먼저 복리후생의 개근 보너스 설정에서 대상 자격과 적용월을 확인하고 해제한 후 다시 저장해 주세요.");
  assert.equal(vi.attendanceDisableBlockedBonus, "Không thể tắt chấm công vì nhân viên vẫn đang thuộc diện thưởng chuyên cần. Vui lòng kiểm tra và ngừng áp dụng thưởng chuyên cần trong mục Phúc lợi, đồng thời kiểm tra tháng hiệu lực trước khi lưu lại.");
  for (const lang of [ko, vi]) for (const message of [lang.attendanceDisableBlockedBonus, lang.attendanceDisableBlockedMeal]) {
    assert.doesNotMatch(message, /Failed|ATTENDANCE_|MEAL_ALLOWANCE_/);
  }
});

test("5차 A/B: app-login and always-on attendance help texts are gone; the fixed-monthly notice is conditional", () => {
  for (const lang of [adminUsersText.ko, adminUsersText.vi] as Record<string, unknown>[]) {
    for (const key of ["appLoginAllowedHelp", "attendancePayrollHelp", "payrollContractMismatch", "contractBasisAttendance", "contractBasisNoAttendance", "bonusSwitchHelp"]) assert.equal(lang[key], undefined, key);
  }
  assert.equal(adminUsersText.ko.attendanceOffRequiresFixedMonthly, "근태 기록을 사용하지 않으려면 급여계약을 '월 고정급'으로 설정해야 합니다.");
  assert.equal(adminUsersText.vi.attendanceOffRequiresFixedMonthly, "Để tắt chấm công, cần thiết lập hợp đồng lương cố định hằng tháng.");
  const rule = page.slice(page.indexOf("function attendanceOffNeedsFixedMonthly("), page.indexOf("// 급여설정 직원 목록"));
  assert.match(rule, /if \(draft\.attendance_tracking_enabled !== false \|\| contracts\.loading \|\| contracts\.loadFailed\) return false;/);
  assert.match(rule, /return !fixed\(contracts\.current\) \|\| \(contracts\.scheduled !== null && !fixed\(contracts\.scheduled\)\);/);
  assert.match(page, /<Toggle label=\{text\.appLoginAllowed\}/);
});

test("5차 C: contract summary = type · current combined salary from the payroll engine and the shared formatter", () => {
  assert.match(page, /import \{ formatContractRate \} from "@\/lib\/payroll\/payroll-page-money";/);
  const helper = page.slice(page.indexOf("function currentContractAmount("), page.indexOf("function attendanceOffNeedsFixedMonthly("));
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
