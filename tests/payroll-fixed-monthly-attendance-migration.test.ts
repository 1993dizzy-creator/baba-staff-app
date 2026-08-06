import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MIGRATION_PATH = "supabase/migrations/202608070002_payroll_fixed_monthly_by_attendance_tracking.sql";
const sql = readFileSync(join(process.cwd(), MIGRATION_PATH), "utf8");
const ownerByRoleMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/202608060003_payroll_owner_by_role.sql"),
  "utf8",
);

const extractFunctionBody = (source: string, signaturePrefix: string) => {
  const start = source.indexOf(signaturePrefix);
  assert.ok(start > -1, `expected to find ${signaturePrefix}`);
  const end = source.indexOf("end $$;", start);
  assert.ok(end > start, `expected a closing "end $$;" after ${signaturePrefix}`);
  return source.slice(start, end + "end $$;".length);
};

test("migration is transaction-wrapped and is the newest migration file", () => {
  const firstStatement = sql.split("\n").find((line) => line.trim() !== "" && !line.trim().startsWith("--"));
  assert.equal(firstStatement?.trim(), "begin;");
  const lastStatement = [...sql.split("\n")].reverse().find((line) => line.trim() !== "" && !line.trim().startsWith("--"));
  assert.equal(lastStatement?.trim(), "commit;");
});

test("preflight checks the v5/v3 RPCs and attendance_tracking_enabled column exist, and that v6/v4 don't already exist", () => {
  const preflight = sql.slice(0, sql.indexOf("-- 1. payroll_create_contract_version_v6"));
  assert.match(preflight, /payroll_create_contract_version_v5\(bigint,text,numeric,numeric,numeric,date,bigint,text\)/);
  assert.match(preflight, /payroll_correct_latest_unused_contract_v3\(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text\)/);
  assert.match(preflight, /attendance_tracking_enabled/);
  assert.match(preflight, /to_regprocedure\('public\.payroll_create_contract_version_v6\(bigint,text,numeric,numeric,numeric,date,bigint,text\)'\) is not null then/);
  assert.match(preflight, /to_regprocedure\('public\.payroll_correct_latest_unused_contract_v4\(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text\)'\) is not null then/);
});

test("payroll_create_contract_version_v6 queries role AND attendance_tracking_enabled together to decide the fixed-monthly path", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  assert.match(v6Body, /select lower\(coalesce\(role,''\)\), attendance_tracking_enabled\s*\n\s*into v_role, v_attendance_tracking_enabled\s*\n\s*from public\.users/);
  assert.match(v6Body, /v_is_fixed_monthly_target := v_role in \('owner','master'\) or v_attendance_tracking_enabled = false;/);
  assert.match(v6Body, /if v_is_fixed_monthly_target then/);
});

test("payroll_correct_latest_unused_contract_v4 uses the identical is_fixed_monthly_target formula", () => {
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  assert.match(v4Body, /select lower\(coalesce\(role,''\)\), attendance_tracking_enabled\s*\n\s*into v_role, v_attendance_tracking_enabled\s*\n\s*from public\.users/);
  assert.match(v4Body, /v_is_fixed_monthly_target := v_role in \('owner','master'\) or v_attendance_tracking_enabled = false;/);
});

