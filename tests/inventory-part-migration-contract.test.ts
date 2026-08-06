import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/202608060002_enforce_inventory_part_values.sql"
  ),
  "utf8"
);

test("migration pre-validates null/blank/invalid part rows before altering the schema", () => {
  assert.match(sql, /where part is null\s*\n\s*or btrim\(part\) = ''/i);
  assert.match(sql, /part not in \('kitchen', 'hall', 'bar', 'etc'\)/i);
  assert.match(sql, /raise exception/i);
  assert.match(sql, /v_invalid_count > 0/i);
});

test("migration sets part NOT NULL idempotently (checked via information_schema, not a bare ALTER)", () => {
  assert.match(sql, /alter column part set not null/i);
  assert.match(sql, /information_schema\.columns/i);
  assert.match(sql, /is_nullable = 'YES'/i);
});

test("migration adds a CHECK constraint allowing only kitchen/hall/bar/etc, with owner/cleaning excluded", () => {
  assert.match(sql, /check \(part in \('kitchen', 'hall', 'bar', 'etc'\)\)/i);
  assert.doesNotMatch(sql, /'owner'/i);
  assert.doesNotMatch(sql, /'cleaning'/i);
});

test("migration drops any pre-existing same-named constraint first to avoid name collisions on repeat apply", () => {
  assert.match(sql, /drop constraint if exists inventory_part_allowed_values/i);
  assert.match(sql, /add constraint inventory_part_allowed_values/i);

  // drop이 add보다 먼저 나와야 재적용 시 충돌 없이 대체된다.
  const dropIndex = sql.search(/drop constraint if exists inventory_part_allowed_values/i);
  const addIndex = sql.search(/add constraint inventory_part_allowed_values/i);
  assert.ok(dropIndex !== -1 && addIndex !== -1 && dropIndex < addIndex);
});

test("migration runs inside a single transaction", () => {
  assert.match(sql, /^begin;/im);
  assert.match(sql, /^commit;/im);
});
