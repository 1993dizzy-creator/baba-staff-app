# Inventory snapshots final validation - 2026-10-10

## Files changed during final validation

- `components/inventory/InventoryPageContent.tsx`
- `app/(protected)/inventory/snapshots/page.tsx`
- `app/api/inventory/items/route.ts`
- `app/api/inventory/logs/route.ts`
- `app/api/inventory/snapshot/name-sync/route.ts`
- `lib/inventory/language-missing.ts`
- `tests/inventory-items-final-validation.test.mjs`
- `tests/inventory-ledger-projection-api.test.mjs`
- `tests/inventory-snapshots-browser.test.mjs`
- This report.

## Fixes and checks

- Selected-item authorization; inactive-item edits require leader or higher. Active-item staff access retains existing policy. Status changes cannot bypass the dedicated mode.
- Version/quantity conflict checks before supplier resolution; ordinary writes use atomic compare-and-set predicates. Server timestamps advance monotonically.
- Immediate save locks prevent duplicate submissions; modal close is disabled during saving; failed saves retain input.
- Untouched fractional purchase prices survive metadata-only edits and quick-save without integer-parser corruption. New price input retains the existing integer policy.
- Card responses include correction linkage and business date. Effective purchase lists omit fully canceled root #12407 / correction #12883 for item #613 and retain valid historical purchases for inactive items. Raw audit records remain available.
- Tests execute actual API handlers with isolated fixtures. PATCH mocks use the real {ok, mode, ledgerSync} response rather than an invented data property. GET fixtures include selected item, aliases and version.
- Existing correction/rebook, paid-allocation and monthly-close paths remain in use; no direct DB changes or deployment.

## Results

- Unit/API/policy regression tests: 223 passed, 0 failed.
- Isolated in-memory PostgreSQL (PGlite) accounting tests: 83 passed.
- Browser suite: passed KO/VI x desktop/mobile, date switching, selected lazy load, duplicate save, close blocking, failure preservation, success refresh, filters/scroll/expanded history preservation, commas/caret/numeric keyboard and unchanged accounting. All API traffic intercepted.
- ESLint on six changed application files: 0 errors, 0 warnings.
- Full TypeScript: baseline 40 errors, current 40 errors; added errors 0. Application source errors 0. Existing source versions were read directly from repository objects without executing Git commands.

## Remaining risks

- The 40 existing TypeScript failures below remain; full-project typecheck is not green.
- Ordinary master updates and subsequent audit/price-log writes are separate statements. An injected audit failure proves the API can return 500 after the master update commits. UI drafts remain; a stale replay is rejected. Fully atomic recovery requires a transaction/RPC change.
- The purchase correction RPC locks quantity but does not recheck expected updated_at inside the lock. A concurrent same-quantity metadata edit between API validation and RPC execution remains a race. Closing this gap requires DB function work, outside the authorized local-only scope.
- Production state for item #613 was not queried or changed. Cancellation behavior was verified with the concrete root/correction fixtures and actual local API implementation.

## Complete TypeScript failure inventory

| File | Line:column | Code | Existing error |
| --- | --- | --- | --- |
| `lib/ledger/entries-presentation.test.ts` | 8:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `lib/ledger/investment-cash-event.test.ts` | 7:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `lib/ledger/manual-entry-policy.test.ts` | 12:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/inventory-monthly-effective-purchases.test.ts` | 8:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/inventory-monthly-supplier-bars.test.ts` | 5:45 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/inventory-snapshot-name-sync.test.ts` | 13:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/inventory-snapshot-name-sync.test.ts` | 17:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/inventory-snapshot-name-sync.test.ts` | 18:59 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entries-v1.test.ts` | 36:30 | TS2322 | Type 'Map<string, string>' is not assignable to type 'false \| void'. |
| `tests/ledger-entries-v1.test.ts` | 472:20 | TS18048 | 'rule.parent' is possibly 'undefined'. |
| `tests/ledger-entries-v1.test.ts` | 472:54 | TS18048 | 'rule.parent' is possibly 'undefined'. |
| `tests/ledger-entries-v1.test.ts` | 472:66 | TS2339 | Property 'params' does not exist on type 'ContainerWithChildren'.   Property 'params' does not exist on type '{ nodes: ChildNode[]; } & Root_'. |
| `tests/ledger-entries-v1.test.ts` | 473:21 | TS18048 | 'rule.parent' is possibly 'undefined'. |
| `tests/ledger-entry-filter-visibility.test.ts` | 4:97 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entry-filter-visibility.test.ts` | 5:86 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entry-list-filter.test.ts` | 4:158 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entry-list-filter.test.ts` | 5:135 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entry-list-filter.test.ts` | 6:87 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entry-list-filter.test.ts` | 7:60 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entry-list-filter.test.ts` | 8:36 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-entry-list-filter.test.ts` | 9:33 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-month-close-card-snapshot.test.ts` | 3:49 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-reserve-history-entries.test.ts` | 11:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-reserve-history-entries.test.ts` | 12:62 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-reserve-history-entries.test.ts` | 13:33 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-reserve-history-entries.test.ts` | 14:64 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-reserve-history-entries.test.ts` | 15:63 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-reserve-history-entries.test.ts` | 16:36 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-reserve-history-entries.test.ts` | 86:61 | TS2322 | Type 'number' is not assignable to type 'string'. |
| `tests/ledger-reserve-history-entries.test.ts` | 87:61 | TS2322 | Type 'number' is not assignable to type 'string'. |
| `tests/ledger-reserve-history-entries.test.ts` | 88:64 | TS2322 | Type 'number' is not assignable to type 'string'. |
| `tests/ledger-settings-i18n.test.ts` | 4:36 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-settings-i18n.test.ts` | 5:86 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-settings-i18n.test.ts` | 6:60 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-settings-i18n.test.ts` | 7:40 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-settings-partners-integration.test.ts` | 7:8 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/ledger-settings-partners-integration.test.ts` | 8:31 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/sales-receipt-split-payment.test.ts` | 4:42 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/sales-receipt-split-payment.test.ts` | 5:35 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
| `tests/sales-receipt-split-payment.test.ts` | 6:71 | TS5097 | An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. |
