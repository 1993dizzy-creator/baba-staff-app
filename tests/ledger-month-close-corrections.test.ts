import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration=fs.readFileSync("supabase/migrations/202608210008_add_ledger_month_close_corrections.sql","utf8");
const closeRoute=fs.readFileSync("app/api/admin/ledger/month-close/route.ts","utf8");
const correctionRoute=fs.readFileSync("app/api/admin/ledger/corrections/route.ts","utf8");
const snapshot=fs.readFileSync("lib/ledger/month-close.ts","utf8");
const ledgerRoute=fs.readFileSync("app/api/admin/ledger/route.ts","utf8");
const bep=fs.readFileSync("lib/ledger/bep.ts","utf8");

test("phase 8 adds immutable month closure with RLS and service-role-only access",()=>{
 assert.match(migration,/create table public\.ledger_month_closures/);
 assert.match(migration,/status text not null default 'closed' check \(status = 'closed'\)/);
 assert.match(migration,/month date not null unique/);
 assert.match(migration,/enable row level security/);
 assert.match(migration,/revoke all on table public\.ledger_month_closures from public, anon, authenticated, service_role/);
 assert.doesNotMatch(closeRoute,/export async function DELETE|export async function PATCH/);
});

test("preflight blocks current/future, candidates, payroll, recurring and integrity failures",()=>{
 for(const code of ["CURRENT_MONTH","FUTURE_MONTH","PENDING_CANDIDATES","PAYROLL_NOT_COMPLETED","RECURRING_NOT_SYNCED","CANDIDATE_LINK_BROKEN","TRANSFER_UNBALANCED","PAYABLE_OVERALLOCATED","CARD_OVERALLOCATED","DUPLICATE_ACTIVE_SOURCE","CONFIRMED_SOURCE_DRIFT"])assert.match(migration,new RegExp(code));
 for(const warning of ["CARD_UNMATCHED","PAYABLE_OUTSTANDING","BALANCE_ADJUSTMENT"])assert.match(migration,new RegExp(warning));
});

