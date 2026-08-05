import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/202608060001_add_employee_attendance_and_login_flags.sql"
);

function triggerFunctionSource() {
  const start = migration.indexOf(
    "create or replace function public.attendance_records_block_new_check_in_when_tracking_disabled()"
  );
  const end = migration.indexOf("create trigger attendance_records_block_new_check_in");
  return migration.slice(start, end);
}

function v7Source() {
  const start = migration.indexOf(
    "create or replace function public.employee_update_profile_and_level_v7("
  );
  const end = migration.indexOf(
    "create or replace function public.employee_update_profile_and_level_v8("
  );
  return migration.slice(start, end);
}

// trigger 본문은 순수 PL/pgSQL이라 이 세션에서 직접 실행할 수 없다(운영 DB 접근 없음).
// 실제 분기(이제 두 개의 이른 반환 + 그 아래 중첩된 tg_op/old 분기)를 순수 JS로 그대로
// 옮겨 진리표를 먼저 고정한 뒤, 아래에서 SQL 소스가 정확히 이 구조로 작성됐는지
// 정규식으로 다시 확인한다.
function evaluateTrigger(input: {
  tgOp: "INSERT" | "UPDATE";
  newCheckInAt: string | null;
  oldCheckInAt: string | null;
}): "return_new_no_check_in" | "return_new_already_open" | "checks_tracking_flag" {
  // 1) 휴무·빈 기록처럼 check_in_at이 없는 행은 신규 출근이 아니다.
  if (input.newCheckInAt === null) return "return_new_no_check_in";
  // 2) tg_op = 'UPDATE'를 먼저 별도로 검사하고, 그 안에서만 old를 본다.
  if (input.tgOp === "UPDATE") {
    if (input.oldCheckInAt !== null) return "return_new_already_open";
  }
  // 3) 여기까지 왔으면 신규 출근이다 — users 행을 조회/검사한다.
  return "checks_tracking_flag";
}

test("1. new.check_in_at is null -> immediate return new (leave/blank records, both INSERT and UPDATE)", () => {
  assert.equal(
    evaluateTrigger({ tgOp: "INSERT", newCheckInAt: null, oldCheckInAt: null }),
    "return_new_no_check_in"
  );
  assert.equal(
    evaluateTrigger({ tgOp: "UPDATE", newCheckInAt: null, oldCheckInAt: null }),
    "return_new_no_check_in"
  );
});

test("1. the SQL body has an early return for new.check_in_at is null, before any tg_op/OLD check", () => {
  const source = triggerFunctionSource();
  const guardIndex = source.search(/if new\.check_in_at is null then\s*\n\s*return new;\s*\n\s*end if;/);
  const tgOpIndex = source.indexOf("if tg_op = 'UPDATE' then");
  assert.ok(guardIndex >= 0, "the check_in_at-is-null guard must exist");
  assert.ok(tgOpIndex > guardIndex, "the tg_op branch must come after the check_in_at-is-null guard");
});

test("2. tg_op = 'UPDATE' is checked as its own outer branch, separate from the OLD check", () => {
  const source = triggerFunctionSource();
  assert.match(source, /if tg_op = 'UPDATE' then\s*\n/);
  // 더 이상 tg_op와 old가 하나의 and 조건으로 묶여 있으면 안 된다(이전 버전의 평탄한 형태).
  assert.doesNotMatch(source, /tg_op = 'UPDATE' and old\.check_in_at/);
});

test("3. old.check_in_at is referenced only inside the tg_op = 'UPDATE' branch, nested one level deeper", () => {
  const source = triggerFunctionSource();
  assert.match(
    source,
    /if tg_op = 'UPDATE' then\s*\n\s*if old\.check_in_at is not null then\s*\n\s*return new;\s*\n\s*end if;\s*\n\s*end if;/
  );

  const outerStart = source.indexOf("if tg_op = 'UPDATE' then");
  const firstEndIf = source.indexOf("end if;", outerStart);
  const outerEnd = source.indexOf("end if;", firstEndIf + 1) + "end if;".length;
  const outerBlock = source.slice(outerStart, outerEnd);
  const oldMatchesInsideOuter = [...outerBlock.matchAll(/old\.\w+/g)];
  const oldMatchesTotal = [...source.matchAll(/old\.\w+/g)];
  assert.equal(oldMatchesTotal.length, 1, "old.check_in_at should be referenced exactly once in the whole function");
  assert.equal(oldMatchesInsideOuter.length, 1, "that one OLD reference must live inside the tg_op = 'UPDATE' branch");
});

test("4. the INSERT branch never contains an OLD reference (old only appears after the tg_op = 'UPDATE' guard)", () => {
  const source = triggerFunctionSource();
  const firstOldIndex = source.indexOf("old.");
  const tgOpBranchIndex = source.indexOf("if tg_op = 'UPDATE' then");
  assert.ok(tgOpBranchIndex >= 0 && firstOldIndex > tgOpBranchIndex);
});

test("5. UPDATE with check_in_at going null -> a value runs the tracking-flag check (users row FOR SHARE)", () => {
  assert.equal(
    evaluateTrigger({ tgOp: "UPDATE", newCheckInAt: "2026-08-10T09:00:00Z", oldCheckInAt: null }),
    "checks_tracking_flag"
  );
  assert.equal(
    evaluateTrigger({ tgOp: "INSERT", newCheckInAt: "2026-08-10T09:00:00Z", oldCheckInAt: null }),
    "checks_tracking_flag"
  );
  const source = triggerFunctionSource();
  assert.match(
    source,
    /select attendance_tracking_enabled\s*\n\s*into v_attendance_tracking_enabled\s*\n\s*from public\.users\s*\n\s*where id = new\.user_id\s*\n\s*for share;/
  );
});

