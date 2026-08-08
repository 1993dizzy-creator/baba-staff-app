import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/attendance/holidays/route.ts");

// ---------------------------------------------------------------------------
// /api/attendance/holidays — /attendance/leave 월간 캘린더 전용 읽기 endpoint.
// owner 권한 API(/api/admin/store-settings/holidays)를 쓰지 않고, 다른 근태 화면과
// 동일한 최신 세션 인증(requireAttendanceActor)만 재사용한다. mutation 없음.
// ---------------------------------------------------------------------------

test("uses the current session-based attendance auth (requireAttendanceActor), not the owner-only store-settings actor and not a legacy header-trust pattern", () => {
  assert.match(route, /import \{[\s\S]*requireAttendanceActor[\s\S]*\} from "@\/lib\/attendance\/server-api";/);
  assert.match(route, /await requireAttendanceActor\(\)/);
  assert.doesNotMatch(route, /getStoreSettingsActor/);
  assert.doesNotMatch(route, /x-baba-actor-id/i);
});

test("any logged-in normal user (owner/master/manager/leader/staff) can read — requireAttendanceActor covers all attendance roles, not just admins", () => {
  assert.match(route, /if \(!auth\.ok\) return attendanceAuthFailure\(auth\);/);
});

test("validates month as strict YYYY-MM before querying, matching the existing attendance month-param pattern", () => {
  assert.match(route, /\/\^\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$\//);
  assert.match(route, /INVALID_MONTH/);
});

test("delegates to the shared loadHolidaysForMonth helper — no duplicated query logic between admin and attendance routes", () => {
  assert.match(route, /import \{ loadHolidaysForMonth \} from "@\/lib\/store-settings\/holidays-server";/);
  assert.match(route, /await loadHolidaysForMonth\(month\)/);
});

test("this route only exports GET — no POST/PUT mutation entry point exists here", () => {
  assert.match(route, /export async function GET\(/);
  assert.doesNotMatch(route, /export async function (POST|PUT|DELETE|PATCH)\(/);
});

test("no DB write call (insert/update/delete/upsert/rpc) anywhere in this route", () => {
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
});

test("uses attendanceJson (no-store cache header), same response convention as other attendance routes", () => {
  assert.match(route, /attendanceJson\(\{ ok: true, month, holidays \}, 200\)/);
});
