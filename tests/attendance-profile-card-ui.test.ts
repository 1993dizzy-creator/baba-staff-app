import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { calculateEmployeeLevel } from "../lib/employee-level/calculate.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/attendance/page.tsx");
const route = read("app/api/attendance/profile/route.ts");

function levelAt(asOfDate: string) {
  return calculateEmployeeLevel({
    role: "staff",
    hireDate: "2026-01-15",
    levelBaseDateOverride: null,
    asOfDate,
  });
}

test("shared level info supplies the exact cumulative bonus for Lv.0, Lv.3, and Lv.7", () => {
  assert.equal(levelAt("2026-01-15").cumulativeRaiseAmount, 0);
  assert.equal(levelAt("2026-10-15").cumulativeRaiseAmount, 1_500_000);
  assert.equal(levelAt("2027-10-15").cumulativeRaiseAmount, 3_500_000);
});

test("attendance profile is fetched from one self-only endpoint", () => {
  assert.match(page, /attendanceFetch\("\/api\/attendance\/profile"\)/);
  assert.match(route, /const auth = await requireAttendanceActor\(\)/);
  assert.match(route, /\.eq\("id", auth\.actor\.id\)/);
  assert.doesNotMatch(route, /new URL|searchParams|userId/);
  assert.doesNotMatch(page, /\/api\/admin\/payroll\/overview/);
});

test("profile uses the shared employee level source without reading payroll contracts", () => {
  assert.match(route, /loadEmployeeLevelProgramVersions\(\[auth\.actor\.id\], asOfDate\)/);
  assert.match(route, /applyEmployeeLevelProgramVersion/);
  assert.match(route, /withEmployeeLevelInfo/);
  assert.doesNotMatch(route, /payroll_contract_versions|calculateCombinedSalary|mapContract|combinedSalary|currentSalary/);
  assert.doesNotMatch(page, /formatContractRate|combinedSalary|currentSalary/);
});

test("the first card shows identity, role, and cumulative level bonus without salary totals", () => {
  const firstCard = page.slice(page.indexOf("<div style={cardStyle}>"), page.indexOf("<div style={actionGrid}>"));
  assert.match(firstCard, /<EmployeeNameWithLevel/);
  assert.match(firstCard, /getEmployeeRoleLabel\(profile\.role, lang\)/);
  assert.match(firstCard, /p\.nextLevel/);
  assert.match(firstCard, /profile\.levelInfo\.cumulativeRaiseAmount/);
  assert.match(firstCard, /p\.levelBonus/);
  assert.doesNotMatch(firstCard, /currentSalaryText|combinedSalary|currentSalary/);
  assert.doesNotMatch(firstCard, /formatTodayDate|nowText|todayDateRow|statusBadgeStyle|getStatusLabel/);
  assert.doesNotMatch(page, /setInterval\(updateNow|setNowText/);
});

test("next level and bonus are both omitted for ineligible employees and retained at maximum level", () => {
  assert.match(page, /profile\?\.levelInfo\.eligible === true \? \([\s\S]*?p\.nextLevel[\s\S]*?cumulativeRaiseAmount[\s\S]*?p\.levelBonus[\s\S]*?\) : null/);
  assert.doesNotMatch(page, /profileSummaryCenteredStyle/);
  assert.match(page, /profile\?\.levelInfo\.nextLevelDate/);
  assert.match(page, /profile\?\.levelInfo\.level === 7[\s\S]*?p\.maximumLevel[\s\S]*?: "-"/);
  assert.match(page, /formatSignedVnd\(profile\.levelInfo\.cumulativeRaiseAmount, "\+"\)/);
  assert.doesNotMatch(page, /combinedSalary|currentSalary|formatContractRate/);
});

test("attendance values stay compact and do not wrap Vietnamese Đúng giờ", () => {
  assert.match(page, /const todayInfoLabel: CSSProperties = \{[\s\S]*?fontSize: 11,[\s\S]*?lineHeight: 1\.1/);
  assert.match(page, /const todayInfoValue: CSSProperties = \{[\s\S]*?fontSize: 12,[\s\S]*?whiteSpace: "nowrap"/);
  assert.match(page, /const todayStatusPanel: CSSProperties = \{[\s\S]*?padding: "11px 6px"/);
});

test("check-in and check-out buttons are single-line icon and title controls without description text", () => {
  const buttons = page.slice(page.indexOf("<div style={actionGrid}>"), page.indexOf("{actionFeedback.message ? ("));
  assert.match(buttons, /<span style=\{actionButtonIcon\}>↪<\/span>/);
  assert.match(buttons, /<span style=\{actionButtonIconDark\}>↩<\/span>/);
  assert.doesNotMatch(buttons, /checkInButtonDesc|checkOutButtonDesc|actionButtonSubDark|actionButtonTextWrap/);
  assert.match(page, /const actionButtonBase: CSSProperties = \{[\s\S]*?minHeight: 50/);
  assert.match(page, /const actionButtonTitle: CSSProperties = \{[\s\S]*?whiteSpace: "nowrap"/);
});

test("existing attendance metrics and check-in/out handlers remain wired", () => {
  for (const value of [
    "attendance.checkInTime",
    "attendance.checkOutTime",
    "lateDisplayText",
    "attendance.workDuration",
    "onClick={handleCheckIn}",
    "onClick={handleCheckOutClick}",
  ]) assert.match(page, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(page, /getCurrentPosition\(\)/);
  assert.match(page, /distanceM <= ALLOWED_DISTANCE_M/);
  assert.match(page, /void loadMonthAttendance\(\{ force: true, afterAttendanceSave: true \}\)/);
});

test("Korean and Vietnamese profile labels are both present", () => {
  assert.match(page, /nextLevel: "다음 레벨"/);
  assert.match(page, /maximumLevel: "최고 레벨"/);
  assert.match(page, /levelBonus: "레벨 보너스"/);
  assert.match(page, /nextLevel: "Cấp tiếp theo"/);
  assert.match(page, /maximumLevel: "Cấp cao nhất"/);
  assert.match(page, /levelBonus: "Thưởng cấp"/);
});
