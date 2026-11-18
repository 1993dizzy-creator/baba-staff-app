-- P0-B (Owner decision 2026-11-18): a delayed POS deduction must not consume stock
-- that arrived through a non-POS increase entered for a LATER business date than
-- the sale. Example: Q3 receipt #8382 (sold 2026-10-20 while stock was short)
-- auto-deducted the bottle purchased on 2026-11-15.
--
-- Scope and contract:
--   * Only the existing BEFORE INSERT guard on public.inventory_logs is replaced.
--     Its OID, owner, ACL and trigger binding are preserved (CREATE OR REPLACE).
--   * The P0 stock-check boundary is kept unchanged and is evaluated first.
--   * The new boundary raises the same SQLSTATE P0S01 that every stock engine
--     (apply / reprocess / rollback / P1 reprocess) already handles: the whole RPC
--     movement rolls back and the receipt is parked for administrator review.
--     No engine body changes, so the inventory-writer RPC contracts stay valid.
--   * Only deductions (negative movement) are checked. Reversals/restorations are
--     not affected. A same-business-date late purchase entry, or a purchase
--     backdated to on/before the sale business date, still allows auto deduction.
--   * A deduction is held only when it would dip into that later-date stock:
--     new_quantity < sum(later-date non-POS increases logged after the sale).
--   * No inventory quantity, log, deduction or receipt row is modified.
begin;

do $preflight$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.inventory_logs'::regclass
      and tgname = 'inventory_logs_pos_stock_check_boundary'
      and not tgisinternal and tgenabled = 'O'
  ) then
    raise exception 'P0 stock-check boundary trigger is missing or disabled';
  end if;
end;
$preflight$;

create or replace function public.guard_pos_inventory_stock_check_boundary()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $guard$
declare
  v_sale_at timestamptz;
  v_sale_business_date date;
  v_later_restock numeric;
begin
  if new.reason = 'stock_check' then
    -- Serialize count publication with every POS movement on the same item.
    perform id from public.inventory where id = new.item_id for update;
    return new;
  end if;
  if new.source is distinct from 'pos_sales' then return new; end if;

  perform id from public.inventory where id = new.item_id for update;
  select ref_date, business_date into v_sale_at, v_sale_business_date
  from public.pos_sales_receipts
  where id = new.related_receipt_id;

  -- P0: stronger snapshot isolation can hide a newly committed count. Fail closed.
  if current_setting('transaction_isolation') not in ('read committed', 'read uncommitted')
    or v_sale_at is null
    or exists (
      select 1 from public.inventory_logs counted
      where counted.item_id = new.item_id and counted.reason = 'stock_check'
        and (counted.created_at is null or counted.created_at >= v_sale_at)
    ) then
    raise exception using errcode = 'P0S01',
      message = 'POS_STOCK_CHECK_REVIEW_REQUIRED',
      detail = jsonb_build_object('receiptId', new.related_receipt_id,
        'itemId', new.item_id, 'saleAt', v_sale_at)::text;
  end if;

  -- P0-B: delayed deduction must not consume a later-business-date restock.
  if coalesce(new.change_quantity, new.new_quantity - new.prev_quantity) < 0 then
    select coalesce(sum(coalesce(restock.change_quantity,
             restock.new_quantity - restock.prev_quantity)), 0)
      into v_later_restock
    from public.inventory_logs restock
    where restock.item_id = new.item_id
      and restock.source is distinct from 'pos_sales'
      and coalesce(restock.change_quantity,
            restock.new_quantity - restock.prev_quantity) > 0
      and (restock.created_at is null or restock.created_at >= v_sale_at)
      -- Legacy rows (2026-04..05) lack business_date; derive it from created_at
      -- with the BABA rule (Asia/Ho_Chi_Minh, 03:00 cutoff; equal to the
      -- store_business_date_v1 defaults). Only a row with neither value stays
      -- conservatively counted as a later restock.
      and coalesce(restock.business_date,
            ((restock.created_at at time zone 'Asia/Ho_Chi_Minh')
              - interval '3 hours')::date,
            'infinity'::date) > v_sale_business_date;

    if v_later_restock > 0 and new.new_quantity < v_later_restock then
      raise exception using errcode = 'P0S01',
        message = 'POS_STOCK_CHECK_REVIEW_REQUIRED',
        detail = jsonb_build_object('receiptId', new.related_receipt_id,
          'itemId', new.item_id, 'saleAt', v_sale_at,
          'boundary', 'restock_after_sale',
          'laterRestockQuantity', v_later_restock,
          'newQuantity', new.new_quantity)::text;
    end if;
  end if;
  return new;
end;
$guard$;

revoke all on function public.guard_pos_inventory_stock_check_boundary()
  from public, anon, authenticated;

comment on function public.guard_pos_inventory_stock_check_boundary() is
  'P0 stock-check boundary + P0-B later-business-date restock boundary for POS deductions (20261118075543).';

commit;
