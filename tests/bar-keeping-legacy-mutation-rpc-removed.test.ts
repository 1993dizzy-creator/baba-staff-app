import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const MIGRATION_PATH = "supabase/migrations/202608080002_remove_legacy_bar_keeping_mutation_rpcs.sql";
const migration = read(MIGRATION_PATH);

const PRIOR_FLATTEN_MIGRATION_PATH = "supabase/migrations/202608080001_flatten_bar_keeping_rpcs.sql";
const priorMigration = read(PRIOR_FLATTEN_MIGRATION_PATH);

const LEGACY_NAMES = [
  "bar_mutate_keeping",
  "bar_mutate_keeping_v2",
  "bar_mutate_keeping_v3",
  "bar_mutate_keeping_v4",
];

const PROTECTED_FUNCTIONS = [
  "bar_mutate_keeping_v5",
  "bar_update_and_move_keeping",
  "bar_delete_active_keeping_v1",
  "bar_delete_keeping_v2",
  "bar_create_keeping",
  "bar_update_zone",
  "bar_update_zone_photo",
];

const PROTECTED_TABLES = [
  "bar_keepings",
  "bar_activity_logs",
  "bar_zones",
  "inventory",
  "sales",
  "users",
];

// ---------------------------------------------------------------------------
// 0. migration 구조
// ---------------------------------------------------------------------------

test("migration file is transactional", () => {
  assert.match(migration, /^begin;$/m);
  assert.match(migration.trimEnd(), /commit;$/);
});

