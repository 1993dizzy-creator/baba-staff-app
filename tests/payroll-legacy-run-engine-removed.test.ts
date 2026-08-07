import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const MIGRATION_PATH = "supabase/migrations/202608070004_remove_legacy_payroll_run_engine.sql";
const migration = read(MIGRATION_PATH);

const LEGACY_FUNCTIONS: Array<{ name: string; args: string }> = [
  { name: "payroll_create_run_v2", args: "p_month date, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint" },
  { name: "payroll_create_run_v3", args: "p_month date, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint" },
  { name: "payroll_create_run_v4", args: "p_month date, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint" },
  { name: "payroll_recalculate_run_v2", args: "p_run_id bigint, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint" },
  { name: "payroll_recalculate_run_v3", args: "p_run_id bigint, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint" },
  { name: "payroll_recalculate_run_v4", args: "p_run_id bigint, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint" },
  { name: "payroll_insert_payload_v2", args: "p_run_id bigint, p_employees jsonb, p_actor_user_id bigint, p_copy_manual_from_run_id bigint" },
  { name: "payroll_insert_payload_v3", args: "p_run_id bigint, p_employees jsonb, p_actor_user_id bigint, p_copy_manual_from_run_id bigint" },
  { name: "payroll_insert_payload_v4", args: "p_run_id bigint, p_employees jsonb, p_actor_user_id bigint, p_copy_manual_from_run_id bigint" },
  { name: "payroll_refresh_totals_v2", args: "p_run_id bigint" },
  { name: "payroll_refresh_totals_v3", args: "p_run_id bigint" },
  { name: "payroll_refresh_totals_v4", args: "p_run_id bigint" },
  { name: "payroll_mutate_item_v2", args: "p_run_id bigint, p_run_employee_id bigint, p_item_id bigint, p_operation text, p_category text, p_direction text, p_amount bigint, p_description text, p_reason text, p_actor_user_id bigint" },
  { name: "payroll_mutate_item_v3", args: "p_run_id bigint, p_run_employee_id bigint, p_item_id bigint, p_operation text, p_category text, p_direction text, p_amount bigint, p_description text, p_reason text, p_actor_user_id bigint" },
  { name: "payroll_mutate_item_v4", args: "p_run_id bigint, p_run_employee_id bigint, p_item_id bigint, p_operation text, p_category text, p_direction text, p_amount bigint, p_description text, p_reason text, p_actor_user_id bigint" },
  { name: "payroll_resolve_review_v2", args: "p_run_id bigint, p_run_employee_id bigint, p_review_id bigint, p_action text, p_custom_minutes integer, p_reason text, p_actor_user_id bigint" },
  { name: "payroll_resolve_review_v3", args: "p_run_id bigint, p_run_employee_id bigint, p_review_id bigint, p_action text, p_custom_minutes integer, p_reason text, p_actor_user_id bigint" },
  { name: "payroll_resolve_review_v4", args: "p_run_id bigint, p_run_employee_id bigint, p_review_id bigint, p_action text, p_custom_minutes integer, p_reason text, p_actor_user_id bigint" },
  { name: "payroll_transition_run_v2", args: "p_run_id bigint, p_action text, p_reason text, p_payment_date date, p_payment_method text, p_payment_note text, p_actor_user_id bigint" },
  { name: "payroll_transition_run_v3", args: "p_run_id bigint, p_action text, p_reason text, p_payment_date date, p_payment_method text, p_payment_note text, p_actor_user_id bigint" },
  { name: "payroll_transition_run_v4", args: "p_run_id bigint, p_action text, p_reason text, p_payment_date date, p_payment_method text, p_payment_note text, p_actor_user_id bigint" },
];

const LEGACY_TABLES_IN_DROP_ORDER = [
  "payroll_run_audit_logs",
  "payroll_run_items",
  "payroll_run_reviews",
  "payroll_run_employees",
  "payroll_runs",
];

// 신규 지급 원장(절대 건드리면 안 되는 것들) — Phase 1-A 범위 밖.
const PROTECTED_OBJECTS = [
  "payroll_payment_batches",
  "payroll_employee_payments",
  "payroll_payment_audit_logs",
  "payroll_pay_employee_v1",
  "payroll_contract_versions",
  "payroll_contract_audit_logs",
  "payroll_insurance_setting_versions",
  "payroll_meal_allowance_eligibility_versions",
  "payroll_meal_allowance_policy_versions",
  "employee_level_program_versions",
];

test("cleanup migration file exists at the expected sequential timestamp and is transactional", () => {
  assert.match(migration, /^begin;$/m);
  assert.match(migration.trimEnd(), /commit;$/);
});

test("cleanup migration never uses CASCADE as part of an actual DROP statement (verifies dependency-free removal, not a forced one) — mentioning it in a comment explaining its absence is fine", () => {
  assert.doesNotMatch(migration, /drop\s+(table|function)[^;\n]*\bcascade\b/i);
});

for (const fn of LEGACY_FUNCTIONS) {
  test(`cleanup migration drops ${fn.name} with its exact production signature (no CASCADE, no ambiguous overload)`, () => {
    const escapedArgs = fn.args.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`drop function public\\.${fn.name}\\(${escapedArgs}\\);`);
    assert.match(migration, pattern);
  });
}

test("cleanup migration drops all 21 legacy RPCs exactly once each, none touched twice", () => {
  for (const fn of LEGACY_FUNCTIONS) {
    const count = (migration.match(new RegExp(`drop function public\\.${fn.name}\\(`, "g")) ?? []).length;
    assert.equal(count, 1, `${fn.name} should be dropped exactly once`);
  }
});

test("cleanup migration drops the 5 legacy tables in child-to-parent order (FK-safe, no CASCADE needed)", () => {
  const indices = LEGACY_TABLES_IN_DROP_ORDER.map((table) => {
    const index = migration.indexOf(`drop table public.${table};`);
    assert.ok(index > -1, `expected to find "drop table public.${table};"`);
    return index;
  });
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i - 1] < indices[i], `${LEGACY_TABLES_IN_DROP_ORDER[i - 1]} must be dropped before ${LEGACY_TABLES_IN_DROP_ORDER[i]}`);
  }
});

test("cleanup migration touches no other table/function — only the 5 legacy tables and 21 legacy RPCs", () => {
  const dropTableMatches = [...migration.matchAll(/drop table public\.(\w+);/g)].map((m) => m[1]);
  assert.deepEqual(new Set(dropTableMatches), new Set(LEGACY_TABLES_IN_DROP_ORDER));
  const dropFunctionMatches = [...migration.matchAll(/drop function public\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(new Set(dropFunctionMatches), new Set(LEGACY_FUNCTIONS.map((fn) => fn.name)));
});

test("cleanup migration never creates, alters, or drops the current payroll payment ledger or any other history table (Phase 1-A scope discipline)", () => {
  for (const protectedName of PROTECTED_OBJECTS) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(create|create or replace|alter|drop)\\s+(table|function)\\s+public\\.${protectedName}\\b`, "i"),
    );
  }
});

test("cleanup migration adds no new table, function, trigger, or view — pure removal only", () => {
  assert.doesNotMatch(migration, /create\s+(table|function|trigger|view|or replace function)/i);
});
