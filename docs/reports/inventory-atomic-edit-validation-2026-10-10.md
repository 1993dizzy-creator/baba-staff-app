# Atomic inventory edit and versioned correction - 2026-10-10

## Changed files

- app/api/inventory/items/route.ts
- supabase/migrations/20261010140729_atomic_inventory_edit_and_versioned_correction.sql (new; not applied to production)
- tests/inventory-items-final-validation.test.mjs
- tests/inventory-ledger-projection-api.test.mjs
- tests/inventory-atomic-edit-db.test.mjs (new)
- tests/helpers/inventory-atomic-fixture.mjs (new)
- This report.

## Scope and implementation

Only the two identified transaction/concurrency issues are changed. Existing TypeScript failures are untouched.

Normal PATCH edits and quick-save use inventory_update_with_audit_v1. The function locks the item, compares the prior item snapshot (including timestamp, quantity, active status and all fields selected by the API), advances its timestamp monotonically, updates the item, and inserts the required source audit and applicable price history. Write errors are allowed to abort the entire DB transaction. A suppressed required audit insert is also an error. The API returns HTTP 500 / ok:false on RPC failure and never falls back to separate writes. A DB conflict returns HTTP 409 before overwriting another edit. Successful responses retain the existing ok/mode/ledgerSync contract.

Purchase correction uses inventory_apply_purchase_correction_v2. It acquires the original source lock followed by the item row lock, verifies quantity plus timestamp and the expected item fields inside the DB, then calls the unchanged correction v1 implementation under those same transaction locks. Existing correction linkage, source/price/Ledger audit writes remain transactional. The service-role permission on the legacy quantity-only entrypoint is revoked to prevent bypass. Existing active-staff automatic corrections are retained; explicit owner/master correction authorization remains in the API, and inactive-item restrictions are also enforced in the DB. Timestamp comparisons use timestamptz equality, accommodating equivalent timezone representations.

Existing canonical Ledger projection remains a separate reported operation after the required item/source transaction. The correction/rebook, month-close, payment and manual-override protections were not replaced.

## Test results

- New isolated PGlite transaction/concurrency tests: 18 passed, 0 failed.
- Existing isolated Ledger DB regressions: 83 passed, 0 failed. Total standalone isolated DB tests: 101.
- Related unit/API/policy regression suite: 227 passed, 0 failed. This includes two actual API-handler -> actual PGlite RPC tests for audit rollback/retry and changes between the API read and DB write, plus missing-RPC failure and correction snapshot/conflict mapping.
- Browser suite: 1 passed, covering KO/VI x desktop/mobile, failed-save draft preservation, successful save, duplicate submission, date switching, preserved filters/scroll/history, numeric/caret behavior and unchanged accounting. Every API request is intercepted; no production data is written.
- ESLint for the changed application route: 0 errors, 0 warnings.
- Full TypeScript check: current 40 existing errors, newly introduced errors 0. Diagnostic file/code/message prefixes match the saved prior validation inventory; the existing errors were not edited.

New DB cases cover normal success, source audit failure, price audit failure, retries, duplicate requests, unchanged-quantity metadata conflicts, timestamp-only conflicts, existing quantity conflict, future timestamps, decimal price preservation, restricted privileges, absence of legacy bypass, correction audit/price/Ledger audit failures, suppressed audit insert, competing normal/correction requests, exact canonical reversal/rebook economics and unchanged cash. A failing insert preserves all table snapshots, including master and existing accounting. Month-closed, paid-payable and manual-Ledger-override cases retain unchanged transactions/payables/cash after attempted confirmation.

## Remaining risks and activation requirements

- The migration is local only. Production behavior does not change until an explicitly authorized deployment/migration. API code requires the new RPCs; missing RPCs fail closed with HTTP 500, with no partial-write fallback.
- The migration revokes the legacy correction RPC's service permission. A later authorized release must coordinate migration/API cutover, since an older API instance still using that legacy entrypoint would be rejected after revocation. No production migration or deployment was performed here.
- PGlite executes overlapping requests on one PostgreSQL connection. Stale-version interleavings, rollback and one-winner behavior were verified with concurrent JS requests and real SQL, but live multi-session lock waits/deadlocks and production-specific schema/triggers were not tested.

No production DB access/mutation, deployment or Git commands were executed. The only Supabase CLI mutation was creation of an empty local migration file before writing the SQL.
