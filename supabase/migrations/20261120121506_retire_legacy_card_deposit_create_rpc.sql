-- Retire the legacy card-deposit creator ledger_create_card_deposit_v1 (202608210006, last replaced by
-- 20260915095952). NOT APPLIED: production application is reviewed by GPT and needs separate Owner approval.
-- Apply only after 20261120121505_restore_november_card_deposit_allocations.
--
-- Why: it registers a deposit (card_clearing -> bank) without any sale allocation ('unmatched'). Every such
-- deposit blocks later FIFO deposits and the card fee settlement (legacy_unallocated_deposits). The admin app
-- has only called ledger_create_card_deposit_auto_allocate_v1 since 2026-09-27; Production (2026-11-20,
-- read-only) shows no database function referencing it and EXECUTE only for postgres/service_role, so the
-- remaining callers were direct service_role calls (#76-#87).
--
-- Kept on purpose: ledger_create_card_deposit_auto_allocate_v1 (the only deposit path),
-- ledger_cancel_card_reconciliation_v1 (cancellation of any historical status), ledger_match_card_reconciliation_v1
-- (historical correction tool for unmatched/partial rows; after this migration no new such row can be created),
-- every table, row, status value and audit record. Only the function is dropped; its source stays in the
-- migration history.
do $retire_legacy_card_deposit$
begin
  if to_regprocedure('public.ledger_create_card_deposit_v1(timestamptz,numeric,bigint,text,text,bigint)') is null then
    raise exception 'LEGACY_CARD_DEPOSIT_RPC_MISSING';
  end if;
  -- No other function may still call it.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and p.proname <> 'ledger_create_card_deposit_v1'
      and p.prosrc ilike '%ledger_create_card_deposit_v1%'
  ) then
    raise exception 'LEGACY_CARD_DEPOSIT_RPC_DEPENDENCY';
  end if;
  -- The November restoration must have run first: no unresolved legacy deposit may remain.
  if exists (select 1 from public.ledger_card_reconciliations where status in ('unmatched', 'partial')) then
    raise exception 'LEGACY_CARD_DEPOSIT_UNRESOLVED';
  end if;
end;
$retire_legacy_card_deposit$;

drop function public.ledger_create_card_deposit_v1(timestamptz, numeric, bigint, text, text, bigint);
