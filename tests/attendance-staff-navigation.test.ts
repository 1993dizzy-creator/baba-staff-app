import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
// @ts-expect-error Direct Node TypeScript tests use explicit extensions.
import { shouldIncludeMonthlyEmployee } from "../lib/employment/eligibility.ts";
// @ts-expect-error Direct Node TypeScript tests use explicit extensions.
import { getAdjacentStaffId, getStaffDetailUrl, getStaffSwipeDirection, SWIPE_INTERACTIVE_SELECTOR } from "../lib/attendance/staff-navigation.ts";

const staff = readFileSync("app/(protected)/attendance/staff/page.tsx", "utf8");
const detail = readFileSync("app/(protected)/admin/payroll/attendance/[userId]/page.tsx", "utf8");

test("staff details use the employee and business month/date with existing translation", () => {
  assert.equal(getStaffDetailUrl(42, "2026-10", "2026-10-07"), "/admin/payroll/attendance/42?month=2026-10&date=2026-10-07");
  assert.ok(staff.includes("getStaffDetailUrl(user.id, businessDate.slice(0, 7), businessDate)"));
  assert.ok(staff.includes("{t.viewDetail}"));
  assert.ok(staff.includes("prefetch={false}"));
});

test("neighbors preserve month and optional selected date in both directions", () => {
  for (const direction of ["previous", "next"] as const) {
    const id = getAdjacentStaffId([11, 42, 99], 42, direction)!;
    assert.equal(id, direction === "previous" ? 11 : 99);
    assert.equal(getStaffDetailUrl(id, "2026-08", "2026-08-23"), '/admin/payroll/attendance/' + id + '?month=2026-08&date=2026-08-23');
    assert.equal(getStaffDetailUrl(id, "2026-08"), '/admin/payroll/attendance/' + id + '?month=2026-08');
  }
  assert.ok(detail.includes("getStaffDetailUrl(targetId, getMonthRange(currentMonth).startText.slice(0, 7), selectedDate)"));
});

test("boundaries, empty lists and absent historical employees never wrap", () => {
  assert.equal(getAdjacentStaffId([11, 42, 99], 11, "previous"), null);
  assert.equal(getAdjacentStaffId([11, 42, 99], 99, "next"), null);
  assert.equal(getAdjacentStaffId([], 42, "next"), null);
  assert.equal(getAdjacentStaffId([11], 42, "previous"), null);
  assert.ok(detail.includes("disabled={previousId === null || isLoading || isSaving}"));
  assert.ok(detail.includes("disabled={nextId === null || isLoading || isSaving}"));
});

test("swipe requires 64px and clearly horizontal movement", () => {
  assert.equal(getStaffSwipeDirection(-100, 15, false), "next");
  assert.equal(getStaffSwipeDirection(100, -15, false), "previous");
  for (const [dx, dy] of [[10, 0], [-63, 0], [0, 100], [70, 90], [-90, 60]]) {
    assert.equal(getStaffSwipeDirection(dx, dy, false), null);
  }
  assert.equal(getStaffSwipeDirection(-64, 0, false), "next");
});

test("interactive origins, multi-touch and cancelled gestures are excluded", () => {
  assert.equal(getStaffSwipeDirection(-150, 0, true), null);
  assert.equal(getStaffSwipeDirection(150, 0, true), null);
  for (const element of ["button", "input", "textarea", "select", "a", "label"]) assert.ok(SWIPE_INTERACTIVE_SELECTOR.includes(element));
  assert.ok(detail.includes("event.target as Element).closest(SWIPE_INTERACTIVE_SELECTOR)"));
  assert.ok(detail.includes("event.touches.length !== 1"));
  assert.ok(detail.includes("onTouchCancel={() => { swipeRef.current = null; }}"));
  assert.ok(!detail.includes("preventDefault("));
});