test("migration contains exactly 4 DROP FUNCTION statements and nothing else that mutates schema/data", () => {
  const dropMatches = [...migration.matchAll(/drop function public\.([a-z_0-9]+)\(/g)];
  assert.equal(dropMatches.length, 4);
  assert.deepEqual(
    dropMatches.map((m) => m[1]).sort(),
    [...LEGACY_NAMES].sort(),
  );
});

test("migration does not CREATE, CREATE OR REPLACE, ALTER, INSERT, UPDATE, or DELETE anything", () => {
  assert.doesNotMatch(migration, /create\s+(or\s+replace\s+)?function/i);
  assert.doesNotMatch(migration, /create\s+(or\s+replace\s+)?(table|view|trigger|policy)/i);
  assert.doesNotMatch(migration, /\balter\s+(table|function)\b/i);
  assert.doesNotMatch(migration, /\binsert\s+into\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\./i);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
});

test("migration never uses CASCADE as part of an actual DDL statement (comment lines explaining its absence are excluded from this check)", () => {
  const sqlOnly = migration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(sqlOnly, /\bcascade\b/i);
});

// ---------------------------------------------------------------------------
// 1. DROP signature가 운영 identity signature와 정확히 일치.
// ---------------------------------------------------------------------------

test("each DROP FUNCTION uses the exact production identity signature (p_id bigint, p_expected_version integer, p_action text, p_payload jsonb, p_actor_user_id bigint)", () => {
  for (const name of LEGACY_NAMES) {
    const pattern = new RegExp(
      `drop function public\\.${name}\\(\\s*p_id bigint,\\s*p_expected_version integer,\\s*p_action text,\\s*p_payload jsonb,\\s*p_actor_user_id bigint\\s*\\);`,
    );
    assert.match(migration, pattern, `expected exact identity signature DROP for ${name}`);
  }
});

test("bar_mutate_keeping (base, no version suffix) is dropped with a bare name, not accidentally matching bar_mutate_keeping_v2/_v3/_v4's own drop lines", () => {
  const bareDropMatches = [...migration.matchAll(/drop function public\.bar_mutate_keeping\(/g)];
  assert.equal(bareDropMatches.length, 1);
});

// ---------------------------------------------------------------------------
// 2. 보호 대상 — v5/wrapper/기타 BAR RPC/테이블은 이번 migration에서 전혀 언급되지 않음.
// ---------------------------------------------------------------------------

test("migration never targets any protected function with CREATE/CREATE OR REPLACE/DROP/ALTER (comment mentions documenting the protection are fine)", () => {
  for (const name of PROTECTED_FUNCTIONS) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(create|create or replace|drop|alter)\\s+function\\s+public\\.${name}\\(`),
      `migration must not DDL-target protected function ${name}`,
    );
  }
});

test("migration never targets any protected table with CREATE/ALTER/DROP/INSERT/UPDATE/DELETE (comment mentions documenting the protection are fine)", () => {
  for (const name of PROTECTED_TABLES) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(create|alter|drop)\\s+table\\s+public\\.${name}\\b`),
      `migration must not DDL-target protected table ${name}`,
    );
    assert.doesNotMatch(
      migration,
      new RegExp(`(insert into|update|delete from)\\s+public\\.${name}\\b`),
      `migration must not DML-target protected table ${name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Phase 1-D의 flatten 결과가 여전히 구조적으로 유지되는지 재검증
//    (bar_mutate_keeping_v5가 legacy 4개를 호출하지 않고, wrapper가 v5만 호출).
// ---------------------------------------------------------------------------

function section(migrationText: string, name: string, nextName?: string) {
  const start = migrationText.indexOf(`create or replace function public.${name}(`);
  assert.ok(start > -1, `expected to find create or replace function public.${name}(`);
  const end = nextName ? migrationText.indexOf(`create or replace function public.${nextName}(`, start) : migrationText.length;
  return migrationText.slice(start, end === -1 ? migrationText.length : end);
}

test("Phase 1-D migration's bar_mutate_keeping_v5 body still calls zero legacy versioned/base RPCs (structural re-verification, independent of this DROP migration)", () => {
  const v5 = section(priorMigration, "bar_mutate_keeping_v5", "bar_update_and_move_keeping");
  const bodyOnly = v5.slice(v5.indexOf("as $function$"));
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v4\(/);
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v3\(/);
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v2\(/);
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping\(/);
});

test("Phase 1-D migration's bar_update_and_move_keeping body calls only bar_mutate_keeping_v5, never legacy v3", () => {
  const wrapper = section(priorMigration, "bar_update_and_move_keeping");
  const bodyOnly = wrapper.slice(wrapper.indexOf("as $function$"));
  assert.doesNotMatch(bodyOnly, /public\.bar_mutate_keeping_v3\(/);
  const calls = [...bodyOnly.matchAll(/public\.bar_mutate_keeping_v5\(/g)];
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// 4. application runtime이 legacy 4개를 호출하지 않고, v5/wrapper만 사용.
// ---------------------------------------------------------------------------

const RUNTIME_DIRS = ["app", "lib", "components", "scripts"];

function listFilesRecursive(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      files.push(...listFilesRecursive(full));
    } else if (/\.(ts|tsx|js|jsx|sql)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("no runtime file under app/, lib/, components/, scripts/ calls any of the 4 legacy BAR keeping mutation RPCs", () => {
  const legacyCallPattern = /"bar_mutate_keeping(_v[234])?"|rpc\(\s*["']bar_mutate_keeping(_v[234])?["']/;
  const offenders: string[] = [];
  for (const dir of RUNTIME_DIRS) {
    for (const file of listFilesRecursive(join(process.cwd(), dir))) {
      const content = readFileSync(file, "utf8");
      if (legacyCallPattern.test(content)) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("supabase/functions directory does not exist in this repo (no Edge Functions to check for legacy RPC calls)", () => {
  const files = listFilesRecursive(join(process.cwd(), "supabase", "functions"));
  assert.deepEqual(files, []);
});

test("the BAR keeping action route and reactivate-request lib reference only the v5 RPC name and the wrapper, not any legacy version", () => {
  const actionsRoute = read("app/api/bar/keepings/[id]/actions/route.ts");
  const reactivateRequestLib = read("lib/bar/keeping-reactivate-request.ts");
  assert.match(reactivateRequestLib, /KEEPING_REACTIVATE_RPC\s*=\s*"bar_mutate_keeping_v5"/);
  assert.match(actionsRoute, /action==="update_with_move"\?"bar_update_and_move_keeping":mutationRpc/);
  for (const src of [actionsRoute, reactivateRequestLib]) {
    assert.doesNotMatch(src, /bar_mutate_keeping_v[234]\b/);
    assert.doesNotMatch(src, /"bar_mutate_keeping"/);
  }
});

test("bar_create_keeping, bar_delete_keeping_v2, bar_delete_active_keeping_v1, and zone RPCs are never DROP/CREATE/ALTER targets in this migration (comment mentions are fine)", () => {
  for (const name of ["bar_create_keeping", "bar_delete_keeping_v2", "bar_delete_active_keeping_v1", "bar_update_zone", "bar_update_zone_photo"]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(create|create or replace|drop|alter)\\s+function\\s+public\\.${name}\\(`),
    );
  }
});
