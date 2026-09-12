# POS business day close: backend phase 1

This change is local only. No production migration, deployment, Git operation,
Sales close button, cron route, or `vercel.json` change is part of this phase.
The existing one-button POS refresh UI and `force: true` request remain intact.

## Source and server contracts

`lib/ledger/pos-sales-source.ts` is the shared pure source builder for daily and
monthly POS loads. Only receipts with `payment_status = 3` and not canceled
contribute revenue; `final_amount` is authoritative. Payments provide the four
allocations using the existing Sales classifier. Per-receipt reconciliation,
integer nonnegative VND amounts, total allocation, record completeness and
business dates must pass before any source is usable.

`loadPosBusinessDaySource(date)` returns receipt count/total, cash/transfer/card/
other, payment total, four existing Ledger rows and fingerprints, and a canonical
whole-day snapshot and SHA256 fingerprint. Bucket snapshots preserve the legacy
August field order/hash. Whole-day hashing sorts object keys and orders records
by ID and buckets as cash/transfer/card/other. Monthly loads call the same builder.
PostgREST responses use exact counts and 500-row pages rather than silently
accepting the server response cap. Live-source validation in the RPC rejects
source changes between loading pages and projection.

`lib/sales/pos-business-day-close.ts` provides:

- `getPosBusinessDayCloseStatus(date)`: server-session owner/master/manager read;
  latest close, current/closed fingerprint, drift, total and bucket deltas,
  close method/revision/time/actor, month lock and actor-specific action flags.
- `closePosBusinessDay(date, options)`: server-session owner/master/manager initial manual write; owner/master reclose.
  `reclose: true` explicitly requests manual reclose. Optional
  `expectedSourceFingerprint` protects a future preview/review flow.
- `resolvePosCloseSystemActor()`: looks up username `pos` and verifies active,
  login enabled and owner/master. No numeric actor ID is hardcoded.
- `closePosBusinessDayAutomatically(date, successfulSyncRunId)`: internal future
  automation entry point, no reclose override and no cron/retry orchestration.
- `getPosBusinessDayCloseTime(date)`: existing business-time adapter and
  `buildPosCollectionWindow`; past business dates or the configured closeAt
  boundary only. Future dates and unavailable current configured hours fail
  closed. No early-close override exists.

## Migration and RPCs

`20260912101212_add_pos_business_day_closures.sql` adds immutable
`pos_sales_business_day_closures` with unique `(business_date, revision)`.
Highest revision is current. UPDATE/DELETE/TRUNCATE are blocked and service_role
has SELECT only. No existing production row is backfilled or changed by applying
the migration.

`sales_close_business_day_v1(date, text, jsonb, jsonb, bigint, text, boolean, bigint)`
accepts date, whole-day fingerprint, canonical snapshot, four rows, actor ID,
method (default manual), explicit manual reclose (default false) and optional
successful sync-run ID. Results: `closed`, `already_closed`,
`source_changed_after_close`, `reclosed`, `card_settlement_locked`, `month_closed`, or `forbidden`.

The RPC revalidates the actor, takes the existing month-close advisory key, then
the daily-close key, then SHARE locks both POS source tables. The source is
reconstructed and validated inside that transaction. Latest close is locked.
Equal fingerprints return without Ledger timestamp/audit updates. Changed
source requires explicit manual reclose; automatic reclose is rejected.
Close projection uses a private invoker-only copy of the existing v1 projection core,
requiring a capability scoped to transaction/date/actual actor and exactly one day.
This allows manager initial close without impersonating another actor or expanding
public v1/v2 write permissions. It verifies actual transaction and movement totals,
and appends a new close revision/audit row. Any projection error, including v1
returning an error after an earlier bucket was written, raises and rolls back the
entire transaction. Closed months always block close/reclose.

`ledger_sync_pos_sales_v3(jsonb, jsonb, bigint)` accepts existing rows, daily
fingerprint/snapshot descriptors, and actor ID. It locks months/days in sorted
order, validates all sources before writing, and calls v2 per unclosed day.
Closed days with matching source are strict no-ops; changed source is returned
in `dailyCloseDrift` without updating Ledger or close history. Existing month
drift behavior is preserved. The existing Ledger POS sync API now uses v3 and
retains its server-session authentication and month-only client body.

