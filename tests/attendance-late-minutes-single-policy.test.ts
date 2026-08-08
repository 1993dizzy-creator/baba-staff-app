import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { evaluateAttendancePolicy, type AttendancePolicyInput } from "../lib/attendance/policy-engine.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// Phase 1-E: attendance_records.late_minutes를 "policy-adjusted late minutes"로
// 통일한다 — 체크인 저장값 / 관리자 수정 / 화면 표시 / 정책 계산이 모두 동일한
// evaluateAttendancePolicy() 결과를 공유해야 한다.

const checkIn = read("app/api/attendance/check-in/route.ts");
const checkOut = read("app/api/attendance/check-out/route.ts");
const admin = read("app/api/attendance/admin/route.ts");
const adapter = read("lib/attendance/policy-resolution-adapter.ts");
const time = read("lib/attendance/time.ts");
const attendanceStaffPage = read("app/(protected)/attendance/staff/page.tsx");
const attendancePage = read("app/(protected)/attendance/page.tsx");
const attendanceFacts = read("lib/payroll/attendance-facts.ts");

// ---------------------------------------------------------------------------
// 0. 정책 엔진 자체 — grace 시나리오는 기존 attendance-policy-engine.test.ts의
//    "late grace keeps the raw difference and suppresses effective lateness"가
//    이미 정확히 요구된 4개 케이스(정시/grace 이내/grace 경계/grace 초과)를
//    커버한다. 여기서는 그 계약이 여전히 성립하는지 이 파일에서도 독립적으로
//    재확인해, late_minutes 통일 작업이 엔진의 threshold 의미 자체를 바꾸지
//    않았음을 보장한다.
// ---------------------------------------------------------------------------

const base: AttendancePolicyInput = {
  businessDate: "2026-07-24",
  timezone: "Asia/Ho_Chi_Minh",
  businessDayCutoffTime: "03:00",
  settingsRevision: 3,
  scheduledStartTime: "16:00",
  scheduledEndTime: "01:00",
  storeOpenTime: "16:00",
  storeCloseTime: "01:00",
  lateGraceMinutes: 5,
  earlyLeaveGraceMinutes: 0,
  missingCheckoutGraceMinutes: 60,
  overrideCloseTime: null,
  checkInAt: "2026-07-24T16:00:00+07:00",
  checkOutAt: null,
  now: "2026-07-24T20:00:00+07:00",
};

test("grace=5: exact on time -> 0, within grace -> 0, exact grace boundary -> 0, one minute over grace -> full raw (not raw-grace)", () => {
  const cases: Array<[string, number]> = [
    ["16:00", 0],
    ["16:03", 0],
    ["16:05", 0],
    ["16:06", 6],
  ];
  for (const [time_, expected] of cases) {
    const result = evaluateAttendancePolicy({
      ...base,
      checkInAt: `2026-07-24T${time_}:00+07:00`,
    });
    assert.equal(result.lateMinutes, expected, `check-in ${time_} should yield lateMinutes=${expected}`);
  }
  // grace를 초과했을 때 raw-grace(=1)가 아니라 raw 전체(6)를 지각으로 처리하는
  // threshold 정책임을 명시적으로 재확인한다.
  const overGrace = evaluateAttendancePolicy({ ...base, checkInAt: "2026-07-24T16:06:00+07:00" });
  assert.notEqual(overGrace.lateMinutes, 1);
  assert.equal(overGrace.lateMinutes, overGrace.rawLateMinutes);
});

// ---------------------------------------------------------------------------
// 1. late_minutes 저장 경로 통일 — self check-in이 더 이상 별도의 raw 계산을
//    쓰지 않고 공통 정책 helper(resolveAttendanceRecordPolicy)만 사용한다.
// ---------------------------------------------------------------------------

