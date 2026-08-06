import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/202608060003_payroll_owner_by_role.sql"),
  "utf8"
);
const v7Engine = readFileSync(
  join(process.cwd(), "supabase/migrations/202608020002_add_unified_payroll_engine_v7.sql"),
  "utf8"
);

const extractFunctionBody = (source: string, signaturePrefix: string) => {
  const start = source.indexOf(signaturePrefix);
  assert.ok(start > -1, `expected to find ${signaturePrefix}`);
  const end = source.indexOf("end $$;", start);
  assert.ok(end > start, `expected a closing "end $$;" after ${signaturePrefix}`);
  return source.slice(start, end + "end $$;".length);
};

test("migration adds the new owner-by-role RPC versions with the expected signatures", () => {
  assert.match(sql, /create or replace function public\.payroll_create_contract_version_v5\(/);
  assert.match(sql, /create or replace function public\.payroll_correct_latest_unused_contract_v3\(/);
});

test("the new functions query role (not position) to decide owner treatment", () => {
  const v5Start = sql.indexOf("create or replace function public.payroll_create_contract_version_v5(");
  const v5End = sql.indexOf("$$;", v5Start);
  const v5Body = sql.slice(v5Start, v5End);
  assert.match(v5Body, /select lower\(coalesce\(role,''\)\) into v_role from public\.users/);
  assert.match(v5Body, /if v_role in \('owner','master'\) then/);
  assert.doesNotMatch(v5Body, /coalesce\(position/);

  const v3CorrectStart = sql.indexOf("create or replace function public.payroll_correct_latest_unused_contract_v3(");
  const v3CorrectEnd = sql.indexOf("$$;", v3CorrectStart);
  const v3CorrectBody = sql.slice(v3CorrectStart, v3CorrectEnd);
  assert.match(v3CorrectBody, /select lower\(coalesce\(role,''\)\) into v_role from public\.users/);
  assert.match(v3CorrectBody, /if v_role in \('owner','master'\) then v_minutes:=540;v_basis:='fixed_monthly';/);
  assert.doesNotMatch(v3CorrectBody, /coalesce\(position/);
});

test("owner/master both take the fixed_monthly/540-minute/no-schedule-required branch", () => {
  assert.match(sql, /540,1,'none','ignore','ignore','ignore','unpaid'/);
  assert.match(sql, /v_minutes:=540;v_basis:='fixed_monthly';/);
});

test("existing v1-v4 functions are not dropped or replaced (rollback stays available)", () => {
  assert.doesNotMatch(sql, /drop function/i);
  assert.doesNotMatch(sql, /create or replace function public\.payroll_create_contract_version_v4/);
  assert.doesNotMatch(sql, /create or replace function public\.payroll_correct_latest_unused_contract_v2/);
  // preflight only reads/asserts that v1-v4 still exist; it must not touch them.
  assert.match(sql, /to_regprocedure\('public\.payroll_create_contract_version_v4\(/);
  assert.match(sql, /to_regprocedure\('public\.payroll_correct_latest_unused_contract_v2\(/);
});

test("migration performs no data mutation — only function DDL", () => {
  assert.doesNotMatch(sql, /\bupdate\s+public\./i);
  assert.doesNotMatch(sql, /\binsert\s+into\s+public\./i);
  assert.doesNotMatch(sql, /\bdelete\s+from\s+public\./i);
});

test("migration runs inside a single transaction with permission grants matching existing payroll RPC conventions", () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.match(sql, /revoke all on function public\.payroll_create_contract_version_v5[\s\S]{0,120}from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.payroll_create_contract_version_v5[\s\S]{0,120}to service_role;/);
  assert.match(sql, /revoke all on function public\.payroll_correct_latest_unused_contract_v3[\s\S]{0,200}from public,anon,authenticated;/);
  assert.match(sql, /grant execute on function public\.payroll_correct_latest_unused_contract_v3[\s\S]{0,200}to service_role;/);
});

test("v5's language/security/search_path declaration is byte-identical to v4's", () => {
  const v4Header = v7Engine.slice(
    v7Engine.indexOf("create or replace function public.payroll_create_contract_version_v4("),
    v7Engine.indexOf("as $$", v7Engine.indexOf("create or replace function public.payroll_create_contract_version_v4(")) + "as $$".length
  ).replace("payroll_create_contract_version_v4", "payroll_create_contract_version_v5");
  const v5Header = sql.slice(
    sql.indexOf("create or replace function public.payroll_create_contract_version_v5("),
    sql.indexOf("as $$", sql.indexOf("create or replace function public.payroll_create_contract_version_v5(")) + "as $$".length
  );
  assert.equal(v5Header, v4Header);

  const v2Header = v7Engine.slice(
    v7Engine.indexOf("create or replace function public.payroll_correct_latest_unused_contract_v2("),
    v7Engine.indexOf("as $$", v7Engine.indexOf("create or replace function public.payroll_correct_latest_unused_contract_v2(")) + "as $$".length
  ).replace("payroll_correct_latest_unused_contract_v2", "payroll_correct_latest_unused_contract_v3");
  const v3CorrectHeader = sql.slice(
    sql.indexOf("create or replace function public.payroll_correct_latest_unused_contract_v3("),
    sql.indexOf("as $$", sql.indexOf("create or replace function public.payroll_correct_latest_unused_contract_v3(")) + "as $$".length
  );
  assert.equal(v3CorrectHeader, v2Header);
});

test("v5's function body is v4's body with only the owner column/condition swapped — everything else (including the manager/leader/staff branch) is untouched", () => {
  const v4Body = extractFunctionBody(
    v7Engine,
    "create or replace function public.payroll_create_contract_version_v4("
  );
  const v5Body = extractFunctionBody(
    sql,
    "create or replace function public.payroll_create_contract_version_v5("
  );

  const v4BodyAsV5 = v4Body
    .replace(/payroll_create_contract_version_v4/g, "payroll_create_contract_version_v5")
    .replace(/v_position/g, "v_role")
    .replace(/coalesce\(position,''\)/g, "coalesce(role,'')")
    .replace(/v_role='owner'/g, "v_role in ('owner','master')");

  assert.equal(v5Body, v4BodyAsV5);
});

test("v3-correct's function body is v2's body with only the owner column/condition swapped — everything else (including the manager/leader/staff branch) is untouched", () => {
  const v2Body = extractFunctionBody(
    v7Engine,
    "create or replace function public.payroll_correct_latest_unused_contract_v2("
  );
  const v3CorrectBody = extractFunctionBody(
    sql,
    "create or replace function public.payroll_correct_latest_unused_contract_v3("
  );

  const v2BodyAsV3 = v2Body
    .replace(/payroll_correct_latest_unused_contract_v2/g, "payroll_correct_latest_unused_contract_v3")
    .replace(/v_position/g, "v_role")
    .replace(/coalesce\(position,''\)/g, "coalesce(role,'')")
    // v2 references the owner check twice: the branch condition and the case-when
    // for the late-adjustment mode passed to v1. Both must swap identically.
    .replace(/v_role='owner'/g, "v_role in ('owner','master')");

  assert.equal(v3CorrectBody, v2BodyAsV3);
});

test("v5/v3 (this migration's own RPCs) remain the ones payroll_create_contract_version_v6/payroll_correct_latest_unused_contract_v4 wrap internally — this migration file itself is untouched by the later fixed-monthly-by-attendance-tracking migration", () => {
  const laterMigration = readFileSync(
    join(process.cwd(), "supabase/migrations/202608070002_payroll_fixed_monthly_by_attendance_tracking.sql"),
    "utf8",
  );
  assert.match(laterMigration, /payroll_create_contract_version_v3\(/);
  assert.doesNotMatch(laterMigration, /create or replace function public\.payroll_create_contract_version_v5/);
  assert.doesNotMatch(laterMigration, /create or replace function public\.payroll_correct_latest_unused_contract_v3/);
});

test("app/api routes now call the newer v6/v4 RPC names (payroll_create_contract_version_v6 / payroll_correct_latest_unused_contract_v4), added by 202608070002 to support attendance-tracking-disabled staff — v5/v3/v4/v2 are no longer referenced by application code, only kept in the DB for rollback", () => {
  const createRoute = readFileSync(
    join(process.cwd(), "app/api/admin/payroll/contracts/route.ts"),
    "utf8"
  );
  const correctRoute = readFileSync(
    join(process.cwd(), "app/api/admin/payroll/contracts/correct/route.ts"),
    "utf8"
  );
  assert.match(createRoute, /rpc\("payroll_create_contract_version_v6"/);
  assert.doesNotMatch(createRoute, /payroll_create_contract_version_v5|payroll_create_contract_version_v4/);
  assert.match(correctRoute, /rpc\("payroll_correct_latest_unused_contract_v4"/);
  assert.doesNotMatch(correctRoute, /payroll_correct_latest_unused_contract_v3|payroll_correct_latest_unused_contract_v2/);
});