Ledger transaction/movement triggers prevent legacy v1/v2 and direct writes from
silently changing closed daily projections. Their signatures, bodies and grants
are unchanged. A private, transaction-scoped capability table permits projection
only during the close RPC; service_role cannot access the private schema/table.
The capability is removed before return and rolled back on any error. Legacy
v1/v2 callers on closed days now receive `POS_SALES_DAY_CLOSED` instead of writing,
including attempted timestamp updates. New public RPCs are SECURITY DEFINER,
owned by postgres with fixed search_path, actor revalidation and service-role-only
EXECUTE; public/anon/authenticated are denied.

Existing POS `savePayments()` / `reconcile_sales_receipt_payments_v1` are unchanged.
Close/sync never repair or mutate POS source data to pass reconciliation.

## Local verification

Run the source/service/isolated DB tests:

```powershell
node --experimental-strip-types --test tests/pos-business-day-source.test.ts tests/pos-business-day-close-service.test.mjs tests/pos-business-day-close-db.test.mjs tests/ledger-pos-sales.test.ts
```

The DB tests use only new in-memory PGlite databases and the actual v1/v2 and
new migration, including month guards. Native concurrency is a separate explicit
loopback-only test with a disposable database; it never loads `.env` or accepts
a production URL:

```powershell
$env:POS_CLOSE_TEST_PG_PORT = '<disposable local PostgreSQL port>'
node --experimental-strip-types tests/pos-business-day-close-concurrency.mjs
```

Native tests prove first-close, reclose and sync/reclose races (10 each), shared
month-close locking, source-writer race rejection, migration rollback, preserved
v1/v2 function definitions/attributes/grants and zero leaked capabilities.

## GPT review required before production rollout

1. Compare actual production v1/v2 definitions, source column types, revision/
   timestamp representation (UTC), mapping/category availability, source branch
   scope and sync-run `success` semantics with the local migration prerequisites.
   No production schema/RPC inspection was performed for this implementation.
2. Review private-schema privileges, definer owners/search_path, immutable history
   and every direct/legacy POS Ledger writer. Route those writers through v3 and
   account for the intentional closed-day rejection by old v1/v2 triggers.
3. Measure the POS table SHARE-lock duration on realistic daily/monthly volumes:
   source writers wait while a projection validates and commits. Check source
   query indexes and concurrent month-close/card-settlement workflows, especially
   manual reclose changing already allocated card amounts.
4. Review source snapshot/hash parity, pagination and fail-closed cases against
   actual August data in a read-only or isolated-copy check. Local August fixtures
   verify bucket/mapping/projection compatibility, not live production totals.
5. Review manual/reclose preview semantics and server-session authorization before
   adding any UI. Close-time enforcement currently lives in the trusted server
   service, not a new DB time override. Do not expose raw service-role RPC access
   to clients or bypass the service from a future route.
6. Review the later 03:00 final sync -> 03:05 automatic close run-selection,
   completeness and one-retry contract. This phase only validates an explicitly
   supplied successful run/date; it does not select/retry final runs or alter cron.
7. Report target migration/schema/RPCs, privileges and absence of backfill before
   requesting production application. After authorized application, verify migration
   history, function definitions/args/grants, existing rows/audit logs and Supabase
   security/performance Advisors. Do not infer rollout approval from this phase.

## Additional local audit

- Manager may initially close manual days, but explicit reclose and automatic
  close are forbidden. A manager on an already-closed equal source receives a
  strict no-op; changing its source returns forbidden.
- Manual reclose compares both card bucket fingerprint and amount. If either
  changes, it locks that day's POS card transaction FOR UPDATE (the existing
  reconciliation allocation RPC takes the same lock), then checks reconciliation
  lines joined to parents with status <> cancelled. Any active line returns
  card_settlement_locked before projection/capability/history writes. Partial
  and matched settlements are blocked; cancelled-only settlements are allowed.
- Cash-only changes with identical card bucket metadata remain allowed. Shared
  receipt revision/final-amount changes can also change the card fingerprint,
  even when card amount stays constant, and are intentionally protected.
- v3 validates all sources first, groups by business date, and CONTINUEs all
  closed dates; only open date rows reach v2.
- Daily triggers inspect old/new source_type = pos_sales_daily_payment and its
  closed business date; unrelated correction/deposit/payroll/expense/transfer
  writes are unaffected. No trigger disable/session flag/exposed bypass exists.
