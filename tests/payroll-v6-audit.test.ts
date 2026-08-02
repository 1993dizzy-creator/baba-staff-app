import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { normalizeAttendanceDayFacts } from "../lib/payroll/attendance-facts.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { isMissingAttendanceCandidateDate } from "../lib/payroll/missing-attendance.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { getLastCompletedBusinessDate } from "../lib/payroll/overview-period.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { payrollRpcVersion, payrollRunActionGuard } from "../lib/payroll/rpc-version.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const schedule = { id: 1, userId: 7, startTime: "16:00", endTime: "01:00", unpaidBreakMinutes: 0, effectiveFrom: "2026-07-01", effectiveTo: null, revision: 1, changeReason: "fixture" };

test("missing-attendance fixtures exclude records, employment boundaries, future and in-progress days", () => {
  const base = { hireDate: "2026-07-02", terminationDate: "2026-07-06", calculationEndDate: "2026-07-04", hasActiveSchedule: true };
  assert.equal(isMissingAttendanceCandidateDate({ ...base, date: "2026-07-02", hasAttendanceRecord: true }), false, "completed attendance");
  assert.equal(isMissingAttendanceCandidateDate({ ...base, date: "2026-07-03", hasAttendanceRecord: true }), false, "approved leave record");
  assert.equal(isMissingAttendanceCandidateDate({ ...base, date: "2026-07-04", hasAttendanceRecord: false }), true, "missing record candidate");
  assert.equal(isMissingAttendanceCandidateDate({ ...base, date: "2026-07-01", hasAttendanceRecord: false }), false, "before hire");
  assert.equal(isMissingAttendanceCandidateDate({ ...base, date: "2026-07-07", calculationEndDate: "2026-07-07", hasAttendanceRecord: false }), false, "after termination");
  assert.equal(isMissingAttendanceCandidateDate({ ...base, date: "2026-07-06", hasAttendanceRecord: false }), false, "future business day");
  assert.equal(isMissingAttendanceCandidateDate({ ...base, date: "2026-07-05", hasAttendanceRecord: false }), false, "current in-progress business day");
});

test("completed-business-date cutoff is strict across minute and calendar boundaries", () => {
  assert.equal(getLastCompletedBusinessDate(new Date("2026-08-01T02:59:00+07:00")), "2026-07-30");
  assert.equal(getLastCompletedBusinessDate(new Date("2026-08-01T03:00:00+07:00")), "2026-07-31");
  assert.equal(getLastCompletedBusinessDate(new Date("2026-08-01T03:01:00+07:00")), "2026-07-31");
  assert.equal(getLastCompletedBusinessDate(new Date("2027-01-01T02:59:00+07:00")), "2026-12-30");
  assert.equal(getLastCompletedBusinessDate(new Date("2027-01-01T03:00:00+07:00")), "2026-12-31");
});

test("actual elapsed minutes support overnight 550 and both 530-minute cases", () => {
  for (const [checkInAt, checkOutAt, expected] of [
    ["2026-07-01T08:55:00.000Z", "2026-07-01T18:05:00.000Z", 550],
    ["2026-07-01T09:10:00.000Z", "2026-07-01T18:00:00.000Z", 530],
    ["2026-07-01T09:00:00.000Z", "2026-07-01T17:50:00.000Z", 530],
  ] as const) {
    const facts = normalizeAttendanceDayFacts({ userId: 7, businessDate: "2026-07-01", schedule, attendanceRecord: { id: 1, status: "done", checkInAt, checkOutAt, approvalStatus: "approved" } });
    assert.equal(facts.actualMinutes, expected);
  }
});

test("manual late normalization overrides timestamp-derived late minutes", () => {
  const input = { userId: 7, businessDate: "2026-07-01", schedule, attendanceRecord: { id: 1, status: "done", checkInAt: "2026-07-01T09:10:00.000Z", checkOutAt: "2026-07-01T18:00:00.000Z", approvalStatus: "approved", storedLateMinutes: 0 } };
  assert.equal(normalizeAttendanceDayFacts(input).lateMinutes, 10);
  const normalized = normalizeAttendanceDayFacts({ ...input, manualLateNormalized: true });
  assert.equal(normalized.lateMinutes, 0);
  assert.equal(normalized.warningCodes.includes("STORED_LATE_MINUTES_MISMATCH"), false);
});

