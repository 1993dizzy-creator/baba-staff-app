import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/202607240003_fix_attendance_cancellation_audit.sql"
);
const route = read("app/api/attendance/admin/route.ts");

test("audit action check retains legacy actions and adds all cancellation actions", () => {
  for (const action of [
    "manual_update",
    "normalize_late",
    "normalize_early_leave",
    "auto_close",
    "policy_recalculation",
    "cancel_check_in",
    "cancel_check_out",
    "cancel_leave",
  ]) {
    assert.match(migration, new RegExp(`'${action}'`));
  }
});

test("deleted attendance records keep immutable audit identity and target context", () => {
  assert.match(
    migration,
    /alter column attendance_record_id drop not null/
  );
  assert.match(migration, /on delete set null/);
  assert.match(migration, /source_attendance_record_id bigint null/);
  assert.match(
    migration,
    /target_user_id bigint not null references public\.users\(id\)/
  );
  assert.match(migration, /work_date date not null/);
  assert.match(
    migration,
    /v_record\.id,\s*v_record\.id,\s*v_record\.user_id,\s*v_record\.work_date/
  );
});

test("RPC locks the current row and atomically audits each cancellation", () => {
  assert.match(
    migration,
    /create or replace function public\.attendance_admin_cancel_record_v1/
  );
  assert.match(migration, /for update/);
  assert.match(migration, /v_before_snapshot := to_jsonb\(v_record\)/);
  assert.match(
    migration,
    /p_action = 'cancel_check_in'[\s\S]*insert into public\.attendance_record_audit_logs[\s\S]*delete from public\.attendance_records/
  );
  assert.match(
    migration,
    /p_action = 'cancel_leave'[\s\S]*v_record\.is_staff_direct_leave is not true[\s\S]*insert into public\.attendance_record_audit_logs[\s\S]*delete from public\.attendance_records/
  );
  assert.match(
    migration,
    /update public\.attendance_records[\s\S]*check_out_at = null[\s\S]*work_minutes = null[\s\S]*early_leave_minutes = 0[\s\S]*returning \* into v_after[\s\S]*to_jsonb\(v_after\)/
  );
  assert.match(migration, /p_actor_user_id/);
  assert.match(migration, /nullif\(btrim\(p_reason\), ''\)/);
});

test("state conflicts return before mutation and audit insertion", () => {
  assert.match(
    migration,
    /if not found then\s*return jsonb_build_object\('status', 'record_changed'\)/
  );
  assert.match(
    migration,
    /if v_record\.check_in_at is null[\s\S]*return jsonb_build_object\([\s\S]*'check_out_cannot_be_cancelled'[\s\S]*end if;\s*update public\.attendance_records/
  );
  assert.doesNotMatch(
    migration,
    /where user_id\s*<>\s*p_target_user_id|work_date\s*<>\s*p_work_date/
  );
});

test("RPC and audit table remain service-role only", () => {
  assert.match(migration, /security invoker/);
  assert.match(migration, /set search_path = pg_catalog, public/);
  assert.match(
    migration,
    /revoke all on function public\.attendance_admin_cancel_record_v1\([\s\S]*from public, anon, authenticated/
  );
  assert.match(
    migration,
    /grant execute on function public\.attendance_admin_cancel_record_v1\([\s\S]*to service_role/
  );
  assert.doesNotMatch(
    migration,
    /grant .*attendance_record_audit_logs.*(?:anon|authenticated)/i
  );
});

test("admin API passes only the server-session actor to the cancellation RPC", () => {
  assert.match(route, /\.rpc\("attendance_admin_cancel_record_v1"/);
  assert.match(route, /p_action: action/);
  assert.match(route, /p_target_user_id: Number\(user_id\)/);
  assert.match(route, /p_work_date: work_date/);
  assert.match(route, /p_actor_user_id: auth\.actor\.id/);
  assert.doesNotMatch(route, /p_actor_user_id:\s*body/);
});

test("postflight verifies FK behavior, nullability, and unchanged empty audit count", () => {
  assert.match(migration, /column_name = 'attendance_record_id'/);
  assert.match(migration, /v_is_nullable <> 'YES'/);
  assert.match(migration, /v_delete_rule <> 'SET NULL'/);
  assert.match(migration, /select count\(\*\)[\s\S]*from public\.attendance_record_audit_logs/);
  assert.match(migration, /v_log_count <> 0/);
});
