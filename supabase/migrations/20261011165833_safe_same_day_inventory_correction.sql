-- LOCAL REVIEW ONLY. No backfill and no replay of already repaired purchases.
begin;

-- Only the trusted inventory mutation path can request this operation. It does
-- not grant staff access to any administrator repair RPC or private function.
create function public.inventory_apply_purchase_correction_v3(
  p_item_id bigint,p_purchase_log_id bigint,p_expected_quantity numeric,p_expected_item jsonb,
  p_payload jsonb,p_business_date date,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_saved jsonb; v_projection jsonb; v_check jsonb; v_log_id bigint; v_audit_id bigint;
  v_root public.inventory_logs%rowtype; v_confirmation text;
begin
  -- Reserve the full source/month set before inventory, transaction or payable locks.
  perform inventory_ledger_private.lock_sources(array['inventory-log:' || p_purchase_log_id],array[p_business_date]);
  perform 1 from public.ledger_payables where expense_transaction_id in (
    select resolved_transaction_id from public.ledger_candidates where source_type='inventory_purchase_log'
      and source_key='inventory-log:' || p_purchase_log_id
  ) order by id for update;
  v_saved:=public.inventory_apply_purchase_correction_v2(
    p_item_id,p_purchase_log_id,p_expected_quantity,p_expected_item,p_payload,p_business_date,p_actor_user_id);
  if v_saved->>'status' is distinct from 'ok' then return v_saved; end if;
  v_log_id:=(v_saved->>'inventoryLogId')::bigint;
  -- First collect the existing review status. No economic confirmation is set.
  v_confirmation:=current_setting('baba.purchase_confirmation',true);
  perform set_config('baba.purchase_confirmation','',true);
  v_projection:=public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id);
  if v_projection->>'status'='failed' then raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED'; end if;
  select * into v_root from public.inventory_logs where id=p_purchase_log_id;
  if v_projection->>'status'='review_required' then
    v_check:=inventory_ledger_private.inspect_purchase_repair(v_log_id,p_purchase_log_id);
    -- The date is resolved by the server, never accepted from an inventory request.
    -- Recheck configured store time in SQL as well; previous/future days remain review-only.
    if v_root.business_date=p_business_date
      and p_business_date=public.store_business_date_for_timestamp_v1(clock_timestamp())
      and coalesce((v_check->>'safe')::boolean,false)
      and v_check->>'code'='READY'
      and coalesce((v_check#>>'{supplierChange,requiresConfirmation}')::boolean,true)=false
      and (select count(*)=1 and min(blp.ledger_party_id)=(
        select party_id from public.ledger_transactions where id=(v_check->>'transactionId')::bigint)
        from public.inventory_logs l join public.business_partners bp on bp.is_active and (
          (l.purchase_supplier_partner_id is not null and bp.id=l.purchase_supplier_partner_id)
          or (l.purchase_supplier_partner_id is null and (lower(btrim(bp.name))=lower(btrim(l.new_supplier))
            or exists(select 1 from public.business_partner_supplier_aliases a where a.business_partner_id=bp.id
              and a.status='linked' and a.normalized_name=lower(btrim(l.new_supplier))))))
        join public.business_partner_ledger_parties blp on blp.business_partner_id=bp.id
        where l.id=v_log_id) then
      perform set_config('baba.purchase_confirmation',v_log_id::text,true);
      v_projection:=public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id);
      perform set_config('baba.purchase_confirmation',coalesce(v_confirmation,''),true);
      -- The projector catches its internal errors; promote every non-success so
      -- PostgreSQL rolls back inventory, price history, payable, rebook and audits.
      if v_projection->>'status' is distinct from 'synced'
        or v_projection->>'code' is distinct from 'REBOOKED' then
        raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED';
      end if;
      -- A suppressed required write must not masquerade as a successful rebook.
      if v_projection->>'code'='REBOOKED' and (
        not exists(select 1 from public.ledger_transactions where correction_of_id=(v_check->>'transactionId')::bigint
          and source_type='inventory_purchase_reversal' and economic_effect_sign=-1 and amount=(v_check->>'oldAmount')::numeric)
        or not exists(select 1 from public.ledger_payables where expense_transaction_id=(v_check->>'transactionId')::bigint and status='cancelled')
        or not exists(select 1 from public.ledger_audit_logs where action='inventory_source_rebooked'
          and after_snapshot->>'originalTransactionId'=v_check->>'transactionId')
        or not exists(select 1 from public.ledger_candidates c where c.source_type='inventory_purchase_log'
          and c.source_key='inventory-log:' || p_purchase_log_id
          and (c.source_snapshot->>'purchase_amount')::numeric=(v_check->>'newAmount')::numeric
          and ((c.status='dismissed' and c.dismissal_reason='Inventory purchase fully cancelled' and (v_check->>'newAmount')::numeric=0)
            or (c.status='confirmed' and exists(select 1 from public.ledger_transactions t join public.ledger_payables p on p.expense_transaction_id=t.id
              where t.id=c.resolved_transaction_id and t.status='confirmed' and t.amount=(v_check->>'newAmount')::numeric
                and p.status='unpaid' and p.original_amount=t.amount and p.party_id=t.party_id))))
      ) then raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED'; end if;
      insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
        values(p_actor_user_id,'inventory_purchase_auto_corrected','inventory_log',v_log_id,
          jsonb_build_object('preview',v_check),jsonb_build_object('purchaseLogId',p_purchase_log_id,
            'projection',v_projection,'confirmedSource',(select to_jsonb(l) from public.inventory_logs l where id=v_log_id)),
          'Safe same-day unpaid inventory purchase correction') returning id into v_audit_id;
      if v_audit_id is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;
    end if;
  end if;
  perform set_config('baba.purchase_confirmation',coalesce(v_confirmation,''),true);
  return v_saved || jsonb_build_object('ledgerSync',v_projection);
end;
$$;
alter function public.inventory_apply_purchase_correction_v3(bigint,bigint,numeric,jsonb,jsonb,date,bigint) owner to postgres;
revoke all on function public.inventory_apply_purchase_correction_v3(bigint,bigint,numeric,jsonb,jsonb,date,bigint) from public,anon,authenticated,service_role;
grant execute on function public.inventory_apply_purchase_correction_v3(bigint,bigint,numeric,jsonb,jsonb,date,bigint) to service_role;
commit;
