import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/users/route.ts");
const page = read("app/(protected)/attendance/leave/page.tsx");

test("leave-month users query scans only leave user ids and starts with the users query", () => {
  assert.match(route, /requestedMode === "month" \|\| requestedMode === "leave_month"/);
  assert.match(
    route,
    /const leaveIdsQuery = mode === "leave_month"[\s\S]*?\.from\("attendance_records"\)[\s\S]*?\.select\("user_id"\)[\s\S]*?\.gte\("work_date", first\)[\s\S]*?\.lte\("work_date", last\)[\s\S]*?\.eq\("status", "leave"\)/,
  );
  assert.match(route, /await Promise\.all\(\[usersQuery, leaveIdsQuery\]\)/);
  assert.match(route, /mode === "leave_month"[\s\S]*?shouldIncludeLeaveMonthlyEmployee[\s\S]*?: shouldIncludeMonthlyEmployee/);
});

test("leave-month reuses monthly privacy and month-end level serialization", () => {
  assert.equal((route.match(/const serializeUsers =/g) ?? []).length, 1);
  assert.match(route, /const \{ birth_date: _privateBirthDate, \.\.\.publicUser \} = user/);
  assert.match(route, /serializeUsers\([\s\S]*?last\)/);
});

test("leave page uses the optimized users mode while retaining its other month requests", () => {
  assert.match(page, /\/api\/attendance\/users\?mode=leave_month&month=\$\{month\}/);
  assert.doesNotMatch(page, /\/api\/attendance\/users\?mode=month&month=\$\{month\}/);
  assert.match(page, /\/api\/attendance\/records\?scope=leave_month&month=\$\{month\}/);
  assert.match(page, /\/api\/attendance\/holidays\?month=\$\{month\}/);
  assert.match(page, /useMonthlyAttendanceSummary\(formatDateKey\(calendarDate\)\.slice\(0, 7\)\)/);
});

test("users loading ignores stale month results, errors, and completion", () => {
  const loadUsers = page.slice(
    page.indexOf("const loadUsers = useCallback"),
    page.indexOf("const loadLeaveRecords = useCallback"),
  );

  assert.match(page, /const usersRequestSequenceRef = useRef\(0\);/);
  assert.match(loadUsers, /const requestSequence = \+\+usersRequestSequenceRef\.current;/);
  assert.equal(
    (loadUsers.match(/requestSequence === usersRequestSequenceRef\.current/g) ?? []).length,
    3,
  );
  assert.match(loadUsers, /requestSequence === usersRequestSequenceRef\.current[\s\S]*?setUsers\(data\)/);
  assert.match(loadUsers, /requestSequence === usersRequestSequenceRef\.current[\s\S]*?setFeedback\(/);
  assert.match(loadUsers, /finally[\s\S]*?requestSequence === usersRequestSequenceRef\.current[\s\S]*?setIsLoadingUsers\(false\)/);
});
