import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("keeping actions use a separate optional action note and moves have no reason", () => {
  const modal = source("components/bar/keeping/KeepingActionModal.tsx");
  const route = source("app/api/bar/keepings/[id]/actions/route.ts");

  assert.match(modal, /actionNote: ""/);
  assert.match(modal, /zoneCode: item\.zoneCode/);
  assert.match(modal, /\{ note: String\(values\.actionNote\) \}/);
  assert.doesNotMatch(modal, /label=\{t\.moveReason\}/);
  assert.doesNotMatch(modal, /label=\{t\.correctionReason\}/);
  assert.doesNotMatch(modal, /values\.closeNote/);
  assert.match(route, /KEEPING_REACTIVATE_RPC/);
  assert.match(route, /return\{zone_code\}/);
  assert.doesNotMatch(route, /cleanText\(raw\.reason,500,true\).*correct_remaining/);
  assert.doesNotMatch(route, /raw\.closeNote/);
});

test("reactivation uses an optional common note and v5 updates it and the audit log atomically", () => {
  const modal = source("components/bar/keeping/KeepingActionModal.tsx");
  const route = source("app/api/bar/keepings/[id]/actions/route.ts");
  const migration = source("supabase/migrations/202607180004_add_reactivate_action_note.sql");
  assert.match(modal, /"reactivate"\]\.includes\(effectiveAction\)/);
  assert.match(modal, /area label=\{t\.note\}/);
  assert.doesNotMatch(modal, /required label=\{t\.reactivateReason\}/);
  assert.doesNotMatch(route, /raw\.reason/);
  assert.match(route, /note=cleanText\(raw\.note,1000\)/);
  assert.match(migration, /p_action <> 'reactivate'/);
  assert.match(migration, /v_action_note := nullif\(btrim\(p_payload->>'note'\), ''\)/);
  assert.match(migration, /\(p_payload - 'note'\) \|\| jsonb_build_object\([\s\S]*'reason', v_action_note/);
  assert.match(migration, /if v_action_note is not null then[\s\S]*set note = v_action_note/);
  assert.match(migration, /action_type = 'keeping_reactivated'/);
  assert.match(migration, /'action_note', v_action_note/);
  assert.match(migration, /v_log_id_before/);
  assert.match(migration, /l\.id > v_log_id_before/);
  assert.match(migration, /v_new_log_count <> 1/);
  assert.doesNotMatch(migration, /order by l\.created_at desc, l\.id desc[\s\S]*limit 1/);
  assert.doesNotMatch(migration, /v_action_note is null then[\s\S]*jsonb_build_object\('note', v_final_note\)/);
  assert.doesNotMatch(migration, /version\s*=\s*version\s*\+/i);
  assert.doesNotMatch(migration, /close_note|reactivate_reason/);
  const formatter = source("lib/bar/log-format.ts");
  assert.match(formatter, /"keeping_reactivated"\]\.includes/);
  assert.match(formatter, /log\.actionType==="keeping_reactivated"\?"reason"/);
});

