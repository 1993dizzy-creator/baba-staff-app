import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration=readFileSync("supabase/migrations/202607300001_add_payroll_compensation_and_adjustment_ledger.sql","utf8");
const route=readFileSync("app/api/admin/payroll/runs/[runId]/route.ts","utf8");
const page=readFileSync("app/(protected)/admin/payroll/[runId]/page.tsx","utf8");

test("normal finalization permits no open blocking review and records a non-force result",()=>{assert.match(migration,/p_action='finalize'[\s\S]*?v_blocking_count>0[\s\S]*?PAYROLL_OPEN_REVIEWS/);assert.match(migration,/force_finalized=false,force_finalize_reason=null,force_finalize_snapshot=null/)});
test("force finalization requires blocking reviews and a nonblank reason",()=>{assert.match(migration,/p_action='force_finalize'[\s\S]*?v_blocking_count=0[\s\S]*?PAYROLL_FORCE_NOT_REQUIRED/);assert.match(migration,/nullif\(btrim\(p_reason\),''\) is null[\s\S]*?PAYROLL_FORCE_REASON_REQUIRED/);assert.match(route,/FORCE_NOT_REQUIRED[\s\S]*?400/)});
test("force finalization snapshots server-side warnings, unresolved attendance, engine, actor and time",()=>{for(const token of["force_finalized","finalized_by","finalized_actor_role","finalized_at","force_finalize_reason","force_finalize_snapshot","v_unresolved_warnings","unresolvedAttendanceDays","engineVersion"])assert.match(migration,new RegExp(token));assert.match(migration,/into v_unresolved_warnings[\s\S]*?rv\.status='open'/);assert.match(migration,/into v_blocking_count[\s\S]*?rv\.review_level='blocking'/)});
test("paid runs and finalized runs cannot be force-finalized, recalculated, reopened after payment, or mutated",()=>{assert.match(migration,/p_action='force_finalize'[\s\S]*?v_run\.status<>'draft'[\s\S]*?PAYROLL_RUN_LOCKED/);assert.match(migration,/p_action='cancel_finalization'[\s\S]*?v_run\.status<>'finalized'/);assert.match(route,/if \(run\.status !== "draft"\)/);assert.match(page,/const locked=run\.status!=="draft"/)});
test("force audit is visible in run detail and preserved in transition audit snapshots",()=>{assert.match(page,/ForceFinalizationAudit/);assert.match(page,/force_finalize_reason/);assert.match(page,/확정 당시 미해결 항목/);assert.match(migration,/before_snapshot,after_snapshot[\s\S]*?v_before,v_after/)});
test("new-schema absence returns explicit API error codes rather than a false success",()=>{assert.match(route,/RUN_ACTION_FAILED/);const contracts=readFileSync("app/api/admin/payroll/contracts/route.ts","utf8");const adjustments=readFileSync("app/api/admin/payroll/adjustments/route.ts","utf8");assert.match(contracts,/PAYROLL_CONTRACT_(?:READ|CREATE)_FAILED/);assert.match(adjustments,/PAYROLL_ADJUSTMENT_(?:READ|CREATE|CANCEL)_FAILED/)});
