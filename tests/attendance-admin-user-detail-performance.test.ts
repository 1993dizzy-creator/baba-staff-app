import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { shouldIncludeMonthlyEmployee } from "../lib/employment/eligibility.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/users/route.ts");
const page = read("app/(protected)/admin/payroll/attendance/[userId]/page.tsx");

test("admin user month is admin-only and validates its bounded target", () => {
  assert.match(route, /requestedMode === "admin_user_month"/);
  assert.match(route, /mode === "admin_user_month"[\s\S]*?!isAttendanceAdminRole\(auth\.actor\.role\)[\s\S]*?"FORBIDDEN"[\s\S]*?403/);
  assert.match(route, /parsePositiveUserId\(search\.get\("user_id"\)\)[\s\S]*?"INVALID_USER_ID"[\s\S]*?400/);
  assert.match(route, /mode !== "current"[\s\S]*?"INVALID_MONTH"[\s\S]*?400/);
});

test("admin user month queries only the target user and one attendance id in parallel", () => {
  const branch = route.slice(
    route.indexOf('if (mode === "admin_user_month")'),
    route.indexOf("const usersQuery =", route.indexOf('if (mode === "admin_user_month")')),
  );
  assert.match(branch, /await Promise\.all\(\[/);
  assert.match(branch, /\.from\("users"\)[\s\S]*?\.eq\("id", targetUserId\)[\s\S]*?\.eq\("is_system_account", false\)[\s\S]*?\.maybeSingle\(\)/);
  assert.match(branch, /\.from\("attendance_records"\)[\s\S]*?\.select\("id"\)[\s\S]*?\.eq\("user_id", targetUserId\)[\s\S]*?\.gte\("work_date", first\)[\s\S]*?\.lte\("work_date", last\)[\s\S]*?\.limit\(1\)/);
  assert.doesNotMatch(branch, /\.order\("part"|\.order\("position"|\.order\("name"/);
});

test("admin user month preserves monthly inclusion, month-end level, and privacy serialization", () => {
  assert.match(route, /const included = shouldIncludeMonthlyEmployee\([\s\S]*?target,[\s\S]*?month!,[\s\S]*?attendanceResult\.data/);
  assert.match(route, /serializeUsers\(\[target\], last\)/);
  assert.match(route, /const \{ birth_date: _privateBirthDate, \.\.\.publicUser \} = user/);
  assert.match(route, /return attendanceJson\(\{ ok: true, user: serialized\[0\] \?\? null \}\)/);

  const historicalRecord = { hire_date: "2025-01-01", termination_date: "2025-12-31", is_system_account: false, attendance_tracking_enabled: false };
  const trackedInMonth = { hire_date: "2026-08-01", termination_date: null, is_system_account: false, attendance_tracking_enabled: true };
  const excluded = { ...historicalRecord, termination_date: "2026-07-31" };
  assert.equal(shouldIncludeMonthlyEmployee(historicalRecord, "2026-08", true), true);
  assert.equal(shouldIncludeMonthlyEmployee(trackedInMonth, "2026-08", false), true);
  assert.equal(shouldIncludeMonthlyEmployee(excluded, "2026-08", false), false);
  assert.equal(shouldIncludeMonthlyEmployee({ ...trackedInMonth, is_system_account: true }, "2026-08", true), false);
});

test("detail page requests the singular target and no longer searches a monthly users array", () => {
  assert.match(page, /users\?mode=admin_user_month&month=\$\{month\}&user_id=\$\{encodeURIComponent\(String\(userId\)\)\}/);
  assert.match(page, /const userData = userResult\.user as UserRow \| null/);
  assert.doesNotMatch(page, /userResult\.users|\.find\([\s\S]*?Number\(item\.id\) === Number\(userId\)/);
});

test("successful payroll settings are component-local while failures remain retryable", () => {
  assert.match(page, /const payrollSettingsResultRef = useRef<Record<string, unknown> \| null>\(null\)/);
  assert.match(page, /const payrollSettingsRequestRef = useRef<Promise<Record<string, unknown> \| null> \| null>\(null\)/);
  assert.match(page, /payrollSettingsResultRef\.current[\s\S]*?Promise\.resolve\(payrollSettingsResultRef\.current\)/);
  assert.match(page, /if \(!response\.ok \|\| !result\.ok\) return null/);
  assert.match(page, /payrollSettingsResultRef\.current = result/);
  assert.match(page, /finally\([\s\S]*?payrollSettingsRequestRef\.current = null/);
  assert.doesNotMatch(page, /^const payrollSettings/m);
});

test("detail request sequence blocks stale state and loading completion", () => {
  const fetchDetail = page.slice(
    page.indexOf("const fetchDetail = async"),
    page.indexOf("const selectedRecord = useMemo"),
  );
  assert.match(page, /const detailRequestSequenceRef = useRef\(0\)/);
  assert.match(fetchDetail, /const requestSequence = \+\+detailRequestSequenceRef\.current/);
  assert.match(fetchDetail, /if \(requestSequence !== detailRequestSequenceRef\.current\) return/);
  assert.ok(fetchDetail.indexOf("if (requestSequence !== detailRequestSequenceRef.current) return") < fetchDetail.indexOf("setUser(userData || null)"));
  assert.ok(fetchDetail.indexOf("setUser(userData || null)") < fetchDetail.indexOf("setRecords(recordData || [])"));
  assert.match(fetchDetail, /finally[\s\S]*?requestSequence === detailRequestSequenceRef\.current[\s\S]*?setIsLoading\(false\)/);
});