test("both screens share existing staff ordering and only current employee records are fetched", () => {
  assert.ok(staff.includes("groupUsers.sort(compareAttendanceStaff)"));
  assert.ok(detail.includes("filter((employee) => !isAdmin(employee)).sort(compareAttendanceStaff)"));
  assert.ok(detail.includes("attendanceFetch(`/api/attendance/users?mode=month&month=${navigationMonth}`)"));
  assert.ok(detail.includes("records?scope=admin_user_month&user_id="));
  assert.doesNotMatch(detail, /scope=admin_month/);
});

// Load the actual comparator with Node-resolvable paths without changing app imports.
test("staff ordering preserves part groups, role rank and locale name order", async () => {
  const source = ts.transpileModule(readFileSync("lib/attendance/staff-sort.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
    .replace("@/lib/common/parts", pathToFileURL(process.cwd() + "/lib/common/parts.ts").href)
    .replace("@/lib/common/roles", pathToFileURL(process.cwd() + "/lib/common/roles.ts").href);
  const { compareAttendanceStaff } = await import("data:text/javascript," + encodeURIComponent(source));
  const employees = [
    { id: 1, part: "bar", role: "manager", name: "A" },
    { id: 2, part: "kitchen", role: "staff", name: "Z" },
    { id: 3, part: "kitchen", role: "leader", name: "B" },
    { id: 4, part: "kitchen", role: "leader", name: "A" },
    { id: 5, part: "hall", role: "manager", name: "A" },
    { id: 6, part: "cleaning", role: "staff", name: "A" },
    { id: 7, part: null, role: "manager", name: "A" },
    { id: 8, part: "unknown", role: "staff", name: "A" },
  ];
  assert.deepEqual(employees.sort(compareAttendanceStaff).map(employee => employee.id), [4, 3, 2, 5, 1, 6, 7, 8]);
  const a = { part: "hall", role: "staff", name: "Anh" };
  const b = { ...a, name: "Ánh" };
  assert.equal(compareAttendanceStaff(a, b), a.name.localeCompare(b.name));
});

// Execute the page's own effect and navigation handler with read-only mock APIs.
const navigationEffectSource = ts.transpileModule(
  detail.slice(detail.indexOf("    useEffect(() => {"), detail.indexOf("    const previousId")),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const runNavigationEffect = new Function("context",
  "const { useEffect, isAdmin, getUser, attendanceFetch, setStaffNavigation, navigationMonth, compareAttendanceStaff } = context;" + navigationEffectSource);

type NavigationEmployee = { id: number; role: string; is_active: boolean; hire_date: string; termination_date: string | null; attendance_tracking_enabled: boolean };
type NavigationState = { month: string; ids: number[] };

test("navigation reloads for the selected month and ignores an older month's response", async () => {
  const requests: string[] = [];
  const dependencies: string[][] = [];
  const pending = new Map<string, (value: { ok: boolean; json: () => Promise<{ ok: boolean; users: NavigationEmployee[] }> }) => void>();
  let navigation: NavigationState = { month: "", ids: [] };
  const loadMonth = (month: string) => {
    let cleanup = () => {};
    runNavigationEffect({
      navigationMonth: month,
      useEffect: (effect: () => () => void, deps: string[]) => { dependencies.push(deps); cleanup = effect(); },
      isAdmin: () => true,
      getUser: () => ({ role: "owner" }),
      attendanceFetch: (url: string) => { requests.push(url); return new Promise(resolve => { pending.set(month, resolve); }); },
      setStaffNavigation: (value: NavigationState) => { navigation = value; },
      compareAttendanceStaff: () => 0,
    });
    return cleanup;
  };
  const cancelSeptember = loadMonth("2026-09");
  cancelSeptember();
  loadMonth("2026-10");
  pending.get("2026-10")!({ ok: true, json: async () => ({ ok: true, users: [] }) });
  await setImmediate();
  pending.get("2026-09")!({ ok: true, json: async () => ({ ok: true, users: [] }) });
  await setImmediate();
  assert.deepEqual(requests, ["/api/attendance/users?mode=month&month=2026-09", "/api/attendance/users?mode=month&month=2026-10"]);
  assert.deepEqual(dependencies, [["2026-09"], ["2026-10"]]);
  assert.equal(navigation.month, "2026-10");
  assert.ok(detail.includes("staffNavigation.month === navigationMonth ? staffNavigation.ids : []"));
});

test("monthly eligible inactive and terminated staff remain navigable, while admins are excluded", async () => {
  const former: NavigationEmployee = { id: 11, role: "staff", is_active: false, hire_date: "2025-01-01", termination_date: "2026-09-20", attendance_tracking_enabled: true };
  const disabled = { ...former, id: 12, attendance_tracking_enabled: false };
  assert.equal(shouldIncludeMonthlyEmployee(former, "2026-09", false), true);
  assert.equal(shouldIncludeMonthlyEmployee(disabled, "2026-09", true), true);
  const users = [former, disabled, { ...former, id: 1, role: "owner" }];
  let navigation: NavigationState = { month: "", ids: [] };
  runNavigationEffect({
    navigationMonth: "2026-09",
    useEffect: (effect: () => () => void) => effect(),
    isAdmin: (employee: { role: string }) => ["owner", "master"].includes(employee.role),
    getUser: () => ({ role: "owner" }),
    attendanceFetch: async () => ({ ok: true, json: async () => ({ ok: true, users }) }),
    setStaffNavigation: (value: NavigationState) => { navigation = value; },
    compareAttendanceStaff: (a: NavigationEmployee, b: NavigationEmployee) => a.id - b.id,
  });
  await setImmediate();
  assert.deepEqual(navigation, { month: "2026-09", ids: [11, 12] });
  assert.equal(getAdjacentStaffId(navigation.ids, 11, "next"), 12);
});

test("date-less entry uses the currently selected date for both buttons and swipe directions", async () => {
  const source = ts.transpileModule(detail.slice(detail.indexOf("    const navigateStaff = async"), detail.indexOf("    useEffect(() => {", detail.indexOf("    const navigateStaff = async"))), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const createNavigate = new Function("context", "const { staffIds, userId, isLoading, isSaving, navigatingRef, slideDirectionRef, pageRef, window, setMessage, router, getStaffDetailUrl, getAdjacentStaffId, getMonthRange, currentMonth, selectedDate } = context;" + source + "; return navigateStaff;");
  const initialUrl = new URL("https://example.test/admin/payroll/attendance/10?month=2026-09");
  assert.equal(initialUrl.searchParams.has("date"), false);
  const selectedDate = "2026-09-15";
  for (const direction of ["previous", "next", getStaffSwipeDirection(100, 0, false), getStaffSwipeDirection(-100, 0, false)]) {
    const urls: string[] = [];
    const navigate = createNavigate({
      staffIds: [9, 10, 11], userId: 10, isLoading: false, isSaving: false,
      navigatingRef: { current: false }, slideDirectionRef: { current: 1 }, pageRef: { current: null },
      window: { matchMedia: () => ({ matches: true }) }, setMessage: () => {},
      router: { push: (url: string) => { urls.push(url); } }, getStaffDetailUrl, getAdjacentStaffId,
      getMonthRange: () => ({ startText: "2026-09-01" }), currentMonth: new Date(2026, 8, 1), selectedDate,
    });
    await navigate(direction);
    assert.deepEqual(urls, ["/admin/payroll/attendance/" + (direction === "previous" ? 9 : 11) + "?month=2026-09&date=2026-09-15"]);
  }
  assert.ok(detail.includes('onClick={() => void navigateStaff("previous")}'));
  assert.ok(detail.includes('onClick={() => void navigateStaff("next")}'));
  assert.ok(detail.includes("if (direction) void navigateStaff(direction)"));
  assert.ok(!detail.includes('searchParams.has("date")'));
});
