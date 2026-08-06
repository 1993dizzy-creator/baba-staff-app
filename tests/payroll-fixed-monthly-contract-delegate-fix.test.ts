import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MIGRATION_PATH = "supabase/migrations/202608070003_fix_fixed_monthly_contract_delegate.sql";
const sql = readFileSync(join(process.cwd(), MIGRATION_PATH), "utf8");
const v2CreateMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/202607300001_add_payroll_compensation_and_adjustment_ledger.sql"),
  "utf8",
);
const v1CorrectMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/202608020001_correct_latest_unused_payroll_contract.sql"),
  "utf8",
);
const v3CreateMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/202608010003_add_fixed_monthly_payroll_basis.sql"),
  "utf8",
);
const createRoute = readFileSync(join(process.cwd(), "app/api/admin/payroll/contracts/route.ts"), "utf8");
const correctRoute = readFileSync(join(process.cwd(), "app/api/admin/payroll/contracts/correct/route.ts"), "utf8");
const contractErrors = readFileSync(join(process.cwd(), "lib/payroll/contract-errors.ts"), "utf8");

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

test("this migration's filename is unique and sorts after 202608070002 (no accidental ordering collision)", () => {
  const files = readdirSync(join(process.cwd(), "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  const target = "202608070003_fix_fixed_monthly_contract_delegate.sql";
  assert.equal(files.filter((name) => name === target).length, 1);
  const index = files.indexOf(target);
  for (const earlier of files.slice(0, index)) assert.ok(earlier < target);
});

test("preflight requires v6/v4/v2-create/v1-correct to already exist, core_v2 to not exist yet, and asserts v6/v4 still carry the known-buggy v3/v1 delegate before patching", () => {
  const preflight = sql.slice(0, sql.indexOf("-- 1. payroll_correct_latest_unused_contract_core_v2"));
  assert.match(preflight, /payroll_create_contract_version_v6\(bigint,text,numeric,numeric,numeric,date,bigint,text\)/);
  assert.match(preflight, /payroll_correct_latest_unused_contract_v4\(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text\)/);
  assert.match(preflight, /payroll_create_contract_version_v2\(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text\)/);
  assert.match(preflight, /payroll_correct_latest_unused_contract_v1\(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text\)/);
  assert.match(preflight, /to_regprocedure\('public\.payroll_correct_latest_unused_contract_core_v2\([^)]+\)'\) is not null then/);
  assert.match(preflight, /position\('return public\.payroll_create_contract_version_v3\(p_user_id,''monthly'',''fixed_monthly''' in v_v6_def\) = 0/);
  assert.match(preflight, /position\('return public\.payroll_correct_latest_unused_contract_v1\(' in v_v4_def\) = 0/);
});

test("payroll_create_contract_version_v6's fixed-monthly branch now calls v2 directly with fully policy-neutral, hardcoded fixed-monthly parameters — not v3", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  assert.match(
    v6Body,
    /return public\.payroll_create_contract_version_v2\(p_user_id,'monthly','fixed_monthly',p_base_salary,p_fixed_raise_amount,p_standard_workdays,540,1,'none','ignore','ignore','ignore','unpaid',p_effective_from,p_actor_user_id,p_note\);/,
  );
  assert.doesNotMatch(v6Body, /payroll_create_contract_version_v3\(p_user_id,'monthly','fixed_monthly'/);
  // the non-fixed-monthly (attendance-tracking-enabled) branch must still go through v3/minute — untouched.
  assert.match(v6Body, /payroll_create_contract_version_v3\(p_user_id,p_pay_type,'minute'/);
});

test("payroll_create_contract_version_v6 validates day-of-month=1 for the fixed-monthly branch itself before delegating (v3 never had this check for create)", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const fixedMonthlyBranch = v6Body.slice(v6Body.indexOf("if v_is_fixed_monthly_target then"), v6Body.indexOf("payroll_create_contract_version_v2("));
  assert.match(fixedMonthlyBranch, /extract\(day from p_effective_from\) <> 1/);
  assert.match(fixedMonthlyBranch, /invalid_fixed_monthly_effective_date/);
  assert.doesNotMatch(v3CreateMigration, /invalid_fixed_monthly_effective_date/, "sanity check: v3-create never had this validation, so v6 must supply it itself");
});

test("payroll_correct_latest_unused_contract_v4 now calls core_v2 instead of v1, with the identical argument list it already built", () => {
  const oldV4Call = "return public.payroll_correct_latest_unused_contract_v1(p_contract_id,p_user_id,p_expected_revision,p_expected_audit_log_id,p_expected_effective_from,p_pay_type,v_basis,p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore',case when v_is_fixed_monthly_target then 'ignore' else 'requires_approval' end,'unpaid',p_effective_from,p_actor_user_id,p_note,p_reason);";
  const newV4Call = oldV4Call.replace("payroll_correct_latest_unused_contract_v1", "payroll_correct_latest_unused_contract_core_v2");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  assert.doesNotMatch(v4Body, /payroll_correct_latest_unused_contract_v1\(/);
  assert.match(v4Body, new RegExp(newV4Call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("v6/v4's is_fixed_monthly_target formula and actor/lock pattern are unchanged from 202608070002 — only the delegate target changed", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  for (const body of [v6Body, v4Body]) {
    assert.match(body, /perform public\.payroll_assert_actor_v2\(p_actor_user_id\);/);
    assert.match(body, /perform pg_advisory_xact_lock\(p_user_id\);/);
    assert.match(body, /select lower\(coalesce\(role,''\)\), attendance_tracking_enabled\s*\n\s*into v_role, v_attendance_tracking_enabled\s*\n\s*from public\.users/);
    assert.match(body, /v_is_fixed_monthly_target := v_role in \('owner','master'\) or v_attendance_tracking_enabled = false;/);
  }
});

test("neither v6 nor v4 assigns to users.role or grants owner privileges, and neither creates a fake employee_work_schedule_versions row", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  for (const body of [v6Body, v4Body]) {
    assert.doesNotMatch(body, /update public\.users/);
    assert.doesNotMatch(body, /role\s*=\s*'owner'/);
    assert.doesNotMatch(body, /set\s+role/i);
    assert.doesNotMatch(body, /insert into public\.employee_work_schedule_versions/);
  }
});

test("the new core_v2 correction function reuses v1's revision-conflict/latest-contract/payroll-lock/period-conflict/audit-log logic verbatim, only the position='owner' gate is replaced by a generic fixed_monthly<->monthly + day-1 check", () => {
  const v1Body = extractFunctionBody(v1CorrectMigration, "create or replace function public.payroll_correct_latest_unused_contract_v1(");
  const coreBody = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_core_v2(");

  // shared tail: everything from the advisory lock onward must be byte-identical except the function name.
  const v1Tail = v1Body.slice(v1Body.indexOf("perform pg_advisory_xact_lock(p_user_id);"));
  const coreTail = coreBody.slice(coreBody.indexOf("perform pg_advisory_xact_lock(p_user_id);"));
  assert.equal(coreTail, v1Tail.replace(/payroll_correct_latest_unused_contract_v1/g, "payroll_correct_latest_unused_contract_core_v2"));

  // the old position='owner'-gated block must be gone from the core.
  assert.doesNotMatch(coreBody, /v_position/);
  assert.doesNotMatch(coreBody, /coalesce\(position/);
  assert.doesNotMatch(coreBody, /fixed_monthly_owner_only|invalid_owner_pay_basis/);

  // replaced by a policy-neutral, basis-driven check.
  assert.match(coreBody, /if p_calculation_basis = 'fixed_monthly' and p_pay_type <> 'monthly' then/);
  assert.match(coreBody, /if p_calculation_basis = 'fixed_monthly' and extract\(day from p_effective_from\) <> 1 then/);
  assert.match(coreBody, /invalid_fixed_monthly_effective_date/);
});

test("core_v2 still requires the actor to be owner/master and the target user to exist and be active", () => {
  const coreBody = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_core_v2(");
  assert.match(coreBody, /where id = p_actor_user_id and is_active = true and role in \('owner', 'master'\);/);
  assert.match(coreBody, /return jsonb_build_object\('status', 'forbidden'\); end if;/);
  assert.match(coreBody, /where id = p_user_id and is_active = true and is_system_account = false;/);
  assert.match(coreBody, /return jsonb_build_object\('status', 'user_not_found'\); end if;/);
});

test("v2-create (the new create delegate) is untouched and remains policy-neutral: no owner/position check anywhere in its body", () => {
  const v2Body = extractFunctionBody(v2CreateMigration, "create or replace function public.payroll_create_contract_version_v2(");
  assert.doesNotMatch(v2Body, /position/);
  assert.doesNotMatch(v2Body, /fixed_monthly/);
  assert.doesNotMatch(v2Body, /v_position = 'owner'|v_role = 'owner'|position = 'owner'/);
  assert.match(v2Body, /insert into public\.payroll_contract_versions/);
  assert.match(v2Body, /insert into public\.payroll_contract_audit_logs/);
});

test("attendance-tracking-enabled (non-fixed-monthly) staff can never reach a fixed_monthly basis through v6/v4: both branches hardcode the basis themselves regardless of caller input", () => {
  const v6Body = extractFunctionBody(sql, "create or replace function public.payroll_create_contract_version_v6(");
  const v4Body = extractFunctionBody(sql, "create or replace function public.payroll_correct_latest_unused_contract_v4(");
  // the else-branch always passes the literal 'minute', never a caller-controlled calculation_basis.
  assert.match(v6Body, /payroll_create_contract_version_v3\(p_user_id,p_pay_type,'minute',/);
  assert.match(v4Body, /v_basis:='minute';/);
});

test("migration performs no data mutation — only function DDL", () => {
  assert.doesNotMatch(sql, /\bupdate\s+public\.(?!payroll_contract_versions set)/i);
  assert.doesNotMatch(sql, /\binsert\s+into\s+public\.(?!payroll_contract_audit_logs)/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+public\./i);
});

test("grants: core_v2/v6/v4 are revoked from public/anon/authenticated and granted only to service_role", () => {
  assert.match(sql, /revoke all on function public\.payroll_correct_latest_unused_contract_core_v2\([^)]+\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.payroll_correct_latest_unused_contract_core_v2\([^)]+\) to service_role;/);
  assert.match(sql, /revoke all on function public\.payroll_create_contract_version_v6\(bigint,text,numeric,numeric,numeric,date,bigint,text\) from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.payroll_create_contract_version_v6\(bigint,text,numeric,numeric,numeric,date,bigint,text\) to service_role;/);
  assert.match(sql, /revoke all on function public\.payroll_correct_latest_unused_contract_v4\(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text\) from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.payroll_correct_latest_unused_contract_v4\(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text\) to service_role;/);
});

test("no function is dropped, and v1-v5-create/v1-v3-correct remain untouched by this migration (only v6/v4 are re-created; core_v2 is new)", () => {
  assert.doesNotMatch(sql, /drop function/i);
  for (const untouched of [
    "create or replace function public.payroll_create_contract_version_v1",
    "create or replace function public.payroll_create_contract_version_v2",
    "create or replace function public.payroll_create_contract_version_v3",
    "create or replace function public.payroll_create_contract_version_v4",
    "create or replace function public.payroll_create_contract_version_v5",
    "create or replace function public.payroll_correct_latest_unused_contract_v1",
    "create or replace function public.payroll_correct_latest_unused_contract_v2",
    "create or replace function public.payroll_correct_latest_unused_contract_v3",
  ]) assert.doesNotMatch(sql, new RegExp(untouched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\("));
});

test("prior migration files are byte-for-byte untouched (git diff would show only the new file)", () => {
  assert.match(v2CreateMigration, /create or replace function public\.payroll_create_contract_version_v2\(/);
  assert.match(v1CorrectMigration, /create or replace function public\.payroll_correct_latest_unused_contract_v1\(/);
  assert.match(v3CreateMigration, /elsif p_calculation_basis = 'fixed_monthly' then\s*\n\s*return jsonb_build_object\('status', 'fixed_monthly_owner_only'\);/);
});

test("create-route error mapping: invalid_fixed_monthly_effective_date maps to the uppercase code with a translated message, not a generic fallback", () => {
  assert.match(createRoute, /result\.status === "invalid_fixed_monthly_effective_date"/);
  assert.match(createRoute, /code: "INVALID_FIXED_MONTHLY_EFFECTIVE_DATE" \}, 400\);/);
  assert.match(contractErrors, /INVALID_FIXED_MONTHLY_EFFECTIVE_DATE:/);
});

test("correct-route already maps invalid_fixed_monthly_effective_date explicitly (parity check, unchanged by this hotfix)", () => {
  assert.match(correctRoute, /invalid_fixed_monthly_effective_date: \{ code: "INVALID_FIXED_MONTHLY_EFFECTIVE_DATE", http: 400 \},/);
});

test("both API routes still call the v6/v4 RPC names — this hotfix changes what those functions do internally, not which RPC the app calls", () => {
  assert.match(createRoute, /rpc\("payroll_create_contract_version_v6"/);
  assert.match(correctRoute, /rpc\("payroll_correct_latest_unused_contract_v4"/);
});
