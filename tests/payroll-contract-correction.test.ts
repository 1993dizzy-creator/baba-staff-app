import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { payrollContractErrorMessage } from "../lib/payroll/contract-errors.ts";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculatePayrollRates } from "../lib/payroll/work-policy.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/202608020001_correct_latest_unused_payroll_contract.sql");
const v7Migration = read("supabase/migrations/202608020002_add_unified_payroll_engine_v7.sql");
const route = read("app/api/admin/payroll/contracts/correct/route.ts");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
const modal = read("components/payroll/PayrollModal.tsx");

test("hourly contract labels and help are bilingual while monthly and daily labels remain explicit", () => {
  for (const copy of [
    "월 계약급여", "일급", "시급",
    "Lương hợp đồng hàng tháng", "Lương theo ngày", "Lương theo giờ",
    "1시간 기준 급여를 입력합니다. 예: 30,000동 입력 시 시급 30,000동으로 계산됩니다.",
    "Nhập mức lương cho 1 giờ. Ví dụ: nhập 30.000 đồng thì sẽ được tính là 30.000 đồng/giờ.",
    "현재 근무시간", "Giờ làm việc hiện tại",
    "급여 계산에는 날짜별 근무시간이 자동 적용됩니다.",
    "Giờ làm việc theo từng ngày được tự động áp dụng khi tính lương.",
  ]) assert.match(settings, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(settings, /salaryInputLabel\(l, form\.payType\)/);
});

test("30,000 VND hourly pay keeps a 500 VND minute rate and 150,000 VND five-hour day rate", () => {
  const rates = calculatePayrollRates({ payType: "hourly", baseSalary: 30_000, standardMinutesPerDay: 300 } as never);
  assert.equal(rates.minuteRate, 500);
  assert.equal(rates.dayRate, 150_000);
});

test("correction RPC locks and updates only the latest expected revision with the same effective date", () => {
  assert.match(migration, /where id = p_contract_id and user_id = p_user_id\s+for update/);
  assert.match(migration, /v_contract\.revision <> p_expected_revision/);
  assert.match(migration, /v_latest_audit_log_id is distinct from p_expected_audit_log_id/);
  assert.match(migration, /order by revision desc, effective_from desc, id desc/);
  assert.match(migration, /v_latest_id <> v_contract\.id/);
  assert.match(migration, /p_effective_from <> v_contract\.effective_from/);
  assert.match(migration, /where id = v_contract\.id and revision = p_expected_revision/);
  assert.doesNotMatch(migration, /delete from public\.payroll_contract_versions/);
  assert.doesNotMatch(migration, /insert into public\.payroll_contract_versions/);
});

test("correction derives 300 minutes from schedule instead of trusting the client payload", () => {
  assert.match(route, /scheduledMinutesPerDay/);
  assert.doesNotMatch(route, /p_standard_minutes_per_day/);
  assert.match(v7Migration, /v_minutes:=/);
  assert.match(v7Migration, /payroll_correct_latest_unused_contract_v2/);
  assert.match(settings, /expectedRevision: correcting\?\.revision/);
  assert.match(settings, /expectedAuditVersion: correcting\?\.auditVersion/);
  assert.match(settings, /expectedEffectiveFrom: correcting\?\.effectiveFrom/);
  assert.match(settings, /formMode === "correct"[\s\S]*readOnlyValue/);
});

test("all payroll snapshot locations and every run status conservatively block used contracts", () => {
  assert.match(migration, /payroll_run_employees/);
  assert.match(migration, /contract_snapshot/);
  assert.match(migration, /attendance_snapshot/);
  assert.match(migration, /payroll_run_items item/);
  assert.match(migration, /item\.source_snapshot/);
  assert.match(migration, /payroll_run_reviews review/);
  assert.match(migration, /review\.source_snapshot/);
  assert.match(migration, /run\.status in \('finalized', 'paid'\)/);
  assert.match(migration, /contract_already_used/);
  assert.doesNotMatch(migration, /run\.status in \('draft', 'finalized', 'paid'\)/);
});

test("period overlap, owner policy, actor permission, and audit before/after are atomic RPC checks", () => {
  assert.match(migration, /pg_advisory_xact_lock\(p_user_id\)/);
  assert.match(migration, /role in \('owner', 'master'\)/);
  assert.match(migration, /daterange\(other\.effective_from/);
  assert.match(migration, /v_position = 'owner'/);
  assert.match(migration, /p_calculation_basis = 'fixed_monthly'/);
  assert.match(migration, /extract\(day from p_effective_from\) <> 1/);
  assert.match(migration, /'action'[\s\S]*'corrected'|action, actor_user_id, snapshot/);
  assert.match(migration, /'before', v_before/);
  assert.match(migration, /'after', to_jsonb\(v_corrected\)/);
  assert.match(migration, /'correctedAt', now\(\)/);
  assert.match(migration, /'reason', btrim\(p_reason\)/);
});

test("migration preflight fails on missing production objects and RPC is service-role only", () => {
  assert.match(migration, /PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_MISSING_OBJECTS/);
  assert.match(migration, /PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_COLUMN_TYPE_MISMATCH/);
  assert.match(migration, /PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_INVALID_AUDIT_ACTION_CONSTRAINT/);
  assert.match(migration, /PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_FUNCTION_SIGNATURE_MISMATCH/);
  assert.match(migration, /^begin;[\s\S]*commit;\s*$/);
  assert.match(migration, /create or replace function public\.payroll_correct_latest_unused_contract_v1/);
  assert.match(migration, /security definer/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
});

test("correction API maps concurrency, history, usage, locked payroll, date, and permission failures", () => {
  for (const code of [
    "CONTRACT_REVISION_CONFLICT", "CONTRACT_NOT_LATEST", "CONTRACT_ALREADY_USED",
    "CONTRACT_LOCKED_PAYROLL", "CONTRACT_EFFECTIVE_FROM_CHANGE_FORBIDDEN",
    "CONTRACT_PERIOD_CONFLICT", "CONTRACT_CORRECTION_FORBIDDEN",
    "PAYROLL_CONTRACT_CORRECTION_FAILED",
  ]) assert.match(route, new RegExp(code));
  assert.match(route, /requirePayrollActor\(\)/);
  assert.match(route, /payroll_correct_latest_unused_contract_v3/);
});

test("contract error mapper never returns internal contract codes in Korean or Vietnamese", () => {
  for (const code of [
    "CONTRACT_PERIOD_CONFLICT", "INVALID_CONTRACT", "FIXED_RAISE_REASON_REQUIRED",
    "INVALID_FIXED_MONTHLY_EFFECTIVE_DATE", "PAYROLL_CONTRACT_CREATE_FAILED",
    "CONTRACT_REVISION_CONFLICT", "CONTRACT_ALREADY_USED", "CONTRACT_NOT_LATEST",
  ]) {
    for (const lang of ["ko", "vi"] as const) {
      const message = payrollContractErrorMessage(lang, code);
      assert.ok(message.length > 10);
      assert.doesNotMatch(message, /^[A-Z0-9_]+$/);
      assert.doesNotMatch(message, new RegExp(code));
    }
  }
  assert.match(payrollContractErrorMessage("ko", "CONTRACT_PERIOD_CONFLICT"), /같은 기간/);
  assert.match(payrollContractErrorMessage("vi", "CONTRACT_PERIOD_CONFLICT"), /cùng khoảng thời gian/);
});

test("correction modal preserves input on failure, prevents duplicates, and keeps mobile footer reachable", () => {
  assert.match(settings, /if \(!userId \|\| saving\) return/);
  assert.match(settings, /disabled=\{saving \|\| \(!selectedIsOwner && automaticStandardMinutes === null\)\}/);
  assert.match(settings, /if \(!response\.ok\) \{[\s\S]*setModalError[\s\S]*return/);
  const failedResponse = settings.indexOf("if (!response.ok)");
  const failureReturn = settings.indexOf("return;", failedResponse);
  const closeAfterSuccess = settings.indexOf("setOpen(false);", failedResponse);
  assert.ok(failedResponse >= 0 && failureReturn > failedResponse && closeAfterSuccess > failureReturn);
  assert.match(settings, /await load\(userId\);\s+setOpen\(false\)/);
  assert.match(modal, /body:\{[\s\S]*overflowY:"auto"/);
  assert.match(modal, /footer:\{flexShrink:0/);
  assert.match(modal, /100dvh/);
});
