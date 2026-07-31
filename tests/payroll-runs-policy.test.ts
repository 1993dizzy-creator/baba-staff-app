import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/202607270002_create_payroll_runs.sql");
const lifecycleMigration = read("supabase/migrations/202607280001_add_employee_lifecycle_and_payroll_schedule.sql");
const engine = read("lib/payroll/monthly-run.ts");
const workPolicy = read("lib/payroll/work-policy.ts");
const runApi = read("app/api/admin/payroll/runs/route.ts");
const detailApi = read("app/api/admin/payroll/runs/[runId]/route.ts");
const itemApi = read("app/api/admin/payroll/runs/[runId]/employees/[employeeId]/items/route.ts");
const reviewApi = read("app/api/admin/payroll/runs/[runId]/employees/[employeeId]/reviews/route.ts");

test("ledger schema normalizes reviews and enforces one active monthly run", () => {
  for (const table of ["payroll_runs", "payroll_run_employees", "payroll_run_items", "payroll_run_reviews", "payroll_run_audit_logs"]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /revision bigint not null check \(revision >= 1\)/);
  assert.match(migration, /where status in \('draft','finalized','paid'\)/);
  assert.match(migration, /unique nulls not distinct\(payroll_run_employee_id,business_date,warning_code\)/);
  assert.match(migration, /where payroll_run_review_id is not null/);
  assert.match(migration, /amount bigint not null check \(amount >= 0\)/);
});

test("official runs inspect completed scheduled dates and reject months before July 2026", () => {
  assert.match(engine, /const eligibleDates=input\.dates\.filter/);
  assert.match(engine, /const recordsByDate=new Map/);
  assert.match(engine, /PAYROLL_RUN_START_MONTH = "2026-07"/);
  assert.match(runApi, /isOfficialPayrollMonth/);
  assert.match(runApi, /PAYROLL_MONTH_NOT_SUPPORTED/);
  assert.match(lifecycleMigration, /p_month<date '2026-07-01'/);
  assert.match(engine, /date>=user\.hire_date/);
});

test("employee union excludes system accounts and applies employment dates", () => {
  assert.match(engine, /contractIds\.has\(user\.id\)/);
  assert.match(engine, /isPayrollUserCandidate/);
  assert.match(engine, /payroll_eligible_override/);
  assert.match(engine, /const intersects=Boolean\(user\.hire_date\)/);
  assert.match(engine, /user\.termination_date>=start/);
  assert.match(engine, /hasAttendance:attendanceIds\.has\(user\.id\)/);
  assert.match(engine, /hasContract:contractIds\.has\(user\.id\)/);
  assert.match(engine, /date<=user\.termination_date/);
  assert.match(engine, /NO_PAYROLL_CONTRACT/);
});

test("calculation uses contract rates and explicit automatic categories", () => {
  assert.match(workPolicy, /salaryBase \/ contract\.standardWorkdays/);
  assert.match(engine, /calculateCombinedSalary\(contract,levelInfo\)/);
  assert.match(workPolicy, /contract\.payType === "daily"/);
  assert.match(workPolicy, /contract\.baseSalary \/ 60/);
  for (const category of ["base_work", "paid_leave", "late_deduction", "early_leave_deduction", "OVERTIME_APPROVAL_UNAVAILABLE"]) assert.match(engine, new RegExp(category));
  assert.match(engine, /roundMinutes\(actualRecognizedMinutes,contract\.timeBlockMinutes,contract\.roundingMode\)/);
  assert.match(engine, /applyPayrollWorkPolicy/);
  assert.match(engine, /Math\.round\(value\)/);
});