test("legacy recalculate and unfinalize are blocked while v3 non-recalculate compatibility remains", () => {
  const combined = ["app/api/admin/payroll/runs/[runId]/route.ts", "app/api/admin/payroll/runs/[runId]/employees/[employeeId]/items/route.ts", "app/api/admin/payroll/runs/[runId]/employees/[employeeId]/reviews/route.ts"].map(read).join("\n");
  for (const name of ["payroll_recalculate_run_v4", "payroll_mutate_item_v3", "payroll_mutate_item_v4", "payroll_resolve_review_v3", "payroll_resolve_review_v4", "payroll_transition_run_v3", "payroll_transition_run_v4"]) assert.match(combined, new RegExp(name));
  assert.doesNotMatch(read("app/api/admin/payroll/runs/[runId]/route.ts"), /rpc\("payroll_recalculate_run_v3"/);
  assert.match(combined, /payrollRpcVersion\(run\.engine_version\)/);
  assert.equal(payrollRpcVersion("monthly-payroll-v6"), "v4");
  assert.equal(payrollRpcVersion("monthly-payroll-v7"), "v4");
  assert.equal(payrollRpcVersion("monthly-payroll-v5"), "v3");
  assert.equal(payrollRpcVersion("unknown"), null);
  assert.equal(payrollRunActionGuard("monthly-payroll-v5", "recalculate"), "PAYROLL_LEGACY_RUN_RECALC_UNSUPPORTED");
  assert.equal(payrollRunActionGuard("monthly-payroll-v5", "cancel_finalization"), "PAYROLL_LEGACY_RUN_UNFINALIZE_UNSUPPORTED");
  assert.equal(payrollRunActionGuard("unknown", "recalculate"), "PAYROLL_ENGINE_VERSION_UNSUPPORTED");
  assert.equal(payrollRunActionGuard("monthly-payroll-v6", "recalculate"), null);
});

test("new runs use v7 while v6 operational preflight remains historical evidence", () => {
  const create = read("app/api/admin/payroll/runs/route.ts");
  const engine = read("lib/payroll/monthly-run.ts");
  const preflight = read("supabase/payroll_work_policy_penalties_v6_preflight.sql");
  assert.match(engine, /PAYROLL_RUN_ENGINE_VERSION = "monthly-payroll-v7"/);
  assert.match(create, /payroll_create_run_v4/);
  assert.doesNotMatch(create, /payroll_create_run_v3/);
  assert.match(preflight, /count\(\*\) as total_runs/);
  assert.match(preflight, /count\(\*\) filter \(where status = 'draft'\) as draft_runs/);
  assert.match(preflight, /engine_version = 'monthly-payroll-v5'[\s\S]*status = 'draft'/);
});

test("legacy finalized and paid ledgers remain readable with bilingual conflict messages", () => {
  const route = read("app/api/admin/payroll/runs/[runId]/route.ts");
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PATCH"));
  assert.match(getBody, /select\("\*"\)/);
  assert.doesNotMatch(getBody, /PAYROLL_LEGACY_RUN/);
  assert.match(route, /PAYROLL_LEGACY_RUN_RECALC_UNSUPPORTED/);
  assert.match(route, /이 장부는 이전 급여 계산 기준으로 생성되어 현재 방식으로 재계산할 수 없습니다/);
  assert.match(route, /Bảng lương này được tạo theo cách tính cũ nên không thể tính lại theo cách hiện tại/);
  assert.match(route, /PAYROLL_LEGACY_RUN_UNFINALIZE_UNSUPPORTED/);
  assert.match(route, /PAYROLL_ENGINE_VERSION_UNSUPPORTED/);
});

test("migration preflight, snapshot-only absence amount, categories, and private RPCs are auditable", () => {
  const migration = read("supabase/migrations/202608010001_add_payroll_work_policy_penalties_v6.sql");
  const preflight = read("supabase/payroll_work_policy_penalties_v6_preflight.sql");
  assert.match(migration, /PAYROLL_LATE_ITEM_DUPLICATES_FOUND/);
  assert.match(migration, /PAYROLL_ABSENCE_ITEM_DUPLICATES_FOUND/);
  assert.match(migration, /PAYROLL_ABSENCE_ITEM_ALREADY_EXISTS/);
  assert.match(preflight, /having count\(\*\) > 1/g);
  assert.match(migration, /v_review\.source_snapshot->>'dayRate'/);
  assert.match(migration, /v_run\.penalty_settings_snapshot->>'unauthorizedAbsencePenaltyDays'/);
  assert.doesNotMatch(migration.slice(migration.indexOf("create function public.payroll_resolve_review_v4"), migration.indexOf("create function public.payroll_transition_run_v4")), /payroll_contract_versions|from public\.payroll_settings/);
  const v5 = read("supabase/migrations/202607310001_add_payroll_insurance_v5.sql");
  const previous = v5.match(/category in \(([^)]*)\)/)?.[1]?.split(",").map(value => value.trim()) ?? [];
  const current = migration.match(/category in \(([^)]*)\)/)?.[1]?.split(",").map(value => value.trim()) ?? [];
  assert.deepEqual(current.filter(value => value !== "'unauthorized_absence_deduction'"), previous);
  assert.match(migration, /from public,anon,authenticated/);
  assert.doesNotMatch(migration, /drop function public\.payroll_.*_v[23]/);
});
