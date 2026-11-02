import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const sql=readFileSync('scripts/ledger/august-rebuild-atomic-ISOLATED-ONLY.sql','utf8');

test('private SQL is a local-only installation proposal with no production EXECUTE surface',()=>{
 assert.match(sql,/! DO NOT RUN ON PRODUCTION !/);
 assert.match(sql,/CREATE SCHEMA IF NOT EXISTS baba_august_rebuild_private/);
 assert.match(sql,/REVOKE ALL ON SCHEMA baba_august_rebuild_private FROM PUBLIC, anon, authenticated, service_role/);
 assert.match(sql,/REVOKE ALL ON FUNCTION baba_august_rebuild_private\.apply_v1\(jsonb,bigint,text,text\)/);
 assert.match(sql,/REVOKE ALL ON FUNCTION baba_august_rebuild_private\.reverse_v1\(uuid,bigint,text\)/);
 assert.match(sql,/session_user <> 'postgres'|session_user<>'postgres'/);
});

test('the exact 505 sheet cells, 124 buckets, card and month contracts are gates',()=>{
 for(const marker of ['sourceRows','cellCount','427','505','225925720','expectedDaily',
  'DAILY_BALANCE_MISMATCH','DAILY_124_NOT_UNIQUE','INVALID_DAILY_SOURCE',
  'AUGUST_SHEET_CLOSING_CHANGED','MONTH_BALANCE_MISMATCH','FUNDS_SNAPSHOT_STALE'])
  assert.ok(sql.includes(marker),marker);
 assert.match(sql,/jsonb_array_length\(p_manifest->'expectedDaily'\) IS DISTINCT FROM 124/);
 assert.match(sql,/SELECT.*v_expected[\s\S]*?SUM\(m\.amount\)/);
});

test('eight original technical IDs are exact and must be replaced as a unit',()=>{
 assert.match(sql,/ARRAY\[526,527,528,529,536,537,710,711\]::bigint\[\]/);
 assert.match(sql,/LEGACY_EIGHT_NOT_EXACT/);
 assert.match(sql,/TECHNICAL_REVERSAL_DRIFT/);
 assert.match(sql,/RELOCATE_ORIGINAL_NOT_EXACT/);
});

test('writes are append-only, zero-economic correction and return after postflight',()=>{
 assert.match(sql,/VALUES\(gen_random_uuid\(\),v_type,v_at,v_date,NULL,v_amount,NULL,NULL,'confirmed'/);
 assert.match(sql,/v_type='correction'[\s\S]*?v_kind='transfer'|v_type='correction'/);
 assert.match(sql,/INSERT INTO public\.ledger_movements/);
 assert.match(sql,/INSERT INTO public\.ledger_audit_logs/);
 assert.match(sql,/UPDATE baba_august_rebuild_private\.runs SET status='applied'/);
 assert.doesNotMatch(sql,/\bDELETE\s+FROM\s+public\.ledger_transactions\b/i);
 assert.doesNotMatch(sql,/\bUPDATE\s+public\.ledger_transactions\b/i);
 assert.doesNotMatch(sql,/\bDELETE\s+FROM\s+public\.ledger_movements\b/i);
 assert.doesNotMatch(sql,/\bUPDATE\s+public\.ledger_payable_allocations\b/i);
});

test('idempotency, protected future payables and preflight locks are explicit',()=>{
 for(const name of ['RUN_IDEMPOTENCY_CONFLICT','ANOTHER_REBUILD_ALREADY_APPLIED',
  'LATER_PAYABLES_CHANGED','PROTECTED_DATA_CHANGED','SOURCE_PROTECTION_DRIFT',
  'pg_advisory_xact_lock','LOCK TABLE public.ledger_transactions','MONTH_STATE_DRIFT',
  'ledger_month_closure_history','payable_fingerprint','history_fingerprint'])
  assert.ok(sql.includes(name),name);
});

test('reversal requires reopen and appends inverse corrections without deleting history',()=>{
 assert.match(sql,/FUNCTION baba_august_rebuild_private\.reverse_v1/);
 assert.match(sql,/MONTHS_MUST_BE_REOPENED/);
 assert.match(sql,/LATER_LEDGER_CHANGED/);
 assert.match(sql,/REVERSE|reversed_transaction_id/);
 assert.match(sql,/REVER(SAL|SED)_BALANCE_FAILED|REVERSAL_BALANCE_FAILED/);
 assert.match(sql,/UPDATE baba_august_rebuild_private\.runs SET status='reversed'/);
});

// This is a static source contract, NOT a PostgreSQL parser or runtime test.
test('dollar-quoted function bodies are balanced (static only)',()=>{
 for(const tag of ['balance','fingerprint','history','apply','reverse'])
  assert.equal((sql.match(new RegExp(`\\$${tag}\\$`,'g'))??[]).length,2,tag);
});


test('missing or NULL manifest fields never bypass the operator signature gate',()=>{
 assert.match(sql,/p_manifest->>'month' IS DISTINCT FROM '2026-08'/);
 assert.match(sql,/jsonb_typeof\(p_manifest->'requiredTechnicalMovementIds'\) IS DISTINCT FROM 'array'/);
 assert.match(sql,/p_approved_manifest_hash text/);
 assert.match(sql,/APPROVED_EXECUTION_PLAN_CHANGED/);
 assert.match(sql,/v_manifest_hash IS DISTINCT FROM p_approved_manifest_hash/);
});

test('all five independently approved protected fingerprints are checked BEFORE writing',()=>{
 assert.match(sql,/APPROVED_PROTECTION_SNAPSHOT_STALE/);
 for(const marker of ["'payable_allocations' THEN v_payables","'pos_receipts' THEN v_original_pos_fingerprint",
  "'month_closure_history' THEN v_history","'ledger_audit_history' THEN v_audit_fingerprint",
  "'inventory_logs' THEN v_original_inventory_fingerprint"]){assert.ok(sql.includes(marker),marker);}
 assert.ok(sql.indexOf('APPROVED_PROTECTION_SNAPSHOT_STALE')<sql.indexOf('INSERT INTO baba_august_rebuild_private.runs'));
});

test('one original movement cannot be reversed under two adjustment ids; source restoration is capped',()=>{
 assert.match(sql,/DUPLICATE_ORIGINAL_MOVEMENT_REVERSAL/);
 assert.match(sql,/RESTORATION_OVER_ORIGINAL_AMOUNT/);
 assert.match(sql,/count\(DISTINCT e->>'adjustmentId'\)/);
 assert.match(sql,/totals\.restored_amount>source\.amount/);
});
