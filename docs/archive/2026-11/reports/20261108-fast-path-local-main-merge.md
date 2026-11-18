# FAST PATH local Main merge — 2026-11-08

- Base Main: `36abbdfeea4e95edce6535bc5c61608f012d2f66`.
- Source: `2f7dab11ace904ca972dc93778144af03820cfe4` (`codex/july-ledger-batch-restore-20261107`).
- Merge method: two-parent `--no-ff`; automatic merge without conflicts. Main's latest Entries page and stylesheet are unchanged. Earlier branch history is retained for the shared restore helpers and audit reports; no historical SQL was executed.
- Scope: Registry/Claim migration, historical cash UI/API, monthly opening boundaries, cash/profit calculations, related tools and tests. Worktree `.local` inputs and the pending production batch stay outside Git.

## Production state supplied by owner

Migration `20261107150007 / ledger_historical_cash_import_v1` is already applied in production. Its Git file is preserved byte-for-byte (SHA-256 `c6d47342c79835d45304e3b2b8a69a582e1aad4690d4b93cec21ec312083fe75`). Do not reapply it or repair its history. This supersedes the implementation report's historical statement that structure approval/application was pending.

The 241-row production data batch still awaits separate owner approval. No database connections, migrations, data SQL, Push or deployment were performed during this merge.

## Verification

- Integrated affected tests: 5/5 PASS (cash API/status, monthly boundaries, historical cash classification, July impact across ledger API scopes and August–November balances).
- Full TypeScript: `node node_modules/typescript/bin/tsc --noEmit --incremental false` PASS.
- Production Build: single `npm.cmd run build` invocation PASS (Next.js 16.2.1, compilation, built-in TypeScript and 73/73 static pages completed).
- Existing isolated verification: reuse the implementation report's 24 PASS and 124/124 daily account targets, including the 241-row fixture; not rerun.
- Tests and build use explicit nonproduction Supabase placeholders; no production credentials are supplied to tests. The build artifact is for local validation, not deployment.
- Migration file hash, unchanged Main Entries UI, clean merge index and whitespace checks verified.

The merge commit and its parents identify the final integrated revision. Push and deployment remain owner actions.
