import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260909231222_fix_contract_correction_payment_snapshot.sql"),
  "utf8",
);
const route = readFileSync(join(process.cwd(), "app/api/admin/payroll/contracts/correct/route.ts"), "utf8");

test("contract correction keeps the existing v4 API contract", () => {
  assert.match(route, /rpc\("payroll_correct_latest_unused_contract_v4"/);
  assert.match(route, /p_expected_revision: expectedRevision/);
  assert.match(route, /p_expected_audit_log_id: expectedAuditVersion/);
});

test("contract correction no longer reads deleted payroll_run tables", () => {
  for (const table of ["payroll_runs", "payroll_run_employees", "payroll_run_items", "payroll_run_reviews", "payroll_run_audit_logs"]) {
    assert.doesNotMatch(migration, new RegExp(`from public\\.${table}\\b|join public\\.${table}\\b`));
  }
});

test("current and audited paid snapshots lock a used contract", () => {
  assert.match(migration, /from public\.payroll_employee_payments employee/);
  assert.match(migration, /join public\.payroll_payment_batches batch/);
  assert.match(migration, /employee\.payment_status = 'paid'/);
  assert.match(migration, /employee\.calculation_snapshot is not null/);
  assert.match(migration, /from public\.payroll_payment_audit_logs audit/);
  assert.match(migration, /audit\.action in \('employee_paid', 'employee_payment_cancelled'\)/);
  assert.match(migration, /audit\.before_snapshot->'calculation_snapshot'/);
  assert.match(migration, /@\.id == \$contractId && @\.revision == \$revision/);
  assert.match(migration, /locked_payroll_contract/);
});

test("latest-contract and optimistic revision protections remain", () => {
  assert.match(migration, /v_contract\.revision <> p_expected_revision/);
  assert.match(migration, /v_latest_audit_log_id is distinct from p_expected_audit_log_id/);
  assert.match(migration, /if v_latest_id <> v_contract\.id then return jsonb_build_object\('status', 'not_latest_contract'\)/);
  assert.match(migration, /where id = v_contract\.id and revision = p_expected_revision/);
  assert.match(migration, /return jsonb_build_object\('status', 'corrected'/);
});

test("security-definer privileges remain service-role only", () => {
  assert.match(migration, /security definer\s+set search_path = public/);
  assert.match(migration, /revoke all on function[\s\S]+from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function[\s\S]+to service_role;/);
});
