import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const MIGRATION_PATH = "supabase/migrations/202608080001_flatten_bar_keeping_rpcs.sql";
const migration = read(MIGRATION_PATH);
const actionsRoute = read("app/api/bar/keepings/[id]/actions/route.ts");
const keepingsRoute = read("app/api/bar/keepings/route.ts");
const keepingByIdRoute = read("app/api/bar/keepings/[id]/route.ts");
const reactivateRequestLib = read("lib/bar/keeping-reactivate-request.ts");

function section(name: string, nextName?: string) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  assert.ok(start > -1, `expected to find create or replace function public.${name}(`);
  const end = nextName ? migration.indexOf(`create or replace function public.${nextName}(`, start) : migration.length;
  return migration.slice(start, end === -1 ? migration.length : end);
}

const v5 = section("bar_mutate_keeping_v5", "bar_update_and_move_keeping");
const updateAndMove = section("bar_update_and_move_keeping");

// ---------------------------------------------------------------------------
// 0. migration 구조
// ---------------------------------------------------------------------------

test("migration file is transactional", () => {
  assert.match(migration, /^begin;$/m);
  assert.match(migration.trimEnd(), /commit;$/);
});

test("migration only uses CREATE OR REPLACE for these two — never DROP FUNCTION, so existing grants stay attached automatically (signatures unchanged)", () => {
  assert.doesNotMatch(migration, /drop function/i);
  assert.equal((migration.match(/create or replace function public\.bar_mutate_keeping_v5\(/g) ?? []).length, 1);
  assert.equal((migration.match(/create or replace function public\.bar_update_and_move_keeping\(/g) ?? []).length, 1);
});

test("migration never drops or replaces any of the legacy RPCs in the old delegation chain — left as-is for Phase 1-D2", () => {
  for (const name of [
    "bar_mutate_keeping", // base (bare, no version suffix)
    "bar_mutate_keeping_v2",
    "bar_mutate_keeping_v3",
    "bar_mutate_keeping_v4",
  ]) {
    assert.doesNotMatch(migration, new RegExp(`(create|create or replace|drop)\\s+function\\s+public\\.${name}\\(`));
  }
});

test("migration signatures for v5 and bar_update_and_move_keeping are byte-identical to their current production signatures (no arg added/removed/reordered)", () => {
  assert.match(
    v5,
    /bar_mutate_keeping_v5\(\s*p_id bigint,\s*p_expected_version integer,\s*p_action text,\s*p_payload jsonb,\s*p_actor_user_id bigint\s*\)/,
  );
  assert.match(
    updateAndMove,
    /bar_update_and_move_keeping\(\s*p_id bigint,\s*p_expected_version integer,\s*p_update_payload jsonb,\s*p_move_payload jsonb,\s*p_actor_user_id bigint\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// 1. 두 진입점이 더 이상 구버전 RPC를 호출하지 않는지(핵심 목표).
// ---------------------------------------------------------------------------

test("v5 body no longer calls bar_mutate_keeping_v4/_v3/_v2, or the bare bar_mutate_keeping base function, anywhere", () => {
  const bodyOnly = v5.slice(v5.indexOf("as $function$"));
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v4\(/);
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v3\(/);
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v2\(/);
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping\(/);
});

test("bar_update_and_move_keeping no longer calls legacy bar_mutate_keeping_v3 — it now calls the flattened bar_mutate_keeping_v5 twice (update then move)", () => {
  const bodyOnly = updateAndMove.slice(updateAndMove.indexOf("as $function$"));
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v3\(/);
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v[24]\(/);
  const calls = [...bodyOnly.matchAll(/public\.bar_mutate_keeping_v5\(/g)];
  assert.equal(calls.length, 2, "expected exactly 2 calls to bar_mutate_keeping_v5 (update + move)");
  assert.match(bodyOnly, /'update', p_update_payload, p_actor_user_id/);
  assert.match(bodyOnly, /'move', p_move_payload, p_actor_user_id/);
});

test("no other versioned bar_* RPC call appears anywhere in either function's body (declaration headers of the two functions being defined are excluded)", () => {
  const v5BodyOnly = v5.slice(v5.indexOf("as $function$"));
  const updateAndMoveBodyOnly = updateAndMove.slice(updateAndMove.indexOf("as $function$"));
  const callsInV5 = [...v5BodyOnly.matchAll(/public\.bar_(?:mutate_keeping|update_and_move_keeping)_?v?\d*\(/g)].map((m) => m[0]);
  const callsInUpdateAndMove = [...updateAndMoveBodyOnly.matchAll(/public\.bar_(?:mutate_keeping|update_and_move_keeping)_?v?\d*\(/g)]
    .map((m) => m[0])
    .filter((c) => c !== "public.bar_mutate_keeping_v5(");
  assert.deepEqual(callsInV5, []);
  assert.deepEqual(callsInUpdateAndMove, []);
});

// ---------------------------------------------------------------------------
// 2. 정책 보존 검증 — action별 로그 action_type, 예외 코드, 상태 게이트가
//    원본 5-함수 체인(base + v2 + v3 + v4 + v5)과 정확히 동일하게 남아있는지.
// ---------------------------------------------------------------------------

test("v5 still dispatches all 7 base actions with unchanged status gates", () => {
  const gates: Array<[string, RegExp]> = [
    ["update", /if v_old\.status = 'closed' and coalesce\(\(v_payload->>'allow_closed'\)::boolean, false\) is not true then/],
    ["use", /if v_old\.status <> 'active' then\s*\n\s*return jsonb_build_object\('status', 'invalid_state'\);\s*\n\s*end if;\s*\n\s*if coalesce\(\(v_payload->>'finish'\)::boolean, false\) and \(v_payload->>'remaining_percent'\)::integer <> 0 then/],
    ["correct_remaining", /elsif p_action = 'correct_remaining' then\s*\n\s*if v_old\.status <> 'active' then/],
    ["move", /elsif p_action = 'move' then\s*\n\s*if v_old\.status <> 'active' then/],
    ["replace_photo", /elsif p_action = 'replace_photo' then\s*\n\s*if nullif\(v_payload->>'image_path', ''\) is null then/],
    ["close", /elsif p_action = 'close' then\s*\n\s*if v_old\.status <> 'active' then/],
    ["reactivate", /elsif p_action = 'reactivate' then\s*\n\s*if v_old\.status <> 'closed' then/],
  ];
  for (const [name, pattern] of gates) {
    assert.match(v5, pattern, `missing/changed status gate for action "${name}"`);
  }
});

test("v5 still resolves liquor_source for update (inventory/external) and computes expires_at = stored_at + 3 months for both update and reactivate", () => {
  assert.match(v5, /if v_source = 'inventory' then/);
  assert.match(v5, /and i\.part = 'bar' and i\.is_active = true/);
  assert.match(v5, /elsif v_source = 'external' then/);
  const expiresMatches = [...v5.matchAll(/\(v_stored_at \+ interval '3 months'\)::date/g)];
  assert.ok(expiresMatches.length >= 3, "expected the 3-month expiry calc to appear for update/v2-post/reactivate");
});

test("v5 still validates customer_contact length <= 120 for update, before the row lock (matches original v3-before-v2-before-base ordering)", () => {
  const contactCheckIndex = v5.indexOf("char_length(v_contact) > 120");
  const rowLockIndex = v5.indexOf("for update;");
  assert.ok(contactCheckIndex > -1 && rowLockIndex > -1);
  assert.ok(contactCheckIndex < rowLockIndex, "customer_contact validation must run before the row lock, exactly like the original v3-before-base ordering");
});

test("v5 still strips legacy note/close_note inputs before the shared mutation for use(finish)/close, and swaps note->reason for reactivate", () => {
  assert.match(v5, /v_payload := p_payload - 'note';/);
  assert.match(v5, /v_payload := p_payload - 'close_note';/);
  assert.match(v5, /v_payload := \(p_payload - 'note'\) \|\| jsonb_build_object\('reason', v_action_note\);/);
});

test("v5 still performs the reactivate log-integrity check (exactly one new keeping_reactivated log row)", () => {
  assert.match(v5, /v_new_log_count <> 1 or v_log_id is null/);
  assert.match(v5, /expected one new keeping reactivation log for/);
});

test("v5 preserves the exact exception-catching scope split from the original chain: base+v2+v3's check_violation/invalid_text_representation/datetime_field_overflow handler wraps only the shared-mutation block, not v4/v5's own pre/post note-handling blocks (which never had a handler)", () => {
  const nestedBeginIndex = v5.indexOf("begin\n    -- ----- 구 v3-pre");
  const exceptionIndex = v5.indexOf("exception when check_violation or invalid_text_representation or datetime_field_overflow then");
  assert.ok(nestedBeginIndex > -1 && exceptionIndex > -1, "expected a nested begin/exception block wrapping only the base+v2+v3 equivalent logic");
  const v4PostIndex = v5.indexOf("구 v4-post");
  const v5PostIndex = v5.indexOf("구 v5-post");
  assert.ok(v4PostIndex > exceptionIndex && v5PostIndex > exceptionIndex, "v4-post and v5-post sections must be outside (after) the nested exception handler");
});

// ---------------------------------------------------------------------------
// 3. INSERT/UPDATE 대상 테이블 횟수까지 원본 5-함수 체인과 정확히 동일한지.
// ---------------------------------------------------------------------------

function tableOpCounts(body: string) {
  const matches = [...body.matchAll(/(insert into|update) public\.([a-z_]+)/g)];
  const counts: Record<string, number> = {};
  for (const m of matches) {
    const key = `${m[1]} public.${m[2]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

test("v5 touches bar_keepings/bar_activity_logs the same total number of times as the original base+v2+v3+v4+v5 chain combined (base: 1 insert log + 7 action UPDATEs; v2: 3 extra UPDATEs + 3 log UPDATEs; v3: 1 extra UPDATE + 1 log UPDATE; v4: 1 extra UPDATE + 1 log UPDATE; v5: 1 extra UPDATE + 1 log UPDATE)", () => {
  assert.deepEqual(tableOpCounts(v5), {
    "insert into public.bar_activity_logs": 1,
    "update public.bar_keepings": 13,
    "update public.bar_activity_logs": 6,
  });
});

test("v5 raises exactly 4 named integrity exceptions, matching v4's 2 (note log not found / log update failed) + v5's 2 (reactivation log count / reactivation log update failed)", () => {
  const raises = [...v5.matchAll(/raise exception '/g)];
  assert.equal(raises.length, 4);
});

// ---------------------------------------------------------------------------
// 4. application 코드는 수정되지 않았고, 여전히 동일한 RPC 이름을 호출한다.
// ---------------------------------------------------------------------------

test("action route still dispatches update_with_move to bar_update_and_move_keeping and every other action to KEEPING_REACTIVATE_RPC (bar_mutate_keeping_v5), unchanged by this migration", () => {
  assert.match(actionsRoute, /action==="update_with_move"\?"bar_update_and_move_keeping":mutationRpc/);
  assert.match(reactivateRequestLib, /KEEPING_REACTIVATE_RPC\s*=\s*"bar_mutate_keeping_v5"/);
});

test("keepings create/delete routes are untouched by this migration (out of Phase 1-D scope)", () => {
  assert.match(keepingsRoute, /"bar_create_keeping"/);
  assert.match(keepingByIdRoute, /"bar_delete_keeping_v2"/);
});

test("no application file was modified to reference the new migration's internals — Phase 1-D changes the DB layer only", () => {
  for (const src of [actionsRoute, keepingsRoute, keepingByIdRoute, reactivateRequestLib]) {
    assert.doesNotMatch(src, /bar_mutate_keeping_v[234]\(/);
  }
});
