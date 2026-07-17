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
  assert.match(modal, /\{ note: String\(values\.actionNote\) \}/);
  assert.doesNotMatch(modal, /label=\{t\.moveReason\}/);
  assert.doesNotMatch(modal, /label=\{t\.correctionReason\}/);
  assert.doesNotMatch(modal, /values\.closeNote/);
  assert.match(route, /"bar_mutate_keeping_v4"/);
  assert.match(route, /return\{zone_code\}/);
  assert.doesNotMatch(route, /cleanText\(raw\.reason,500,true\).*correct_remaining/);
  assert.doesNotMatch(route, /raw\.closeNote/);
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
