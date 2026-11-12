import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { payrollApplicabilityIcons } from "../lib/payroll/applicability-icons.ts";
import { getPayrollApplicabilityBadges } from "../lib/payroll/payroll-dashboard.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const usersPage = read("app/(protected)/admin/users/page.tsx");
const card = read("components/payroll/CompensationCard.tsx");

const month = "2026-11";
const employee = (overrides: Record<string, unknown> = {}) => ({
  userId: 1,
  insuranceEnrolled: false,
  tax: { status: "not_applicable", taxMode: "not_applicable" },
  attendanceStanding: { perfectAttendanceCurrent: false },
  automaticIncentives: [] as { category: string; sourceSnapshot: Record<string, unknown> }[],
  ...overrides,
});
const keys = (input: Parameters<typeof payrollApplicabilityIcons>[0]) => payrollApplicabilityIcons(input).map((icon) => icon.symbol).join(" ");
const base = { month, future: false, monthClosed: false, attendanceBonusEligible: false, mealAllowanceEligible: false, lang: "ko" as const };

test("all four icons when every payroll condition holds (open month)", () => {
  const all = employee({ insuranceEnrolled: true, tax: { status: "calculated", taxMode: "resident_progressive" }, attendanceStanding: { perfectAttendanceCurrent: true } });
  assert.equal(keys({ ...base, employee: all, attendanceBonusEligible: true, mealAllowanceEligible: true }), "💯 🍚 🛡️ TNCN");
});

test("partial and none", () => {
  assert.equal(keys({ ...base, employee: employee({ insuranceEnrolled: true }), mealAllowanceEligible: true }), "🍚 🛡️");
  assert.equal(keys({ ...base, employee: employee() }), "");
});

test("💯 is not shown for eligibility alone; it needs current perfect attendance (or an applied bonus)", () => {
  assert.equal(keys({ ...base, employee: employee(), attendanceBonusEligible: true }), "");
  assert.equal(keys({ ...base, employee: employee({ attendanceStanding: { perfectAttendanceCurrent: true } }) }), "", "perfect attendance without eligibility");
});

test("month boundary: a closed month shows 💯 only for a bonus applied to that payroll month", () => {
  const applied = employee({ automaticIncentives: [{ category: "attendance_bonus", sourceSnapshot: { payrollMonth: month } }] });
  const otherMonth = employee({ automaticIncentives: [{ category: "attendance_bonus", sourceSnapshot: { payrollMonth: "2026-10" } }] });
  assert.equal(keys({ ...base, monthClosed: true, employee: applied }), "💯");
  assert.equal(keys({ ...base, monthClosed: true, employee: otherMonth }), "");
});

test("TNCN only for a calculated resident_progressive tax — not for a profile under review", () => {
  assert.equal(keys({ ...base, employee: employee({ tax: { status: "requires_review", taxMode: "resident_progressive" } }) }), "");
  assert.equal(keys({ ...base, employee: employee({ tax: { status: "calculated", taxMode: "resident_progressive" } }) }), "TNCN");
});

test("future month mirrors the payroll card: meal only", () => {
  const all = employee({ insuranceEnrolled: true, tax: { status: "calculated", taxMode: "resident_progressive" } });
  assert.equal(keys({ ...base, future: true, employee: all, mealAllowanceEligible: true }), "🍚");
});

test("decisions and descriptions come from the same function the payroll card uses (KO/VI)", () => {
  for (const lang of ["ko", "vi"] as const) {
    const input = { ...base, lang, employee: employee({ insuranceEnrolled: true, tax: { status: "calculated", taxMode: "resident_progressive" }, attendanceStanding: { perfectAttendanceCurrent: true } }), attendanceBonusEligible: true, mealAllowanceEligible: true };
    const badges = getPayrollApplicabilityBadges(input);
    assert.deepEqual(payrollApplicabilityIcons(input).map((icon) => icon.description), badges.map((badge) => badge.description));
  }
  // The payroll card renders those badges with the same symbol mapping.
  assert.match(card, /badge\.key === "meal" \? "🍚" : badge\.key === "insurance" \? "🛡️" : badge\.label/);
  assert.match(card, /getPayrollApplicabilityBadges\(\{ employee, month, monthClosed, attendanceBonusEligible, mealAllowanceEligible, lang \}\)/);
});

test("users page reads the existing payroll overview once per list load, after the list, for the current Vietnam month", () => {
  assert.equal((usersPage.match(/\/api\/admin\/payroll\/overview\?month=/g) ?? []).length, 1);
  assert.match(usersPage, /setHasLoadedUsers\(true\);\n\s+void fetchPayrollApplicability\(\);/);
  assert.match(usersPage, /const month = vietnamCurrentMonthStart\(\)\.slice\(0, 7\);/);
  assert.match(usersPage, /data\.month !== month/);
  assert.match(usersPage, /applicabilityController\.abort\(\);/);
  // Loading/failure are shown as such, never as "not applicable".
  assert.match(usersPage, /applicability\.status === "error" \? <span style=\{styles\.payrollIconsMuted\} role="status"/);
  // The list API is unchanged (no payroll data added to /api/admin/users).
  assert.doesNotMatch(read("app/api/admin/users/route.ts"), /payroll\/overview|loadPayrollOverview/);
});

test("list card: level schedule line removed; work time moved to the second row; edit stays on the first row", () => {
  assert.doesNotMatch(usersPage, /<LevelSummary /);
  const cardStart = usersPage.indexOf("function UserCard(");
  const firstRow = usersPage.slice(usersPage.indexOf("<div style={styles.rowMain}>", cardStart), usersPage.indexOf("{hasSecondRow ? (", cardStart));
  assert.doesNotMatch(firstRow, /workTime|styles\.workTimeText/);
  assert.match(firstRow, /text\.cancel : text\.edit/);
  const secondRow = usersPage.slice(usersPage.indexOf("{hasSecondRow ? (", cardStart), usersPage.indexOf("{isEditing ? (", cardStart));
  assert.match(secondRow, /<span style=\{styles\.workTimeText\}>\{workTime\}\{workDuration \? ` \(\$\{workDuration\}\)` : ""\}<\/span>/);
  // formatWorkTime is reused unchanged; employees with no stored hours get no "---" placeholder.
  assert.match(usersPage, /const workTime = !isAdminGroupUser && !user\.termination_date && \(user\.work_start_time \|\| user\.work_end_time\) \? formatWorkTime\(user\) : "";/);
  assert.match(usersPage, /function formatWorkTime\(user: UserRow\) \{\n  const start = user\.work_start_time \|\| "-";\n  const end = user\.work_end_time \|\| "-";\n  return `\$\{start\}-\$\{end\}`;/);
});