test("reactivation note compatibility keeps legacy reason without treating the common note as an action note", () => {
  const migration = source("supabase/migrations/202607180004_add_reactivate_action_note.sql");
  const formatter = source("lib/bar/log-format.ts");

  assert.match(migration, /'reason', v_action_note/);
  assert.match(migration, /if v_action_note is not null then[\s\S]*'action_note', v_action_note/);
  assert.match(migration, /if v_action_note is not null then[\s\S]*set note = v_action_note/);
  assert.doesNotMatch(migration, /if v_action_note is null then[\s\S]*set note/);
  assert.doesNotMatch(formatter, /keeping_reactivated[^\n]*\?"note"/);
  assert.match(formatter, /hasOwnProperty\.call\(log\.afterData,"action_note"\)/);
  assert.match(formatter, /keeping_reactivated"\?"reason"/);
});

test("deployed lower-function sources accept reactivation without a required reason", () => {
  const base = source(
    "supabase/migrations/202607150002_create_bar_keeping_management.sql"
  );
  const v2 = source(
    "supabase/migrations/202607150004_add_bar_keeping_use_count_fixed_expiry.sql"
  );
  const baseReactivate = base.slice(
    base.indexOf("elsif p_action = 'reactivate'"),
    base.indexOf("else return jsonb_build_object('status','invalid_action')")
  );
  const v2Reactivate = v2.slice(
    v2.indexOf("elsif p_action = 'reactivate'"),
    v2.indexOf("v_result := public.bar_mutate_keeping")
  );

  assert.match(baseReactivate, /v_old\.status <> 'closed'.*'invalid_state'/);
  assert.match(baseReactivate, /p_payload->>'zone_code'/);
  assert.doesNotMatch(baseReactivate, /p_payload->>'reason'/);
  assert.match(v2Reactivate, /p_payload->>'stored_at'/);
  assert.doesNotMatch(v2Reactivate, /p_payload->>'reason'/);
  assert.match(
    base,
    /jsonb_build_object\('reason',p_payload->>'reason','note',p_payload->>'note'\)/
  );
});

test("v5 identifies exactly the log created after its pre-delegation watermark", () => {
  const migration = source("supabase/migrations/202607180004_add_reactivate_action_note.sql");

  assert.match(migration, /select coalesce\(max\(l\.id\), 0\)[\s\S]*into v_log_id_before/);
  assert.match(migration, /select count\(\*\), max\(l\.id\)[\s\S]*l\.id > v_log_id_before/);
  assert.match(migration, /v_new_log_count <> 1/);
  assert.match(migration, /raise exception 'expected one new keeping reactivation log/);
  assert.match(migration, /raise exception 'keeping reactivation log update failed/);
});

test("v4 preserves versioning while atomically updating common and action notes", () => {
  const migration = source(
    "supabase/migrations/202607170002_unify_bar_keeping_action_notes.sql"
  );

  assert.match(migration, /public\.bar_mutate_keeping_v3\(/);
  assert.match(migration, /if v_action_note is not null then/);
  assert.match(migration, /'action_note', v_action_note/);
  assert.match(migration, /'note', v_final_note/);
  assert.match(migration, /raise exception 'keeping action log not found/);
  assert.doesNotMatch(migration, /version\s*=\s*version\s*\+/i);
  assert.match(migration, /to service_role/);
  assert.match(migration, /from public, anon, authenticated/);
});

test("legacy close notes are backfilled without dropping their source column", () => {
  const migration = source(
    "supabase/migrations/202607170002_unify_bar_keeping_action_notes.sql"
  );
  assert.match(migration, /set note = nullif\(btrim\(close_note\), ''\)/);
  assert.match(migration, /nullif\(btrim\(note\), ''\) is null/);
  assert.doesNotMatch(migration, /drop\s+column\s+close_note/i);
  assert.doesNotMatch(migration, /drop\s+function/i);
});

test("new automatic finishes do not persist the action note as close_note", () => {
  const migration = source(
    "supabase/migrations/202607170002_unify_bar_keeping_action_notes.sql"
  );
  assert.match(migration, /p_action = 'use'/);
  assert.match(migration, /p_payload->>'finish'/);
  assert.match(migration, /v_delegate_payload := v_delegate_payload - 'note'/);
  assert.match(migration, /v_delegate_payload := v_delegate_payload - 'close_note'/);
  assert.match(migration, /bar_mutate_keeping_v3\([\s\S]*v_delegate_payload/);
});

test("logs keep a narrow note allowlist", () => {
  const route = source("app/api/bar/logs/route.ts");
  for (const key of ["action_note", "note", "reason", "close_note"]) {
    assert.match(route, new RegExp(`"${key}"`));
  }
  assert.match(route, /key === "action_note"/);
  assert.match(route, /source\[key\] === null/);
  assert.doesNotMatch(route, /customer_contact.*flatMap/);
});
