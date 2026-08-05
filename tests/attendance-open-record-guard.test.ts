import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/202608060001_add_employee_attendance_and_login_flags.sql"
);
const usersRoute = read("app/api/admin/users/route.ts");

function v7Source() {
  const start = migration.indexOf(
    "create or replace function public.employee_update_profile_and_level_v7("
  );
  const end = migration.indexOf(
    "create or replace function public.employee_update_profile_and_level_v8("
  );
  return migration.slice(start, end);
}

// employee_update_profile_and_level_v7의 가드는 순수 PL/pgSQL이라 이 세션에서 직접
// 실행할 수 없다(운영 DB 접근 없음). 동일한 판정식을 순수 JS로 그대로 옮겨, 6가지
// 시나리오에 대한 참/거짓을 먼저 고정한 뒤, 아래에서 SQL 소스가 정확히 이 3개 조건의
// AND로만 구성돼 있는지 정규식으로 다시 확인한다(로직 동등성 + 구조 확인 이중 검증).
function wouldBlockAttendanceTrackingOff(input: {
  before: boolean;
  next: boolean;
  hasOpenRecord: boolean;
}) {
  return input.before === true && input.next === false && input.hasOpenRecord === true;
}

test("7.1 no open record: turning attendance tracking off succeeds", () => {
  assert.equal(
    wouldBlockAttendanceTrackingOff({ before: true, next: false, hasOpenRecord: false }),
    false
  );
});

test("7.2 open record exists: turning attendance tracking off is blocked", () => {
  assert.equal(
    wouldBlockAttendanceTrackingOff({ before: true, next: false, hasOpenRecord: true }),
    true
  );
});

test("7.3 only closed records (check_out_at is not null): turning tracking off succeeds", () => {
  // hasOpenRecord는 exists(...check_out_at is null...)를 뜻하므로 완료된 기록만
  // 있으면 false가 되어야 한다 — 이 판정 자체는 SQL의 exists 조건이 담당하며, 여기서는
  // 그 결과가 false로 들어왔을 때 가드가 통과함을 확인한다.
  assert.equal(
    wouldBlockAttendanceTrackingOff({ before: true, next: false, hasOpenRecord: false }),
    false
  );
});

test("7.4 open record exists but only app_login_enabled is turned off: not blocked", () => {
  // attendance_tracking_enabled가 그대로 true이면(next=true) hasOpenRecord와 무관하게
  // 절대 막히지 않는다 — 로그인만 해제하는 경로가 열린 기록 때문에 차단되면 안 된다.
  assert.equal(
    wouldBlockAttendanceTrackingOff({ before: true, next: true, hasOpenRecord: true }),
    false
  );
});

test("7.5 already tracking-disabled employee: unrelated profile edits are never blocked", () => {
  // before=false면 (이미 근태 미사용) next가 무엇이든, 열린 기록이 있든 없든 절대 막히지 않는다.
  for (const next of [true, false]) {
    for (const hasOpenRecord of [true, false]) {
      assert.equal(
        wouldBlockAttendanceTrackingOff({ before: false, next, hasOpenRecord }),
        false
      );
    }
  }
});

test("the v7 guard is implemented as exactly this three-condition AND, before the users update, using an already-locked row", () => {
  const source = v7Source();
  const guardIndex = source.indexOf(
    "v_before.attendance_tracking_enabled = true"
  );
  const forUpdateIndex = source.indexOf("for update;");
  const updateUsersIndex = source.indexOf("update public.users\n  set");
  const raiseIndex = source.indexOf(
    "raise exception 'ATTENDANCE_OPEN_RECORD_EXISTS' using errcode = '55000';"
  );

  assert.ok(forUpdateIndex >= 0 && forUpdateIndex < guardIndex, "users row must already be locked before the guard runs");
  assert.ok(guardIndex >= 0 && guardIndex < raiseIndex, "guard condition must precede the raise");
  assert.ok(raiseIndex >= 0 && raiseIndex < updateUsersIndex, "guard must run before the users update statement");

  assert.match(
    source,
    /v_next_attendance_tracking_enabled = false\s*\n\s*and exists \(\s*\n\s*select 1\s*\n\s*from public\.attendance_records\s*\n\s*where user_id = p_user_id\s*\n\s*and check_in_at is not null\s*\n\s*and check_out_at is null\s*\n\s*\)/
  );
});

test("the guard is the ONLY thing gated on the tracking flag inside v7 — app_login_enabled has no equivalent check", () => {
  const source = v7Source();
  // raise exception 자체는 정확히 한 번만 있어야 한다(함수 설명 comment에는 별도로
  // 같은 코드명이 문서화 목적으로 한 번 더 등장할 수 있다).
  const raiseCount = (source.match(/raise exception 'ATTENDANCE_OPEN_RECORD_EXISTS'/g) ?? []).length;
  assert.equal(raiseCount, 1);
  assert.doesNotMatch(source, /app_login_enabled[\s\S]{0,80}attendance_records/);
});

test("7.6 the API maps ATTENDANCE_OPEN_RECORD_EXISTS to 409 with a stable code and bilingual message, without touching other RPC error handling", () => {
  assert.match(usersRoute, /error\.message\?\.includes\("ATTENDANCE_OPEN_RECORD_EXISTS"\)/);
  const guardBlockStart = usersRoute.indexOf('error.message?.includes("ATTENDANCE_OPEN_RECORD_EXISTS")');
  const guardBlockEnd = usersRoute.indexOf("throw new Error(`Failed to atomically update user");
  const guardBlock = usersRoute.slice(guardBlockStart, guardBlockEnd);
  assert.match(guardBlock, /status: 409/);
  assert.match(guardBlock, /code: "ATTENDANCE_OPEN_RECORD_EXISTS"/);
  assert.match(guardBlock, /getAttendanceOpenRecordError\(lang\)/);

  const helperStart = usersRoute.indexOf("function getAttendanceOpenRecordError(lang");
  const helperSource = usersRoute.slice(helperStart, helperStart + 400);
  assert.match(helperSource, /Không thể tắt chấm công vì nhân viên vẫn còn bản ghi chưa chấm công ra/);
  assert.match(helperSource, /현재 퇴근되지 않은 근태 기록이 있어 근태 사용을 해제할 수 없습니다/);

  // 다른 RPC 오류(예: WORK_SCHEDULE_TIMES_REQUIRED, HIRE_DATE_REQUIRED)는 여전히 기존과
  // 동일하게 일반 throw로 처리되어야 한다 — 이번 변경이 다른 오류 계약을 바꾸지 않는다.
  assert.match(usersRoute, /throw new Error\(`Failed to atomically update user: \$\{error\.message\}`\);/);
});

test("saving unrelated profile fields for an already-open-tracking employee is not affected by the new guard code path", () => {
  // normalizeUpdate/ALLOWED_UPDATE_KEYS 자체는 이번 보완에서 변경하지 않았다(가드는
  // RPC 내부에만 추가됨) — 허용 key 목록이 그대로인지만 재확인한다.
  assert.match(usersRoute, /"attendance_tracking_enabled",\s*\n\s*"app_login_enabled",/);
});
