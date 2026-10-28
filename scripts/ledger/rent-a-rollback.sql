-- Rent integration (A plan) — rollback. RUN ONLY WITH EXPLICIT APPROVAL, one section at a time.
-- Audit log rows are never deleted. Ledger transactions, movements, closures and v1
-- reserve functions are never touched by any section.

-- 1. Undo the data seed (scripts/ledger/rent-a-seed.sql). Removes only the rent contract
--    and payment rows; the linked ledger transaction #1304 stays as it is.
begin;
set local lock_timeout = '5s';
delete from public.ledger_rent_contract_payments;
delete from public.ledger_rent_contracts;
commit;

-- 2. Uninstall 20261028140100_reserve_allocation_kinds_v2.sql.
--    Refuses if any v2 entry exists: dropping the columns would erase what kind of
--    allocation it was. In that case keep the migration and fix forward instead.
--    Before running, deploy an app build that calls the v1 reserve RPCs again.
begin;
set local lock_timeout = '5s';
do $$
begin
  if exists (select 1 from public.ledger_reserve_entries
    where allocation_kind is not null or restores_entry_id is not null
      or attribution_month is not null or request_key is not null) then
    raise exception 'RESERVE_V2_ROWS_EXIST: rollback refused';
  end if;
end
$$;
drop function public.ledger_confirm_reserve_schedule_v2(bigint, bigint);
drop function public.ledger_generate_reserve_schedule_v2(date, boolean, bigint);
drop function public.ledger_create_reserve_entry_v2(bigint, text, numeric, bigint, text, uuid, bigint);
drop function public.ledger_reserve_insert_entry_v2(bigint, text, text, numeric, bigint, text, uuid, bigint);
drop index public.ledger_reserve_entries_restores_idx;
drop index public.ledger_reserve_entries_request_key_unique;
alter table public.ledger_reserve_entries
  drop constraint ledger_reserve_entries_kind_shape,
  drop constraint ledger_reserve_entries_attribution_month_check,
  drop constraint ledger_reserve_entries_allocation_kind_check,
  drop column request_key,
  drop column attribution_month,
  drop column restores_entry_id,
  drop column allocation_kind;
commit;

-- 3. Uninstall 20261028140000_add_rent_contracts.sql (after section 1).
begin;
set local lock_timeout = '5s';
drop function public.ledger_record_pre_ledger_rent_payment_v1(bigint, text, date, numeric, bigint, text, bigint);
drop function public.ledger_link_rent_payment_v1(bigint, bigint, bigint, text, bigint);
drop function public.ledger_save_rent_contract_v1(bigint, jsonb, bigint);
drop function public.ledger_rent_ledger_start_v1();
drop function public.ledger_rent_actor_can_write_v1(bigint);
drop table public.ledger_rent_contract_payments;
drop table public.ledger_rent_contracts;
commit;