test("critical warnings become normalized open reviews and totals derive from items", () => {
  for (const code of ["NO_PAYROLL_CONTRACT", "MISSING_CHECK_IN", "MISSING_CHECK_OUT", "INVALID_TIME_RANGE", "SCHEDULE_HISTORY_UNAVAILABLE", "PENDING_LEAVE_APPROVAL", "LEAVE_PAYROLL_TREATMENT_UNSPECIFIED", "OVERTIME_APPROVAL_UNAVAILABLE", "CONTRACT_OVERLAP", "CALCULATION_FAILED", "STORED_STATUS_POLICY_MISMATCH", "STORED_LATE_MINUTES_MISMATCH", "STORED_EARLY_LEAVE_MINUTES_MISMATCH", "STORED_WORK_MINUTES_MISMATCH"]) assert.match(engine, new RegExp(code));
  assert.match(migration, /from public\.payroll_run_reviews rv where rv\.payroll_run_employee_id=e\.id and rv\.status='open'/);
  assert.match(migration, /left join public\.payroll_run_items i on i\.payroll_run_employee_id=re\.id/);
  assert.match(engine, /amountDelta/);
});

test("review actions are warning-specific and custom overtime cannot be negative", () => {
  assert.match(migration, /approve_overtime','exclude_overtime','custom_overtime_minutes/);
  assert.match(migration, /PAYROLL_INVALID_CUSTOM_MINUTES/);
  assert.match(migration, /warning_code='LEAVE_PAYROLL_TREATMENT_UNSPECIFIED'[\s\S]*paid_leave','unpaid_leave/);
  assert.match(migration, /warning_code='PENDING_LEAVE_APPROVAL' and p_action='exclude_pending_leave'/);
  assert.match(migration, /use_stored_attendance','use_recalculated_attendance','acknowledged/);
  assert.match(migration, /delete from public\.payroll_run_items where payroll_run_employee_id=p_run_employee_id and item_type='automatic' and business_date=v_review\.business_date/);
  assert.match(migration, /jsonb_array_elements\(v_selected_items\)/);
  assert.match(migration, /PAYROLL_INVALID_REVIEW_ACTION/);
});

test("recalculation is one RPC transaction, copies manual items, and recreates reviews", () => {
  const body = migration.slice(migration.indexOf("create function public.payroll_recalculate_run_v2"), migration.indexOf("create function public.payroll_mutate_item_v2"));
  assert.match(body, /pg_advisory_xact_lock/);
  assert.match(body, /payroll_insert_payload_v2/);
  assert.match(migration, /i\.item_type='manual'/);
  assert.doesNotMatch(body, /review_resolutions/);
  assert.ok(body.indexOf("perform public.payroll_insert_payload_v2") < body.indexOf("update public.payroll_runs set status='cancelled'"));
  assert.match(detailApi, /payroll_recalculate_run_v4/);
  assert.match(detailApi, /Number\.isSafeInteger\(replacementRunId\)/);
});

test("state machine locks paid and cancelled runs", () => {
  assert.match(migration, /p_action='finalize'[\s\S]*v_run\.status<>'draft'/);
  assert.match(migration, /p_action='cancel_finalization'[\s\S]*v_run\.status<>'finalized'/);
  assert.match(migration, /p_action='pay'[\s\S]*v_run\.status<>'finalized'/);
  assert.match(migration, /p_action='cancel'[\s\S]*v_run\.status<>'draft'/);
  assert.match(migration, /finalization_cancelled/);
  assert.match(migration, /force_finalized/);
});

test("all APIs are owner-master server routes with run/employee membership checks", () => {
  for (const source of [runApi, detailApi, itemApi, reviewApi]) {
    assert.match(source, /requirePayrollActor\(\)/);
    assert.match(source, /payrollJson/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/);
  }
  assert.match(itemApi, /p_run_id: runId, p_run_employee_id: employeeId/);
  assert.match(reviewApi, /p_run_id: runId, p_run_employee_id: employeeId/);
  assert.match(migration, /PAYROLL_EMPLOYEE_RUN_MISMATCH/);
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\.attendance_records/i);
});

test("SECURITY DEFINER RPCs use a fixed path and service-role-only execution", () => {
  for (const fn of ["payroll_create_run_v2", "payroll_recalculate_run_v2", "payroll_mutate_item_v2", "payroll_resolve_review_v2", "payroll_transition_run_v2"]) {
    assert.match(migration, new RegExp(`create function public\\.${fn}[\\s\\S]*?security definer set search_path=public`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role`));
  }
  assert.match(migration, /is_active=true and role in \('owner','master'\)/);
  assert.match(migration, /from public,anon,authenticated/);
});
