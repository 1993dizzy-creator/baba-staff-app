# Inventory migration final review - 2026-10-10

## Changes

- supabase/migrations/20261010140729_atomic_inventory_edit_and_versioned_correction.sql
  - Removed the service_role EXECUTE revocation on inventory_apply_purchase_correction_v1. Existing V1 callers continue to work during rollout. Retirement is deferred to a separate migration after deployment and real-use verification, as requested.
  - inventory_update_with_audit_v1 checks the locked current quantity before any write. Only reason=purchase with a decreased submitted quantity is rejected with purchase_correction_required. Null quantity is interpreted consistently with existing zero-quantity audit behavior and cannot bypass this check. Stock-check/service/other/sale-deduction/unclassified decreases, purchase increases and metadata-only edits remain valid.
  - Changed item_matches_expected_v1 from IMMUTABLE to STABLE because timestamptz text input depends on session settings. Prepared execution under UTC and Asia/Bangkok verifies that the result is re-evaluated. PostgreSQL reference: https://www.postgresql.org/docs/current/xfunc-volatility.html
- app/api/inventory/items/route.ts
  - The DB purchase-correction guard maps to HTTP 409 / ok:false without a source-write fallback or Ledger projection.
  - V2 not_found maps to HTTP 404. Existing forbidden=403, quantity/version conflict=409, invalid payload=400 and RPC failures=500 remain covered.
  - The application uses ordinary inventory_update_with_audit_v1 or correction inventory_apply_purchase_correction_v2; V2 delegates to the original V1 under the same source/item transaction locks. No application correction path was changed back to the legacy entrypoint.
- tests/inventory-atomic-edit-db.test.mjs
- tests/inventory-items-final-validation.test.mjs
- tests/helpers/inventory-atomic-fixture.mjs (supports both PGlite and a native PostgreSQL adapter)
- tests/inventory-atomic-edit-postgres.test.mjs (new)
- tests/helpers/inventory-native-postgres.mjs (new)
- This report.

## Verified results

- Changed-scope DB/API tests: 42 passed (22 PGlite DB + 20 API tests), 0 failed.
- Related unit/API/policy regressions: 232 passed, 0 failed. The 20 API tests above are included in this suite.
- Existing Ledger correction/rebook, month-close, payment, supplier-confirmation and cancellation DB regressions: 83 passed, 0 failed. Total standalone PGlite DB tests: 105 (22 + 83).
- Native PostgreSQL 18.4: 10 Node tests passed (parent + 9 cases), 0 failed/skipped. Eight cases exercised distinct backend sessions; one additional native case checked grant preservation, STABLE volatility and the purchase-decrease-only guard.
- Actual two-session cases: ordinary/ordinary; V2/V2; ordinary/V2; V2/ordinary; legacy V1/V2; different purchase roots on the same item; blocked waiter after required-audit failure/rollback; unchanged-timestamp metadata changes after row-lock waiting.
- Lock waits were observed through pg_stat_activity and pg_blocking_pids using distinct backend PIDs, including transactionid and advisory waits. The loser preserved the winner's data and returned inventory_conflict. The audit-failure waiter committed once after the failed transaction rolled back. No SQL deadlock errors occurred; the observed database deadlock count was 0.
- Native cluster is created in a fresh workspace .qa-review directory, binds only 127.0.0.1 on an automatically chosen port, uses no external DB URL/credentials, and is stopped in finally. Temporary native binaries/package files remain isolated under .qa-review; application dependencies were not changed.
- ESLint: 0 errors; application route has no warnings. Extended test lint retains one existing unused mock flag warning.
- TypeScript: existing 40 errors unchanged, newly introduced errors 0.

The legacy V1 quantity-only concurrency behavior is intentionally retained for rollout compatibility; new application calls use V2. Production schema/triggers are not exercised by these isolated fixtures. The migration remains unapplied to production. No production DB mutation, deployment or Git commands were performed.

This review supersedes the previous report's legacy-permission-revocation and native multi-session validation notes.
