import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const staffPage = read("app/(protected)/attendance/staff/page.tsx");
const leavePage = read("app/(protected)/attendance/leave/page.tsx");
const payrollAttendancePage = read("app/(protected)/admin/payroll/attendance/page.tsx");
const payrollAttendanceUserPage = read("app/(protected)/admin/payroll/attendance/[userId]/page.tsx");
const mypage = read("app/(protected)/mypage/page.tsx");
const compensationCard = read("components/payroll/CompensationCard.tsx");

const pagesWithRoleLabelAndRank = [
  ["attendance/staff", staffPage],
  ["attendance/leave", leavePage],
  ["admin/payroll/attendance", payrollAttendancePage],
] as const;

for (const [name, source] of pagesWithRoleLabelAndRank) {
  test(`${name}: sorts by the shared role rank, not a local/position-based rank`, () => {
    assert.match(source, /from "@\/lib\/common\/roles"/);
    assert.match(source, /getEmployeeRoleRank\(/);
    assert.doesNotMatch(source, /getPositionRank/);
    assert.doesNotMatch(source, /common\/positions/);
  });

  test(`${name}: the name-adjacent label is role-based (t.positions is no longer read)`, () => {
    assert.doesNotMatch(source, /t\.positions\?\.\[/);
    assert.match(source, /getEmployeeRoleLabel\(/);
  });
}

test("admin/payroll/attendance/[userId]: header title is role-based, not t.positions[user.position]", () => {
  assert.doesNotMatch(payrollAttendanceUserPage, /t\.positions\?\.\[/);
  assert.match(payrollAttendanceUserPage, /from "@\/lib\/common\/roles"/);
  assert.match(payrollAttendanceUserPage, /getEmployeeRoleLabel\(user\.role, lang\)/);
});

test("attendance/leave: the leave-management staff list excludes owner/master by role, not position", () => {
  assert.match(leavePage, /isOwnerOrMasterRole/);
  assert.match(leavePage, /!isOwnerOrMasterRole\(user\.role\)/);
  assert.doesNotMatch(leavePage, /user\.position !== "owner"/);
});

test("mypage: the position label reads from the employee's role via getEmployeeRoleLabel", () => {
  assert.match(mypage, /from "@\/lib\/common\/roles"/);
  assert.match(mypage, /getEmployeeRoleLabel\(userInfo\.role, lang\)/);
  assert.match(mypage, /select\("id, username, name, part, position, role, birth_date, hire_date"\)/);
});

test("CompensationCard: the position label next to the employee name is role-based", () => {
  assert.doesNotMatch(compensationCard, /attendance\.positions\[/);
  assert.doesNotMatch(compensationCard, /import \{ attendanceText \} from "@\/lib\/text"/);
  assert.match(compensationCard, /from "@\/lib\/common\/roles"/);
  assert.match(compensationCard, /employee\.role\s*\n\s*\? getEmployeeRoleLabel\(employee\.role, lang\)\s*\n\s*: employee\.username;/);
});

test("payroll overview types carry role alongside the legacy position field", () => {
  const overview = read("lib/payroll/overview.ts");
  assert.match(overview, /role: string \| null;/);
  assert.match(overview, /role: user\.role,/);
});

test("attendance calculation logic itself was not touched (no position reference anywhere in lib/attendance or lib/employment)", () => {
  const attendanceLibFiles = [
    "lib/attendance/api-policy.ts",
    "lib/employment/eligibility.ts",
    "lib/employment/termination-policy.ts",
  ];
  for (const file of attendanceLibFiles) {
    assert.doesNotMatch(read(file), /\bposition\b/);
  }
});