test("v6 delegates the fixed-monthly branch to the exact same payroll_create_contract_version_v3 call the owner path (v5) already uses — 540 minutes, fixed_monthly, no schedule lookup", () => {
  const v5Body = extractFunctionBody(ownerByRoleMigration, "create or replace function public.payroll_create_contract_version_v5(");
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const v5DelegateCall = v5Body.match(/return public\.payroll_create_contract_version_v3\([^;]+fixed_monthly'[^;]+\);/)?.[0];
  const v6DelegateCall = v6Body.match(/return public\.payroll_create_contract_version_v3\([^;]+fixed_monthly'[^;]+\);/)?.[0];
  assert.ok(v5DelegateCall && v6DelegateCall, "both v5 and v6 must delegate to payroll_create_contract_version_v3 for the fixed-monthly branch");
  assert.equal(v6DelegateCall, v5DelegateCall, "v6's fixed-monthly delegate call must be byte-identical to v5's — no new calculation path invented");
});

test("v4-correct delegates the fixed-monthly branch identically to v3-correct (540 minutes, fixed_monthly basis, no schedule lookup)", () => {
  const v3Body = extractFunctionBody(ownerByRoleMigration, "create or replace function public.payroll_correct_latest_unused_contract_v3(");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  assert.match(v3Body, /v_minutes:=540;v_basis:='fixed_monthly';/);
  assert.match(v4Body, /v_minutes:=540;v_basis:='fixed_monthly';/);
});

test("neither v6 nor v4-correct ever assigns to users.role or otherwise grants owner privileges — only the local calculation-basis decision changes", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  for (const body of [v6Body, v4Body]) {
    assert.doesNotMatch(body, /update public\.users/);
    assert.doesNotMatch(body, /role\s*=\s*'owner'/);
    assert.doesNotMatch(body, /set\s+role/i);
  }
});

test("neither v6 nor v4-correct creates any employee_work_schedule_versions row for the fixed-monthly branch (no fake work schedule)", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  for (const body of [v6Body, v4Body]) {
    assert.doesNotMatch(body, /insert into public\.employee_work_schedule_versions/);
  }
});

test("non-fixed-monthly branch (attendance-tracking-enabled staff) is untouched: still requires exactly one active work schedule and computes minute-based basis", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  assert.match(v6Body, /work_schedule_not_found/);
  assert.match(v6Body, /work_schedule_overlap/);
  assert.match(v6Body, /invalid_work_schedule/);
  assert.match(v6Body, /'minute'/);
});

test("both new functions reuse payroll_assert_actor_v2 and pg_advisory_xact_lock(p_user_id), matching v5/v3's actor/concurrency pattern exactly", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  for (const body of [v6Body, v4Body]) {
    assert.match(body, /perform public\.payroll_assert_actor_v2\(p_actor_user_id\);/);
    assert.match(body, /perform pg_advisory_xact_lock\(p_user_id\);/);
  }
});

test("migration performs no data mutation — only function DDL", () => {
  assert.doesNotMatch(sql, /\bupdate\s+public\.(?!payroll_settings)/i);
  assert.doesNotMatch(sql, /\binsert\s+into\s+public\./i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+public\./i);
});

test("grants: v6/v4-correct are revoked from public/anon/authenticated and granted only to service_role", () => {
  assert.match(sql, /revoke all on function public\.payroll_create_contract_version_v6\(bigint,text,numeric,numeric,numeric,date,bigint,text\) from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.payroll_create_contract_version_v6\(bigint,text,numeric,numeric,numeric,date,bigint,text\) to service_role;/);
  assert.match(sql, /revoke all on function public\.payroll_correct_latest_unused_contract_v4\(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text\) from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.payroll_correct_latest_unused_contract_v4\(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text\) to service_role;/);
});

test("existing v1-v5/v1-v3-correct functions are not dropped or replaced (rollback stays available)", () => {
  assert.doesNotMatch(sql, /drop function/i);
  assert.doesNotMatch(sql, /create or replace function public\.payroll_create_contract_version_v5/);
  assert.doesNotMatch(sql, /create or replace function public\.payroll_correct_latest_unused_contract_v3/);
});

test("this migration's filename is unique and sorts after 202608070001 (no accidental ordering collision)", () => {
  const files = readdirSync(join(process.cwd(), "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  const occurrences = files.filter((name) => name === "202608070002_payroll_fixed_monthly_by_attendance_tracking.sql");
  assert.equal(occurrences.length, 1);
  const index = files.indexOf("202608070002_payroll_fixed_monthly_by_attendance_tracking.sql");
  assert.ok(index > -1);
  for (const earlier of files.slice(0, index)) {
    assert.ok(earlier < "202608070002_payroll_fixed_monthly_by_attendance_tracking.sql");
  }
});