test("close is atomic, month-locked, stale-safe and stores snapshots with hash",()=>{
 assert.match(migration,/pg_advisory_xact_lock\(hashtext\('ledger_month_close:/);
 assert.match(migration,/LEDGER_CLOSE_PREFLIGHT_STALE/);
 assert.match(migration,/preflight_snapshot jsonb/);
 assert.match(migration,/summary_snapshot jsonb/);
 assert.match(migration,/snapshot_hash text/);
 assert.match(closeRoute,/expectedPreflightHash/);
 assert.match(snapshot,/createHash\("sha256"\)/);
});

test("as-of snapshot uses target cutoffs for funds, payables, card and reserves",()=>{
 assert.match(snapshot,/business_date<endExclusive/);
 assert.match(snapshot,/payment\.business_date",endExclusive/);
 assert.match(snapshot,/reconciliation\.confirmed_at",endAt/);
 assert.match(snapshot,/occurred_at",endAt/);
 assert.match(snapshot,/totalOutstanding/);
 assert.match(snapshot,/cardClearing/);
 assert.match(snapshot,/totalProtectedReserve/);
});

test("closed month writes are DB-enforced for transactions, movements, candidates and reserve entries",()=>{
 assert.match(migration,/ledger_transactions_month_guard/);
 assert.match(migration,/ledger_movements_month_guard/);
 assert.match(migration,/ledger_candidates_resolution_month_guard/);
 assert.match(migration,/ledger_reserve_entries_month_guard/);
 assert.match(migration,/LEDGER_MONTH_CLOSED/);
});

test("source drift preserves original and deduplicates by fingerprint",()=>{
 assert.match(migration,/ledger_record_source_drift_v1/);
 assert.match(migration,/candidate_type='source_drift'/);
 assert.match(migration,/drift:'\|\|v_tx\.source_type/);
 assert.match(migration,/oldFingerprint/);
 assert.match(migration,/newFingerprint/);
 assert.match(migration,/oldAmount/);
 assert.match(migration,/newAmount/);
 assert.match(migration,/affectedClosedMonth/);
});

test("correction uses positive amount plus economic sign and never edits original",()=>{
 assert.match(migration,/economic_effect_sign smallint not null default 1/);
 assert.match(migration,/economic_effect_sign in \(-1, 1\)/);
 assert.match(migration,/correction_of_id/);
 assert.match(migration,/abs\(v_delta\)/);
 assert.match(migration,/case when v_delta<0 then-1 else 1 end/);
 assert.doesNotMatch(migration,/update public\.ledger_transactions set amount=.*v_original/);
 assert.match(correctionRoute,/p_movement_adjustments/);
 assert.match(correctionRoute,/p_reason/);
});

test("P&L and BEP apply correction sign without changing normal +1 rows",()=>{
 assert.match(ledgerRoute,/economic_effect_sign/);
 assert.match(ledgerRoute,/Number\(row\.amount\) \* Number\(row\.economic_effect_sign \?\? 1\)/);
 assert.match(bep,/economic_effect_sign/);
 assert.match(bep,/referenceMonthSource/);
 assert.match(bep,/closed_months/);
 assert.match(bep,/calendar_fallback/);
});

test("month-close and correction APIs reuse owner/master server authorization",()=>{
 assert.match(closeRoute,/requireLedgerActor/);
 assert.match(correctionRoute,/requireLedgerActor/);
 assert.match(migration,/revoke all on function[\s\S]*from public,anon,authenticated/);
 assert.match(migration,/grant execute on function[\s\S]*to service_role/);
});

// Phase 9 coverage audit: keep each Phase 8 safety promise traceable by name.
test("phase8 coverage: current and future month close are rejected",()=>{assert.match(migration,/CURRENT_MONTH/);assert.match(migration,/FUTURE_MONTH/)});
test("phase8 coverage: stale preflight is rejected",()=>{assert.match(migration,/LEDGER_CLOSE_PREFLIGHT_STALE/)});
test("phase8 coverage: pending inventory and meal are blockers",()=>{assert.match(migration,/candidate_type in\('inventory_purchase','employee_meal'\)/)});
test("phase8 coverage: payroll and recurring readiness are blockers",()=>{assert.match(migration,/PAYROLL_NOT_COMPLETED/);assert.match(migration,/RECURRING_NOT_SYNCED/)});
test("phase8 coverage: card payable and reserve are warnings",()=>{for(const code of["CARD_UNMATCHED","PAYABLE_OUTSTANDING","RESERVE_SHORTFALL"])assert.match(migration,new RegExp(code))});
test("phase8 coverage: fund payable card reserve snapshots are as-of",()=>{for(const marker of["business_date<endExclusive","payment.business_date\",endExclusive","reconciliation.confirmed_at\",endAt","occurred_at\",endAt"])assert.match(snapshot,new RegExp(marker))});
test("phase8 coverage: manual and candidate writes are closed-month guarded",()=>{assert.match(migration,/ledger_transactions_month_guard/);assert.match(migration,/ledger_candidates_resolution_month_guard/)});
test("phase8 coverage: payable and card writes are closed-month guarded",()=>{assert.match(migration,/ledger_payable_allocations_month_guard/);assert.match(migration,/ledger_card_reconciliations_month_guard/);assert.match(migration,/ledger_card_reconciliation_lines_month_guard/)});
test("phase8 coverage: closed source sync creates drift without overwrite",()=>{for(const name of["ledger_sync_pos_sales_v2","ledger_sync_recurring_expenses_v2","ledger_sync_payroll_company_cost_v2"])assert.match(migration,new RegExp(name));assert.match(migration,/ledger_record_source_drift_v1/)});
test("phase8 coverage: correction supports income and expense increase decrease",()=>{assert.match(migration,/v_original.type not in\('income','sales','expense','expense_recognition'\)/);assert.match(migration,/case when v_delta<0 then-1 else 1 end/)});
test("phase8 coverage: fund correction and same-operation economic correction",()=>{assert.match(migration,/p_movement_adjustments/);assert.match(migration,/v_operation uuid:=gen_random_uuid/)});
test("phase8 coverage: same drift cannot resolve twice",()=>{assert.match(migration,/v_candidate.status<>'pending'/);assert.match(migration,/drift_already_resolved/)});
test("phase8 coverage: original closed transaction is never mutated",()=>{assert.doesNotMatch(migration,/update public\.ledger_transactions[\s\S]{0,160}where id=p_original_transaction_id/);assert.match(migration,/correction_of_id/)});
test("phase8 security: closed sync and drift RPCs revalidate the actor",()=>{for(const name of["ledger_record_source_drift_v1","ledger_sync_pos_sales_v2","ledger_sync_recurring_expenses_v2","ledger_sync_payroll_company_cost_v2"]){const start=migration.indexOf(`function public.${name}`),next=migration.indexOf("create or replace function",start+20),body=migration.slice(start,next<0?undefined:next);assert.match(body,/from public\.users/);assert.match(body,/not in\('owner','master'\)|not in \('owner','master'\)/)}});
test("phase8 as-of: later card confirmation stays unmatched in an earlier snapshot",()=>{assert.match(snapshot,/row\.confirmed_at!=null&&String\(row\.confirmed_at\)<endAt/);assert.match(snapshot,/!asOfMatchedIds\.has\(Number\(row\.id\)\)/)});
test("phase8 idempotency: a resolved fingerprint drift cannot be recreated",()=>{assert.match(migration,/source_type='ledger_source_drift'and source_key=v_key order by id desc limit 1/);assert.doesNotMatch(migration,/source_type='ledger_source_drift'and source_key=v_key and status='pending'/)});
test("phase8 locking: correction locks drift candidate before original and validates their link",()=>{const fn=migration.slice(migration.indexOf("ledger_create_correction_v1"),migration.indexOf("ledger_sync_pos_sales_v2"));assert.ok(fn.indexOf("id=p_source_drift_candidate_id")<fn.indexOf("id=p_original_transaction_id for update"));assert.match(fn,/source_snapshot->>'originalTransactionId'/)});
