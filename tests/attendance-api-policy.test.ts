import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const policyModulePath = "../lib/attendance/api-policy.ts";
const {
  ATTENDANCE_RECORD_PROJECTIONS,
  getAttendanceMonthRange,
  resolveAttendanceRecordsPolicy,
  validateAttendanceActorTarget,
} = await import(policyModulePath);

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function resolve(query: string, actorId = 7, actorRole = "staff") {
  return resolveAttendanceRecordsPolicy({
    searchParams: new URLSearchParams(query),
    actorId,
    actorRole,
  });
}

test("month input produces an exact bounded calendar month", () => {
  assert.deepEqual(getAttendanceMonthRange("2026-02"), {
    startDate: "2026-02-01",
    endDate: "2026-02-28",
  });
  assert.deepEqual(getAttendanceMonthRange("2028-02"), {
    startDate: "2028-02-01",
    endDate: "2028-02-29",
  });
  assert.equal(getAttendanceMonthRange("2026-13"), null);
  assert.equal(getAttendanceMonthRange("2026-07-01"), null);
});

test("self scopes force the signed actor and reject another user", () => {
  assert.deepEqual(resolve("scope=self_day&work_date=2026-07-22"), {
    ok: true,
    scope: "self_day",
    projection: ATTENDANCE_RECORD_PROJECTIONS.self_day,
    userId: 7,
    workDate: "2026-07-22",
  });
  assert.equal(
    resolve("scope=self_month&month=2026-07&user_id=8").status,
    403
  );
  assert.equal(resolve("scope=self_month&month=2026-07").userId, 7);
});

test("general roles keep staff and leave reads but cannot use admin scopes", () => {
  assert.equal(resolve("scope=staff_today&work_date=2026-07-22").ok, true);
  const leave = resolve("scope=leave_month&month=2026-07");
  assert.equal(leave.ok, true);
  assert.equal(leave.status, "leave");
  assert.equal(resolve("scope=admin_overview&month=2026-07").status, 403);
  assert.equal(
    resolve("scope=admin_user_month&month=2026-07&user_id=8").status,
    403
  );
});

test("owner and master can use bounded admin scopes", () => {
  for (const role of ["owner", "master"]) {
    assert.equal(resolve("scope=admin_overview&month=2026-07", 1, role).ok, true);
    const detail = resolve(
      "scope=admin_user_month&month=2026-07&user_id=8",
      1,
      role
    );
    assert.equal(detail.ok, true);
    assert.equal(detail.userId, 8);
  }
});

test("legacy, duplicate, malformed, and unbounded queries are rejected", () => {
  for (const query of [
    "work_date=2026-07-22",
    "scope=unknown",
    "scope=self_day&work_date=2026-02-30",
    "scope=self_month&month=2026-07&start_date=2026-01-01",
    "scope=staff_today&work_date=2026-07-22&work_date=2026-07-23",
    "scope=admin_user_month&month=2026-07&user_id=nope",
  ]) {
    assert.equal(resolve(query, 1, "owner").status, 400, query);
  }
});

test("record projections exclude location and check-log fields", () => {
  for (const projection of Object.values(ATTENDANCE_RECORD_PROJECTIONS) as string[]) {
    assert.doesNotMatch(
      projection,
      /latitude|longitude|distance|location_valid|failure_reason/
    );
  }
  assert.match(ATTENDANCE_RECORD_PROJECTIONS.leave_month, /note/);
  assert.match(ATTENDANCE_RECORD_PROJECTIONS.admin_user_month, /updated_at/);
});

test("check-in and check-out targets are always the signed actor", () => {
  assert.deepEqual(validateAttendanceActorTarget(7, undefined), {
    ok: true,
    userId: 7,
  });
  assert.equal(validateAttendanceActorTarget(7, 7).ok, true);
  assert.equal(validateAttendanceActorTarget(7, "7").ok, true);
  assert.deepEqual(validateAttendanceActorTarget(7, 8), {
    ok: false,
    status: 403,
    code: "FORBIDDEN",
  });
  assert.equal(validateAttendanceActorTarget(7, "owner").ok, false);
});

test("routes use the server actor and check logs never use request identity", () => {
  const users = read("app/api/attendance/users/route.ts");
  const records = read("app/api/attendance/records/route.ts");
  const checkIn = read("app/api/attendance/check-in/route.ts");
  const checkOut = read("app/api/attendance/check-out/route.ts");

  for (const route of [users, records, checkIn, checkOut]) {
    assert.match(route, /requireAttendanceActor\(\)/);
  }
  assert.match(users, /attendanceJson/);
  assert.match(records, /attendanceJson/);
  assert.doesNotMatch(users, /password|gender|hire_date|full_name/);
  assert.match(users, /birth_date/);
  assert.match(records, /resolveAttendanceRecordsPolicy/);
  assert.doesNotMatch(records, /select\("\*"\)/);
  for (const route of [checkIn, checkOut]) {
    assert.match(route, /validateAttendanceActorTarget\(auth\.actor\.id, user_id\)/);
    assert.match(route, /user_name: auth\.actor\.name/);
    assert.match(route, /username: auth\.actor\.username/);
    assert.doesNotMatch(route, /user_name,\s*username/);
  }
});

test("all attendance screens use scoped reads and the common 401 fetch", () => {
  const main = read("app/(protected)/attendance/page.tsx");
  const staff = read("app/(protected)/attendance/staff/page.tsx");
  const leave = read("app/(protected)/attendance/leave/page.tsx");
  const overview = read("app/(protected)/attendance/overview/page.tsx");
  const detail = read("app/(protected)/attendance/overview/[userId]/page.tsx");
  const combined = [main, staff, leave, overview, detail].join("\n");

  for (const scope of [
    "self_day",
    "self_month",
    "staff_today",
    "leave_month",
    "admin_user_month",
    "admin_overview",
  ]) {
    assert.match(combined, new RegExp(`scope=${scope}`));
  }
  assert.doesNotMatch(combined, /records\?user_id=|start_date=|end_date=|status=leave/);
  assert.doesNotMatch(main, /user_name: user|username: user|user_id: user\.id/);
  assert.match(combined, /attendanceFetch/);
});
