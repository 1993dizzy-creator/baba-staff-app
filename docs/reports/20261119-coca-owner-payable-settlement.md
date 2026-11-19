# Coca-Cola owner balance payable settlement - 2026-11-19

## Result and operating boundary

Application and isolated database verification PASS. Production activation remains HOLD pending separate GPT/Owner review, migration application and conversion approval. No production DB write, migration, repair, payment or Sheets change was executed by this task.

Baseline: main b4ea627cff8f3fc27c1fd14c22ba2fe40bacf006. All three existing trees were CLEAN at start; no new branch/worktree. Main was developed serially. Existing POS and UI restoration commits are preserved.

## Implementation

- New transaction type owner_payable_settlement, restricted to party 5 / 2026-11-17 / 334048 and immutable anchor identity. No recognition month, category, inventory or fund movement.
- Separate ledger_payable_anchor_settlements mapping links immutable anchor 1 to exactly one new transaction and payable. Original anchor and audit rows are preserved. New conversion audit records before/after linkage, unresolved source and Owner confirmation.
- Service-only ledger_convert_coca_owner_balance_anchor_v1(reason, ownerId) is atomic, idempotent and guarded by month/party locks, fixed baseline and historic-payment checks. No conversion runs during migration installation.
- Existing V1/V2 payment RPCs and allocation/idempotency/recovery are reused unchanged. The payable can be selected and paid using existing screens. Existing 11/17 row uses the short settlement label in KO/VI.
- Converted mode counts the payable outstanding and no longer adds the same anchor delta. Original frozen baseline excludes this one new payable. Missing conversion table uses the prior behavior; an inconsistent converted source fails closed.
- Month summary classifies 334048 as balance adjustment, never purchases. The journal entry builder omits this noncash settlement from expense/transfer cards. AP detail and month-close use the common calculation.
- page.tsx and entries.module.css are unchanged. No new cards, notes, popup or payment flow.

## Verification

90 automated cases PASS: 7 new settlement DB cases plus 83 existing/extended anchor API, anchor DB, payment and prepayment cases. Existing unrelated PASS evidence was reused, not rerun or claimed as newly tested.

Verified: 4982000 aggregate equals eight selectable payables; 2000000 payment leaves 2982000; full payment leaves zero; duplicate/retry creates one payout; overpayment blocked; later real receipt adds 1000000; old-prepayment application timing; exact global baseline 101667900 under fixture conditions; period purchases unchanged; month-close/preflight/detail equality; conversion duplicate protection and atomic failure rollback; other party and protected original rows unchanged. The original seven principal amounts, payment 5097, its nine allocations, movement 2854, old audits, prior closed months, inventory and expenses are unchanged.

TypeScript: tsc --noEmit --pretty false --incremental false PASS. ESLint on changed app/test files PASS without warnings. git diff --check PASS.

Browser: actual page TSX + real CSS isolated React render in local Chrome, KO/VI x 390/1280 x 6 screen states = 24 PASS. Total and payment limit 4982000; selected-date handler, full eight-allocation partial payment, 2000000 handler and excess guard checked. No horizontal overflow or clipped controls. This uses loaded local fixtures, not authenticated Production E2E. Screenshots and JSON evidence are in .local/coca-owner-payable-settlement-20261119. Existing 600px UI results are reused because page/CSS are unchanged.

## Safe operating sequence (not executed here)

1. Deploy this compatible application first; old DB remains usable with the previous 4647952 selectable limit until activation.
2. GPT reviews the exact GitHub commit and new formal migration 20261119085058_coca_owner_balance_payable_settlement.sql, then obtains the separate DB approval. Apply that new migration only. Do not rerun or modify 20261119071107.
3. After verifying current November is open, anchor 1 identity, baseline 4647952 and original payment evidence, GPT executes ledger_convert_coca_owner_balance_anchor_v1 with an approved reason and verified active Owner/master user ID. No placeholder actor ID is supplied here.
4. Postflight must show one mapping, one confirmed noncash transaction and one payable for 334048, zero source fund movements, original anchor/payment/allocations unchanged, total/selectable 4982000, matching detail/month-close, no purchase/inventory effects and unchanged other parties. Review 101667900 only under the same no-other-transactions condition.
5. Verify actual production full-payment availability without making a real payment solely for testing. Actual payment requires its own business instruction. Existing code before this release is not compatible with an activated converted row; do not roll back to it after conversion without reviewing the accounting contract.

