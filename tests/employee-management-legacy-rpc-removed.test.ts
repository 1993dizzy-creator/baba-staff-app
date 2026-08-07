import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const MIGRATION_PATH = "supabase/migrations/202608070007_remove_legacy_employee_management_rpcs.sql";
const migration = read(MIGRATION_PATH);

const LEGACY_RPCS: Array<{ name: string; args: string }> = [
  { name: "employee_update_profile_and_level_v2", args: "p_user_id bigint, p_updates jsonb, p_base_date_override date,\n  p_actor_id bigint, p_actor_username text" },
  { name: "employee_update_profile_and_level_v3", args: "p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,\n  p_base_date_override date, p_actor_id bigint, p_actor_username text" },
  { name: "employee_update_profile_and_level_v4", args: "p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,\n  p_base_date_override date, p_actor_id bigint, p_actor_username text" },
  { name: "employee_update_profile_and_level_v5", args: "p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,\n  p_effective_from date, p_change_reason text, p_actor_id bigint, p_actor_username text" },
  { name: "employee_update_profile_and_level_v6", args: "p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,\n  p_effective_from date, p_base_date_mode text, p_base_date_override date,\n  p_change_reason text, p_actor_id bigint, p_actor_username text" },
  { name: "employee_update_profile_and_level_v7", args: "p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,\n  p_base_date_override date, p_actor_id bigint, p_actor_username text" },
  { name: "employee_update_profile_and_level_v8", args: "p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,\n  p_base_date_override date, p_actor_id bigint, p_actor_username text" },
  { name: "employee_create_with_schedule_v1", args: "p_employee jsonb, p_actor_id bigint, p_actor_username text" },
  { name: "employee_create_with_schedule_v2", args: "p_employee jsonb, p_level_program_enabled boolean, p_change_reason text,\n  p_actor_id bigint, p_actor_username text" },
  { name: "employee_create_with_schedule_v3", args: "p_employee jsonb, p_level_program_enabled boolean, p_change_reason text,\n  p_actor_id bigint, p_actor_username text" },
  { name: "employee_create_with_schedule_v4", args: "p_employee jsonb, p_actor_id bigint, p_actor_username text" },
  { name: "employee_rehire_with_level_policy_v2", args: "p_user_id bigint, p_rehire_date date, p_level_program_enabled boolean,\n  p_change_reason text, p_actor_id bigint, p_actor_username text, p_previous_level smallint" },
  { name: "employee_rehire_with_level_reset_v1", args: "p_user_id bigint, p_rehire_date date, p_actor_id bigint, p_actor_username text,\n  p_change_reason text, p_previous_level smallint" },
];

const PROTECTED_FUNCTIONS = [
  "employee_update_profile_and_level_v9",
  "employee_create_with_schedule_v5",
  "employee_rehire_with_level_policy_v3",
  "employee_create_work_schedule_version_v1",
  "employee_update_level_policy_v1",
];

const PROTECTED_TABLES = [
  "users",
  "employee_work_schedule_versions",
  "employee_level_program_versions",
  "employee_level_audit_logs",
  "payroll_contract_versions",
  "payroll_employee_payments",
  "payroll_payment_batches",
  "attendance_records",
];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  const absolute = join(process.cwd(), dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relative = `${dir}/${entry}`;
    const full = join(absolute, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      collectSourceFiles(relative, out);
    } else if ([".ts", ".tsx"].includes(extname(entry))) {
      out.push(relative);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. migration 구조
// ---------------------------------------------------------------------------

test("migration file is transactional", () => {
  assert.match(migration, /^begin;$/m);
  assert.match(migration.trimEnd(), /commit;$/);
});

test("migration never uses CASCADE as part of an actual DROP statement", () => {
  assert.doesNotMatch(migration, /drop\s+function[^;\n]*\bcascade\b/i);
});

test("migration contains no table DDL and no DML at all — DROP FUNCTION statements only", () => {
  assert.doesNotMatch(migration, /drop\s+table/i);
  assert.doesNotMatch(migration, /alter\s+table/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\./i);
  assert.doesNotMatch(migration, /\binsert\s+into\b/i);
  assert.doesNotMatch(migration, /create\s+(or replace\s+)?function/i);
});

// ---------------------------------------------------------------------------
// 2. 정확히 13개만 DROP, signature까지 정확히 일치.
// ---------------------------------------------------------------------------

test("migration drops exactly 13 functions, no more, no less", () => {
  const dropped = [...migration.matchAll(/drop function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.equal(dropped.length, 13);
  assert.deepEqual(new Set(dropped), new Set(LEGACY_RPCS.map((r) => r.name)));
});

for (const rpc of LEGACY_RPCS) {
  test(`migration drops ${rpc.name} with its exact current production signature`, () => {
    const escapedArgs = rpc.args.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`drop function public\\.${rpc.name}\\(\\s*\\n\\s*${escapedArgs}\\s*\\n\\);`);
    assert.match(migration, pattern);
  });
}

test("migration drops each of the 13 exactly once", () => {
  for (const rpc of LEGACY_RPCS) {
    const count = (migration.match(new RegExp(`drop function public\\.${rpc.name}\\(`, "g")) ?? []).length;
    assert.equal(count, 1, `${rpc.name} should be dropped exactly once`);
  }
});

// ---------------------------------------------------------------------------
// 3. 보호 대상 — v9/v5/v3/schedule-version-v1/orphan-level-policy-v1은 DROP 목록에 없음.
// ---------------------------------------------------------------------------

test("migration never drops any protected function (latest entries, unrelated schedule RPC, or the separately-tracked orphan)", () => {
  for (const name of PROTECTED_FUNCTIONS) {
    assert.doesNotMatch(migration, new RegExp(`drop\\s+function\\s+public\\.${name}\\(`));
  }
});

test("migration never touches any protected table (users, schedule/level history, payroll, attendance records)", () => {
  for (const name of PROTECTED_TABLES) {
    assert.doesNotMatch(migration, new RegExp(`(create|create or replace|alter|drop)\\s+table\\s+public\\.${name}\\b`, "i"));
  }
});

// ---------------------------------------------------------------------------
// 4. application runtime 코드는 여전히 최신 3개만 호출, 제거 대상 13개 참조 0.
// ---------------------------------------------------------------------------

test("application runtime code (app/lib/components/scripts) has zero references to any of the 13 legacy RPC names", () => {
  const offenders: string[] = [];
  for (const dir of ["app", "lib", "components", "scripts"]) {
    for (const file of collectSourceFiles(dir)) {
      const content = read(file);
      for (const rpc of LEGACY_RPCS) {
        if (content.includes(rpc.name)) {
          offenders.push(`${file}: ${rpc.name}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("application runtime code still calls exactly the 3 latest entries", () => {
  const usersRoute = read("app/api/admin/users/route.ts");
  const createRoute = read("app/api/admin/users/create/route.ts");
  assert.match(usersRoute, /"employee_update_profile_and_level_v9"/);
  assert.match(usersRoute, /"employee_rehire_with_level_policy_v3"/);
  assert.match(createRoute, /"employee_create_with_schedule_v5"/);
});

test("this migration's own DROP statements match exactly the 13 names with zero runtime references found above — the investigation and the DROP list are the same set", () => {
  const dropped = new Set([...migration.matchAll(/drop function public\.(\w+)\(/g)].map((m) => m[1]));
  const investigated = new Set(LEGACY_RPCS.map((r) => r.name));
  assert.deepEqual(dropped, investigated);
});
