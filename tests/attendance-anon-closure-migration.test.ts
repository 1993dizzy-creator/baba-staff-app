import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/202607230001_close_attendance_anon_access.sql"
  ),
  "utf8"
).toLowerCase();

test("migration removes all known anonymous attendance policies", () => {
  for (const policy of [
    "allow attendance records read",
    "allow attendance records select",
    "allow anon select attendance check logs",
  ]) {
    assert.match(migration, new RegExp(`drop policy if exists "${policy}"`));
  }
});

test("migration revokes browser roles without touching server roles or RLS", () => {
  assert.match(
    migration,
    /on table public\.attendance_records\s+from anon, authenticated/
  );
  assert.match(
    migration,
    /on table public\.attendance_check_logs\s+from anon, authenticated/
  );
  assert.match(
    migration,
    /on sequence public\.attendance_records_id_seq\s+from anon, authenticated/
  );
  assert.match(
    migration,
    /on sequence public\.attendance_check_logs_id_seq\s+from anon, authenticated/
  );
  assert.doesNotMatch(migration, /from\s+(?:service_role|postgres)/);
  assert.doesNotMatch(migration, /disable row level security/);
  assert.doesNotMatch(migration, /create policy/);
  assert.doesNotMatch(migration, /grant\s/);
});