test("6. an UPDATE where check_in_at already had a value passes through immediately (checkout / admin correction / auto-close)", () => {
  assert.equal(
    evaluateTrigger({
      tgOp: "UPDATE",
      newCheckInAt: "2026-08-10T09:00:00Z",
      oldCheckInAt: "2026-08-10T09:00:00Z",
    }),
    "return_new_already_open"
  );
  // 관리자가 check_in_at 값 자체를 다른 값으로 고치는 경우도 old가 이미 non-null이므로 동일하게 통과.
  assert.equal(
    evaluateTrigger({
      tgOp: "UPDATE",
      newCheckInAt: "2026-08-10T09:05:00Z",
      oldCheckInAt: "2026-08-10T09:00:00Z",
    }),
    "return_new_already_open"
  );
});

test("7. FOR SHARE row lock is preserved", () => {
  const source = triggerFunctionSource();
  assert.match(source, /for share;/);
});

test("8. ATTENDANCE_TRACKING_DISABLED (errcode 55000) is preserved", () => {
  const source = triggerFunctionSource();
  assert.match(
    source,
    /if not found\s*\n\s*or v_attendance_tracking_enabled is distinct from true then\s*\n\s*raise exception 'ATTENDANCE_TRACKING_DISABLED'\s*\n\s*using errcode = '55000';/
  );
});

test("9. the normal (tracking-enabled) path still ends with return new", () => {
  const source = triggerFunctionSource();
  assert.match(
    source,
    /raise exception 'ATTENDANCE_TRACKING_DISABLED'[\s\S]*end if;\s*\n\s*\n\s*return new;\s*\n\s*end;\s*\n\$\$;/
  );
});

test("10. the function body never contains 'return null'", () => {
  const source = triggerFunctionSource();
  assert.doesNotMatch(source, /return null/);
});

test("the trigger fires BEFORE INSERT OR UPDATE on attendance_records for each row, wired to the same function name", () => {
  assert.match(
    migration,
    /create trigger attendance_records_block_new_check_in\s*\n\s*before insert or update on public\.attendance_records\s*\n\s*for each row\s*\n\s*execute function public\.attendance_records_block_new_check_in_when_tracking_disabled\(\);/
  );
});

test("the trigger name and its attachment to attendance_records are unchanged", () => {
  assert.match(migration, /create trigger attendance_records_block_new_check_in\b/);
  assert.equal(
    (migration.match(/create trigger attendance_records_block_new_check_in\b/g) ?? []).length,
    1
  );
});

test("trigger function permissions, security definer, and search_path are unchanged", () => {
  assert.match(
    migration,
    /revoke all on function public\.attendance_records_block_new_check_in_when_tracking_disabled\(\)\s*\n\s*from public, anon, authenticated;/
  );
  const source = triggerFunctionSource();
  assert.match(source, /security definer/);
  assert.match(source, /set search_path = pg_catalog, public/);
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.attendance_records_block_new_check_in_when_tracking_disabled/
  );
});

test("the RPC's open-record condition still requires all three clauses (user_id, check_in_at not null, check_out_at null)", () => {
  const source = v7Source();
  assert.match(
    source,
    /where user_id = p_user_id\s*\n\s*and check_in_at is not null\s*\n\s*and check_out_at is null/
  );
  // 직원 수정 RPC의 FOR UPDATE도 그대로 유지되어야 트리거의 FOR SHARE와 계속 충돌한다.
  const beforeGuard = source.slice(0, source.indexOf("ATTENDANCE_OPEN_RECORD_EXISTS"));
  assert.match(beforeGuard, /for update;/);
});

test("the whole migration (columns, constraint, all RPC versions, and the trigger) is one atomic begin/commit block", () => {
  assert.equal((migration.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((migration.match(/^commit;$/gm) ?? []).length, 1);
  const beginIndex = migration.search(/^begin;$/m);
  const commitIndex = migration.search(/^commit;$/m);
  const triggerIndex = migration.indexOf("create trigger attendance_records_block_new_check_in");
  assert.ok(beginIndex >= 0 && triggerIndex > beginIndex && commitIndex > triggerIndex);
  const beforeBegin = migration.slice(0, beginIndex);
  const afterCommit = migration.slice(commitIndex + "commit;".length);
  assert.doesNotMatch(beforeBegin, /^[^-\s]/m);
  assert.equal(afterCommit.trim(), "");
});

test("existing RPC chain (v1-v6, create v1/v3) is still untouched by this OLD-isolation patch", () => {
  for (const fn of [
    "employee_create_with_schedule_v1",
    "employee_create_with_schedule_v3",
    "employee_update_profile_and_level_v2",
    "employee_update_profile_and_level_v3",
    "employee_update_profile_and_level_v4",
    "employee_update_profile_and_level_v5",
    "employee_update_profile_and_level_v6",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`create or replace function public\\.${fn}\\(`)
    );
  }
  assert.doesNotMatch(migration, /drop function/);
});

test("no new migration file/number was introduced for this patch", () => {
  const files = readdirSync(join(process.cwd(), "supabase/migrations"));
  const relevant = files.filter((name) => name.startsWith("2026080600"));
  assert.deepEqual(relevant, ["202608060001_add_employee_attendance_and_login_flags.sql"]);
});
