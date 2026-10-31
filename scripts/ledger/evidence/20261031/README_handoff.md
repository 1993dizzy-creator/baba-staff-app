# BABA · October 2026 employee meal consolidation evidence

**Snapshot:** 2026-10-31 local Vietnam (Asia/Ho_Chi_Minh). Source is LIVE read-only queries from this ChatGPT session connecting to BABA Supabase project and Google Sheet. This is **not** a completed migration or approval for operational DB writes.

## Why this file exists

The user's LOCAL Codex session reported no Supabase MCP connection. ChatGPT obtained the evidence directly and packages it here for Codex to consume without requiring remote MCP in the agent. The agent should read these files from an ordinary downloaded path on the local Windows PC; it cannot access ChatGPT's `/mnt/data` automatically. Do not claim the agent itself queried live Supabase.

## Operating evidence

- Supabase project ID: `yfjqwsdqhvnfqxywsqcz` (identifier only; no token, URL credentials or secrets).
- Native Sheet title: `(2026)BABA - Sổ dự án`; spreadsheet ID `1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4`; tab `10월` (sheet ID `1631724291`).
- Data range: Sheets `A3:K472`, rendered `UNFORMATTED_VALUE`; relevant date col B (spreadsheet serial), G cash, H Vượng, I Cho, K corporate.
- APP baseline is ledger movements joined to **confirmed** `public.ledger_transactions`, grouped by `business_date` and `fund_account_id` 1, 2, 3, 5.
- **October 1–27**: 27 days × 4 accounts = **108/108 matches; 0 mismatches**. This is an **account-level daily net change** reconciliation only, not individual receipt, expense, cost and debt exhaustion. All 108 pairs and their amounts are in `app_vs_sheet_daily_120_cells.csv` and can be rechecked from `preflight_108_recheck_READONLY.sql`.
- **October 28–30 are outside that passed baseline.** 12 pairs; 2 pass, 10 mismatch. Do NOT claim 120/120. These dates were not corrected. A 30,000₫ employee meal gap on each date (90,000₫ total) is among their outstanding research topics, but the account differences cannot all be assigned to meals.
- October 1–30 confirmed *automatic* employee meal transactions: **30** (category 6).
- Confirmed *manual extra* employee meal transactions: **20**, total **630,000₫**, each has precisely one confirmed auto meal on the same business date. 19 ×30,000₫ + 1 ×60,000₫ (Oct 24). All 20 pass current `ledger_manual_transaction_blocker_v1` read-only check and each has exactly one negative movement on fund_account_id=1. Actual status and blockers are snapshot only; recheck under locks on implementation day.
- One additional confirmed October 1 meal correction, `TX#2163` (30,000₫), is **linked to Sep 29 auto meal TX#2112**, with `recognition_month='2026-09-01'`, and **September is closed**. EXCLUDE it from the October 20-manual consolidation; protect cross-month profitability, history and funds. A cancelled Oct 1 manual test TX#3385 also exists and is not an active manual target.
- Four source drift candidate dates were observed: 2026-10-13, 15, 20, 24. Preserve and handle source revision and `mealSourceDriftReviewedFingerprint` semantics, especially 15 and 24 where source amounts differ.

## Current code implications (from GitHub main as of this analysis)

- `public.ledger_adjust_open_meal_transaction_v1` exists. It creates a separate `ledger_correction` transaction and a corresponding `ledger_movements` row, using **execution-date business day** instead of the original meal's day. This would break the past daily cash baseline if used blindly on Oct 2–27 now.
- Existing `lib/ledger/entries.ts::buildLedgerEntries` consolidates **linked** meal corrections (`correction_of_id`) into the single original auto-meal display row; it does not automatically consolidate unrelated manual expenses.
- Existing admin ledger meal edit UI and POST `app/api/admin/ledger/transactions/[id]/meal-adjust/route.ts` already exist. Aim for targeted improvement and no new full-feature meal module.

## Safeguards for the implementing agent

- First modify and isolate-test RPC date attribution and display/memo semantics, preserving original attendance candidate and source snapshot. For historical 20-day consolidation, old manual cash effects must be removed by an audited cancel, and replacement linked correction cash effects must land on the **same original business date** and equal amounts; only then can 108/108 stay unchanged. No speculative offset in current-day cash, no raw mutation of closed September 2026, no deletion of historic rows/audit.
- The user has not approved production writes or new migrations in this message. **Codex local changes/tests and commits follow AGENTS.md; Push/deploy/production SQL require separate approval.**
- SQL in this archive is **READ ONLY**. Run manually in Supabase SQL Editor if a new fresh preflight is desired. After deployment and any separately approved October data change, re-run 108 comparisons and per-day financial tests.

## Files

- `confirmed_manual_meals_20.csv` — ID/date/original auto ID/amount/Sheet row, explicit 20.
- `app_vs_sheet_daily_120_cells.csv` — 108 verified pairs + 12 unverified Oct 28–30 pairs and differences.
- `preflight_manual_meal_20_READONLY.sql` — checks live IDs, date correspondence, cancellation eligibility, cash movements, September exception.
- `preflight_108_recheck_READONLY.sql` — self-contained 108-pair SQL recheck using the stored Sheet daily snapshot; no Sheets MCP needed for the SQL itself.
- `manifest.json` — SHA256 hashes of these evidence files.