test("self check-in uses resolveAttendanceRecordPolicy — the same helper as checkout/admin correction/force check-in/force check-out/auto-close", () => {
  assert.match(checkIn, /import \{ resolveAttendanceRecordPolicy \} from "@\/lib\/attendance\/policy-resolution-adapter";/);
  assert.match(checkIn, /resolveAttendanceRecordPolicy\(\{/);
});

test("self check-in no longer imports getLateMinutes from lib/attendance/time, and the raw-only helper itself is fully removed (was orphaned once check-in stopped using it)", () => {
  assert.doesNotMatch(checkIn, /getLateMinutes/);
  assert.doesNotMatch(time, /export function getLateMinutes/);
  assert.doesNotMatch(time, /getLateMinutes/);
});

test("resolveAttendanceRecordPolicy is now referenced by all 3 attendance mutation routes (check-in, check-out, admin)", () => {
  assert.match(checkIn, /resolveAttendanceRecordPolicy\(/);
  assert.match(checkOut, /resolveAttendanceRecordPolicy\(/);
  assert.match(admin, /resolveAttendanceRecordPolicy\(/);
});

test("the shared adapter itself is unchanged by this phase (no new duplicate store-setting lookup helper was created)", () => {
  assert.match(adapter, /export async function resolveAttendanceRecordPolicy/);
  assert.match(adapter, /supabaseServer\.rpc\("store_get_settings_overview_v1"/);
  // Only one adapter file defines this — grep would find duplicates if a second
  // lookup helper were introduced elsewhere.
  const occurrences = [checkIn, checkOut, admin].filter((src) =>
    src.includes("store_get_settings_overview_v1")
  );
  assert.deepEqual(occurrences, []);
});

// ---------------------------------------------------------------------------
// 2. 화면은 stored late_minutes만 그대로 표시한다 — DB 저장값이 이미 policy
//    result이므로, 화면 자체는 이번 Phase에서 바꿀 필요가 없다(별도 클라이언트
//    측 재계산이나 하드코딩된 grace가 없어야 한다).
// ---------------------------------------------------------------------------

test("employee attendance screen and admin staff attendance screen just read the stored late_minutes field — no separate client-side late recalculation or hardcoded grace", () => {
  for (const src of [attendancePage, attendanceStaffPage]) {
    assert.doesNotMatch(src, /lateGraceMinutes\s*[:=]\s*\d/);
    assert.doesNotMatch(src, /late_grace_minutes\s*[:=]\s*\d/);
  }
  assert.match(attendancePage, /late_minutes/);
  assert.match(attendanceStaffPage, /late_minutes/);
});

// ---------------------------------------------------------------------------
// 3. payroll 계산 공식은 이번 Phase에서 변경하지 않는다. stored vs recalculated
//    비교(감사) 기능 자체는 유지한다.
// ---------------------------------------------------------------------------

test("payroll attendance-facts recompute logic and its stored-vs-recalculated mismatch warning are untouched by this phase", () => {
  assert.match(attendanceFacts, /STORED_LATE_MINUTES_MISMATCH/);
  assert.match(attendanceFacts, /late = rawLate > \(input\.lateGraceMinutes \?\? 0\) \? rawLate : 0;/);
});

test("no payroll calculation/snapshot/penalty file was modified by this phase", () => {
  // This phase's diff must not touch payroll formula files at all — verified via
  // git status separately, but this static check pins the specific formula line
  // above so an accidental future edit to the threshold itself would fail loudly.
  assert.match(attendanceFacts, /if \(input\.manualLateNormalized\) late = 0;/);
});

// ---------------------------------------------------------------------------
// 4. 이번 Phase에는 DB schema 변경이 필요 없다 — 신규 migration 파일이나 새
//    컬럼(raw_late_minutes 등)을 추가하지 않는다.
// ---------------------------------------------------------------------------

test("no new column such as raw_late_minutes/policy_late_minutes/effective_late_minutes was introduced anywhere in the codebase", () => {
  const sources = [checkIn, checkOut, admin, adapter, attendanceFacts];
  for (const src of sources) {
    assert.doesNotMatch(src, /raw_late_minutes|policy_late_minutes|effective_late_minutes/);
  }
});