The owner-confirmed source remains unverified and no independent supplier statement is implied. Payment difference 366112 and historical difference 700160 remain unresolved. The 8/24 unapplied 2545032 is not offset or altered.

New migration SHA256 (supersedes the initial preflight-defective revision): cc7915e7f1d47be0d969e334286574c046954491c49811fc9cba9b62e5bc2647.
Protected prior migration SHA256: 22f9a873ad1164f5158760a0348d3e081440af6b2bb064d85ba91f29bd0e82c6.

## Changed files (absolute Windows paths)

- C:\workspace\baba-staff-app\app\api\admin\ledger\payables\route.ts
- C:\workspace\baba-staff-app\app\api\admin\ledger\payables\[partyId]\route.ts
- C:\workspace\baba-staff-app\lib\ledger\payables.ts
- C:\workspace\baba-staff-app\lib\ledger\payable-balance-anchor-data.ts
- C:\workspace\baba-staff-app\lib\ledger\month-close.ts
- C:\workspace\baba-staff-app\lib\ledger\entries.ts
- C:\workspace\baba-staff-app\supabase\migrations\20261119085058_coca_owner_balance_payable_settlement.sql
- C:\workspace\baba-staff-app\tests\coca-owner-payable-settlement-db.test.mjs
- C:\workspace\baba-staff-app\tests\helpers\coca-owner-balance-fixture.mjs
- C:\workspace\baba-staff-app\tests\ledger-payable-balance-anchor-api.test.mjs
- C:\workspace\baba-staff-app\docs\reports\20261119-coca-owner-payable-settlement.md

Cleanup limitation: automatic approval review rejected the recursive temporary-browser/HTML cleanup command as blocked by policy; no specific reason was supplied. No bypass attempted. Temporary browser profile and fixtures remain under this task's ignored .local folder; evidence is preserved.

## Production source metadata correction (2026-11-19)

Owner reported that the unapplied conversion INSERT omitted source_fingerprint/source_synced_at. The preceding 7 isolated DB cases did not reproduce ledger_transaction_source_sync_metadata; they were insufficient evidence of this Production contract. With the exact CHECK extracted from 202608210002_add_ledger_pos_sales_sync.sql, the original conversion was reproduced failing with that constraint before the fix.

Only the conversion transaction INSERT in the existing unapplied 20261119085058 migration changed: source_fingerprint = md5('owner-payable-anchor:1:settlement:' || to_jsonb(v_anchor)::text), source_synced_at = now(). This identifies the original Owner evidence and its registration time; it does not assert supplier verification. Existing source_snapshot, sourceUnverified=true, supplierStatementAvailable=false and unresolvedPaymentDifference=366112 are unchanged. No new migration file. The applied 20261119071107 migration remains byte-identical.

Impact validation: all 7 settlement DB cases rerun with the exact CHECK plus 1 new metadata/default/manual-row/retry preservation case: 8 PASS. New case rejects NULL fingerprint, NULL registration time, and metadata on manual payment 5097. Duplicate conversion leaves both stored fields unchanged. The existing original-row protection, 334048 conversion, aggregate/selectable 4982000, full-payment zero, partial payment, one outflow, no cost/inventory effect, historical months and other-party checks all PASS under the CHECK. The unaffected 83 prior regression results and UI/TypeScript evidence are reused, not rerun. ESLint of the two changed test files and diff whitespace check PASS. Evidence: .local/coca-source-metadata-20261119/{before-fix.log,after-fix.log}.

Changed absolute paths for this correction:
- C:\workspace\baba-staff-app\supabase\migrations\20261119085058_coca_owner_balance_payable_settlement.sql
- C:\workspace\baba-staff-app\tests\helpers\coca-owner-balance-fixture.mjs
- C:\workspace\baba-staff-app\tests\coca-owner-payable-settlement-db.test.mjs
- C:\workspace\baba-staff-app\docs\reports\20261119-coca-owner-payable-settlement.md

No UI, payment API, existing payment RPC or other-party app logic was changed. Production migration, repair and conversion were NOT executed. The separate approved activation and Postflight sequence above still applies; use the corrected commit and hash, never the initial file revision.
